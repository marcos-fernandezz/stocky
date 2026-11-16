"""Shelf stock domain: counts, sales, thresholds and alerts (spec-00)."""
import math
import statistics
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta

SEGURIDAD = 1                 # safety units in the threshold formula
RESPUESTA_DEFAULT_H = 0.5     # response time until there is history
CONTEO_VENCE_H = 24           # a count older than this asks for a recount
ALTA_ROTACION_UH = 1.0        # units/hour from which silence-detection (R3) applies
P_SILENCIO = 0.05             # R3 fires when P(no sales in the elapsed time) < this
SEMANAS_HISTORIA = 4

PRIORIDADES = ["URGENTE", "ALTA", "MEDIA", "BAJA"]
TIPOS_CONTEO = {"REPOSICION", "VERIFICACION", "INICIAL"}
CIERRA_AL_CONTAR = ("REPONER", "VERIFICAR", "RECONTAR")


class DomainError(Exception):
    status = 422


class ConflictError(DomainError):
    status = 409


class NotFoundError(DomainError):
    status = 404


def iso(dt):
    return dt.isoformat(timespec="seconds")


def parse_dt(value, campo):
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        raise DomainError(f"{campo}: fecha ISO 8601 inválida")
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt.replace(microsecond=0)


def _int(value, campo, minimo):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimo:
        raise DomainError(f"{campo}: debe ser un entero ≥ {minimo}")
    return value


def _str(value, campo):
    if not isinstance(value, str) or not value.strip():
        raise DomainError(f"{campo}: requerido")
    return value.strip()


class Stock:
    def __init__(self, conn):
        self.conn = conn
        # ponytail: one lock for the shared connection (reads and writes);
        # a connection per thread + WAL if read concurrency ever matters.
        self.lock = threading.Lock()

    @contextmanager
    def tx(self):
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            self.conn.execute("COMMIT")

    def q(self, sql, *args):
        return self.conn.execute(sql, args).fetchall()

    def q1(self, sql, *args):
        return self.conn.execute(sql, args).fetchone()

    # ---------- derived figures (F4) ----------

    def _vendido_desde(self, s, p, desde):
        """Units of non-voided sales emitted at or after `desde` (ISO string).
        Same-second sales count as after the count: the shelf is underestimated, never overestimated."""
        return self.q1(
            """SELECT COALESCE(SUM(l.cantidad), 0) FROM venta_linea l
               JOIN venta v USING (comprobante_id)
               WHERE v.tipo = 'VENTA' AND v.anulada_por IS NULL
                 AND v.sucursal_id = ? AND l.producto_id = ? AND v.emitido_at >= ?""",
            s, p, desde)[0]

    def _ventas_entre(self, s, p, desde, hasta):
        return self.q1(
            """SELECT COALESCE(SUM(l.cantidad), 0) FROM venta_linea l
               JOIN venta v USING (comprobante_id)
               WHERE v.tipo = 'VENTA' AND v.anulada_por IS NULL
                 AND v.sucursal_id = ? AND l.producto_id = ?
                 AND v.emitido_at >= ? AND v.emitido_at < ?""",
            s, p, iso(desde), iso(hasta))[0]

    def venta_hora_franja(self, s, p, now):
        """Average units/hour for this weekday+hour over the last 4 weeks,
        skipping hours where the shelf was empty (censored demand). None = no history."""
        hoy = now.replace(hour=0, minute=0, second=0)
        if not self._ventas_entre(s, p, hoy - timedelta(weeks=SEMANAS_HISTORIA), hoy):
            return None  # today's sales are not history yet
        hora = now.replace(minute=0, second=0)
        muestras = []
        for k in range(1, SEMANAS_HISTORIA + 1):
            ini = hora - timedelta(weeks=k)
            fin = ini + timedelta(hours=1)
            vacio = self.q1(
                """SELECT 1 FROM vacio_periodo WHERE sucursal_id = ? AND producto_id = ?
                   AND desde < ? AND (hasta IS NULL OR hasta > ?)""",
                s, p, iso(fin), iso(ini))
            if not vacio:
                muestras.append(self._ventas_entre(s, p, ini, fin))
        return statistics.fmean(muestras) if muestras else None

    def tiempo_respuesta_h(self, s, now):
        rows = self.q(
            """SELECT creada_at, atendida_at FROM alerta
               WHERE sucursal_id = ? AND tipo = 'REPONER' AND estado = 'ATENDIDA'
                 AND atendida_por IS NOT NULL AND atendida_at >= ?""",
            s, iso(now - timedelta(days=7)))
        if not rows:
            return RESPUESTA_DEFAULT_H
        return statistics.median(
            (datetime.fromisoformat(r["atendida_at"]) - datetime.fromisoformat(r["creada_at"])).total_seconds() / 3600
            for r in rows)

    @staticmethod
    def umbral(item, venta_hora, respuesta_h):
        minimo = item["minimo_exhibicion"]
        if venta_hora is None:
            cap = item["capacidad"]
            return max(minimo, math.ceil(cap * 0.25)) if cap else minimo
        horas = respuesta_h + item["tiempo_reposicion_min"] / 60
        # round() before ceil() avoids 2.0000000001 -> 3 from float noise.
        return max(minimo, math.ceil(round(venta_hora * horas + SEGURIDAD, 6)))

    def snapshot(self, s, p, now):
        item = self.q1(
            """SELECT g.*, COALESCE(pr.nombre, g.producto_id) AS nombre, COALESCE(pr.precio, 0) AS precio,
                      sg.unidades AS stock_general
               FROM gondola_item g
               LEFT JOIN producto pr ON pr.id = g.producto_id
               LEFT JOIN stock_general sg ON sg.sucursal_id = g.sucursal_id AND sg.producto_id = g.producto_id
               WHERE g.sucursal_id = ? AND g.producto_id = ?""", s, p)
        if item is None:
            raise NotFoundError(f"producto {p} no está en la góndola de {s}")
        contado = item["conteo_at"] is not None
        informado = item["conteo_informado"] or 0
        vendido = self._vendido_desde(s, p, item["conteo_at"]) if contado else 0
        stock = max(0, informado - vendido)
        dia = now.replace(hour=0, minute=0, second=0)
        vendido_hoy = self._ventas_entre(s, p, dia, now + timedelta(seconds=1))
        deposito = max(0, (item["stock_general"] or 0) - vendido_hoy - stock)
        vh = self.venta_hora_franja(s, p, now)
        umbral = self.umbral(item, vh, self.tiempo_respuesta_h(s, now))
        cap = item["capacidad"]
        ultima = self.q1(
            """SELECT MAX(v.emitido_at) FROM venta v JOIN venta_linea l USING (comprobante_id)
               WHERE v.tipo = 'VENTA' AND v.anulada_por IS NULL AND v.sucursal_id = ? AND l.producto_id = ?""",
            s, p)[0]

        if not contado:
            estado = "SIN_CONTEO"
        elif stock == 0:
            estado = "VACIO"
        elif stock <= umbral and deposito == 0:
            estado = "SIN_DEPOSITO"
        elif stock <= umbral:
            estado = "BAJO"
        else:
            estado = "OK"

        return {
            "sucursal_id": s,
            "producto_id": p,
            "nombre": item["nombre"],
            "precio": item["precio"],
            "capacidad": cap,
            "tiempo_reposicion_min": item["tiempo_reposicion_min"],
            "conteo_informado": item["conteo_informado"],
            "conteo_at": item["conteo_at"],
            "conteo_por": item["conteo_por"],
            "conteo_vencido": contado and now - datetime.fromisoformat(item["conteo_at"]) > timedelta(hours=CONTEO_VENCE_H),
            "vendido_desde_conteo": vendido,
            "stock_gondola": stock,
            "desvio": max(0, vendido - informado) if contado else 0,
            "nivel": round(stock * 100 / informado) if informado else 0,
            "stock_general": item["stock_general"],
            "vendido_hoy": vendido_hoy,
            "deposito": deposito,
            "venta_hora": round(vh, 2) if vh is not None else None,
            "umbral": umbral,
            "horas_a_vacio": round(stock / vh, 1) if vh else None,
            "a_reponer": max(0, min(cap - stock, deposito)) if cap else deposito,
            "ultima_venta_at": ultima,
            "estado": estado,
            "estado_anterior": item["estado"],
        }

    def _silencio_improbable(self, snap, now):
        """R3: a fast mover with stock on the shelf that stopped selling."""
        vh = snap["venta_hora"]
        if not vh or vh < ALTA_ROTACION_UH or snap["stock_gondola"] == 0:
            return False
        desde = max(filter(None, [snap["conteo_at"], snap["ultima_venta_at"]]))
        horas = (now - datetime.fromisoformat(desde)).total_seconds() / 3600
        # ponytail: Poisson with the current hour's rate; integrate per-hour rates if false alarms show up.
        return math.exp(-vh * horas) < P_SILENCIO

    # ---------- alerts (F5) ----------

    def _alertas_deseadas(self, snap, now):
        if snap["conteo_at"] is None:
            return {"RECONTAR": ("BAJA", "REPOSITOR", None)}
        quiere = {}
        if snap["conteo_vencido"]:
            quiere["RECONTAR"] = ("BAJA", "REPOSITOR", None)
        if snap["stock_gondola"] <= snap["umbral"]:
            if snap["deposito"] > 0:
                prio = "URGENTE" if snap["stock_gondola"] == 0 else "ALTA"
                quiere["REPONER"] = (prio, "REPOSITOR", snap["a_reponer"])
            else:
                quiere["SIN_DEPOSITO"] = ("ALTA", "ENCARGADO", None)
        if snap["desvio"] > 0 or self._silencio_improbable(snap, now):
            quiere["VERIFICAR"] = ("MEDIA", "REPOSITOR", None)
        return quiere

    def _alerta_dict(self, row, snap):
        a = dict(row)
        a["nombre"] = snap["nombre"]
        a["stock_gondola"] = snap["stock_gondola"]
        a["conteo_informado"] = snap["conteo_informado"]
        return a

    def evaluar(self, s, p, now, siempre=True):
        """Recompute state and alerts for one product. Must run inside tx()."""
        snap = self.snapshot(s, p, now)
        eventos, cambio = [], snap["estado"] != snap["estado_anterior"]
        ahora = iso(now)

        if cambio:
            self.conn.execute("UPDATE gondola_item SET estado = ? WHERE sucursal_id = ? AND producto_id = ?",
                              (snap["estado"], s, p))
            if snap["estado_anterior"] == "VACIO":
                self.conn.execute(
                    "UPDATE vacio_periodo SET hasta = ? WHERE sucursal_id = ? AND producto_id = ? AND hasta IS NULL",
                    (ahora, s, p))
            if snap["estado"] == "VACIO":
                self.conn.execute("INSERT INTO vacio_periodo (sucursal_id, producto_id, desde) VALUES (?, ?, ?)",
                                  (s, p, ahora))

        quiere = self._alertas_deseadas(snap, now)
        abiertas = {r["tipo"]: r for r in self.q(
            "SELECT * FROM alerta WHERE sucursal_id = ? AND producto_id = ? AND estado = 'ABIERTA'", s, p)}

        for tipo, row in abiertas.items():
            if tipo not in quiere:
                self.conn.execute(
                    "UPDATE alerta SET estado = 'ATENDIDA', atendida_at = ?, motivo = 'resuelta automáticamente' WHERE id = ?",
                    (ahora, row["id"]))
                eventos.append({"type": "alerta.cerrada", "data": {"id": row["id"], "tipo": tipo, "producto_id": p}})

        for tipo, (prio, dest, unidades) in quiere.items():
            row = abiertas.get(tipo)
            if row is None:
                cur = self.conn.execute(
                    """INSERT INTO alerta (sucursal_id, producto_id, tipo, prioridad, destinatario, unidades_sugeridas, creada_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""", (s, p, tipo, prio, dest, unidades, ahora))
                nueva = self.q1("SELECT * FROM alerta WHERE id = ?", cur.lastrowid)
                eventos.append({"type": "alerta.creada", "data": self._alerta_dict(nueva, snap)})
            elif PRIORIDADES.index(prio) < PRIORIDADES.index(row["prioridad"]):
                # Escalation (ALTA -> URGENTE) notifies again.
                self.conn.execute("UPDATE alerta SET prioridad = ?, unidades_sugeridas = ? WHERE id = ?",
                                  (prio, unidades, row["id"]))
                esc = self.q1("SELECT * FROM alerta WHERE id = ?", row["id"])
                eventos.append({"type": "alerta.creada", "data": {**self._alerta_dict(esc, snap), "escalada": True}})
            elif row["unidades_sugeridas"] != unidades or row["prioridad"] != prio:
                self.conn.execute("UPDATE alerta SET prioridad = ?, unidades_sugeridas = ? WHERE id = ?",
                                  (prio, unidades, row["id"]))

        if siempre or cambio or eventos:
            snap["estado_anterior"] = snap["estado"]
            eventos.insert(0, {"type": "producto.actualizado", "data": snap})
        for e in eventos:
            e["sucursal_id"] = s
        return eventos

    # ---------- commands ----------

    def registrar_conteo(self, s, body, now):
        """RF-01."""
        p = _str(body.get("producto_id"), "producto_id")
        repositor = _str(body.get("repositor_id"), "repositor_id")
        unidades = _int(body.get("unidades"), "unidades", 0)
        tipo = body.get("tipo", "REPOSICION")
        if tipo not in TIPOS_CONTEO:
            raise DomainError(f"tipo: debe ser uno de {sorted(TIPOS_CONTEO)}")
        # created_at from the device keeps offline counts in order (RNF-04).
        at = parse_dt(body["created_at"], "created_at") if body.get("created_at") else now
        at = min(at, now)

        with self.tx():
            item = self.q1("SELECT * FROM gondola_item WHERE sucursal_id = ? AND producto_id = ?", s, p)
            if item is None:
                self._alta(s, p)
                item = self.q1("SELECT * FROM gondola_item WHERE sucursal_id = ? AND producto_id = ?", s, p)
            cap = item["capacidad"]
            if cap and unidades > cap and not body.get("confirmar_capacidad"):
                raise ConflictError(f"¿Superás la capacidad de {cap}? Confirmá el conteo.")

            esperado = self.snapshot(s, p, at)["stock_gondola"] if item["conteo_at"] else None
            self.conn.execute(
                """INSERT INTO conteo (sucursal_id, producto_id, repositor_id, unidades, esperado, diferencia, tipo, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (s, p, repositor, unidades, esperado, None if esperado is None else unidades - esperado, tipo, iso(at)))

            eventos = []
            if item["conteo_at"] and iso(at) <= item["conteo_at"]:
                # An older offline count arriving late: keep it as history only.
                return {"aplicado": False, "esperado": esperado}, eventos

            self.conn.execute(
                """UPDATE gondola_item SET conteo_informado = ?, conteo_at = ?, conteo_por = ?,
                          capacidad = COALESCE(capacidad, NULLIF(?, 0))
                   WHERE sucursal_id = ? AND producto_id = ?""",
                (unidades, iso(at), repositor, unidades, s, p))
            for row in self.q(
                    f"""SELECT id, tipo FROM alerta WHERE sucursal_id = ? AND producto_id = ? AND estado = 'ABIERTA'
                        AND tipo IN ({','.join('?' * len(CIERRA_AL_CONTAR))})""", s, p, *CIERRA_AL_CONTAR):
                self.conn.execute(
                    "UPDATE alerta SET estado = 'ATENDIDA', atendida_at = ?, atendida_por = ? WHERE id = ?",
                    (iso(now), repositor, row["id"]))
                eventos.append({"type": "alerta.cerrada", "sucursal_id": s,
                                "data": {"id": row["id"], "tipo": row["tipo"], "producto_id": p}})
            eventos += self.evaluar(s, p, now)
        diferencia = None if esperado is None else unidades - esperado
        return {"aplicado": True, "esperado": esperado, "diferencia": diferencia,
                "producto": eventos_producto(eventos)}, eventos

    def _alta(self, s, p):
        self.conn.execute("INSERT OR IGNORE INTO gondola_item (sucursal_id, producto_id) VALUES (?, ?)", (s, p))

    def _insert_linea(self, comprobante_id, linea):
        self.conn.execute(
            "INSERT INTO venta_linea (comprobante_id, linea, producto_id, cantidad) VALUES (?, ?, ?, ?)",
            (comprobante_id, linea["linea"], linea["producto_id"], linea["cantidad"]))

    def registrar_venta(self, body, now):
        """RF-02. Returns (http_status, result, events)."""
        cid = _str(body.get("comprobante_id"), "comprobante_id")
        s = _str(body.get("sucursal_id"), "sucursal_id")
        tipo = body.get("tipo", "VENTA")
        emitido = iso(parse_dt(body.get("emitido_at"), "emitido_at"))
        lineas = []
        if tipo == "VENTA":
            crudas = body.get("lineas")
            if not isinstance(crudas, list) or not crudas:
                raise DomainError("lineas: una VENTA necesita al menos una línea")
            for i, l in enumerate(crudas, 1):
                if not isinstance(l, dict):
                    raise DomainError(f"lineas[{i}]: objeto inválido")
                lineas.append({"linea": _int(l.get("linea", i), f"lineas[{i}].linea", 1),
                               "producto_id": _str(l.get("producto_id"), f"lineas[{i}].producto_id"),
                               "cantidad": _int(l.get("cantidad"), f"lineas[{i}].cantidad", 1)})
            if len({l["linea"] for l in lineas}) != len(lineas):
                raise DomainError("lineas: número de línea repetido")
        elif tipo == "ANULACION":
            ref = _str(body.get("comprobante_ref"), "comprobante_ref")
        else:
            raise DomainError("tipo: VENTA o ANULACION")

        with self.tx():
            # Checked inside the lock so two concurrent retries of one receipt apply once.
            previa = self.q1("SELECT * FROM venta WHERE comprobante_id = ?", cid)
            if previa is not None:
                return 200, {"duplicado": True, "venta": dict(previa)}, []
            self.conn.execute(
                """INSERT INTO venta (comprobante_id, sucursal_id, tipo, comprobante_ref, emitido_at, procesada_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (cid, s, tipo, body.get("comprobante_ref") if tipo == "ANULACION" else None, emitido, iso(now)))
            if tipo == "VENTA":
                for l in lineas:
                    self._insert_linea(cid, l)
                productos = {l["producto_id"] for l in lineas}
            else:
                original = self.q1("SELECT * FROM venta WHERE comprobante_id = ? AND tipo = 'VENTA'", ref)
                if original is None or original["sucursal_id"] != s:
                    raise DomainError(f"comprobante_ref: la venta {ref} no existe en {s}")
                if original["anulada_por"]:
                    raise DomainError(f"comprobante_ref: la venta {ref} ya fue anulada")
                self.conn.execute("UPDATE venta SET anulada_por = ? WHERE comprobante_id = ?", (cid, ref))
                productos = {r[0] for r in self.q("SELECT producto_id FROM venta_linea WHERE comprobante_id = ?", ref)}
            eventos = []
            for p in sorted(productos):
                self._alta(s, p)  # unknown product: registered as "sin conteo"
                eventos += self.evaluar(s, p, now)
        return 201, {"duplicado": False, "comprobante_id": cid, "productos": eventos_producto(eventos)}, eventos

    def descartar_alerta(self, alerta_id, body, now):
        motivo = _str(body.get("motivo"), "motivo")
        por = body.get("por")
        with self.tx():
            row = self.q1("SELECT * FROM alerta WHERE id = ?", alerta_id)
            if row is None:
                raise NotFoundError("alerta inexistente")
            if row["estado"] != "ABIERTA":
                raise ConflictError("la alerta ya está cerrada")
            self.conn.execute(
                "UPDATE alerta SET estado = 'DESCARTADA', atendida_at = ?, atendida_por = ?, motivo = ? WHERE id = ?",
                (iso(now), por, motivo, alerta_id))
        return {"id": alerta_id, "estado": "DESCARTADA"}, [
            {"type": "alerta.cerrada", "sucursal_id": row["sucursal_id"],
             "data": {"id": alerta_id, "tipo": row["tipo"], "producto_id": row["producto_id"]}}]

    def tick(self, now):
        """Periodic re-evaluation: hour-slot thresholds, stale counts and silence (R3)."""
        eventos = []
        with self.tx():
            for r in self.q("SELECT sucursal_id, producto_id FROM gondola_item"):
                eventos += self.evaluar(r[0], r[1], now, siempre=False)
        return eventos

    # ---------- queries ----------

    def productos(self, s, now):
        ids = [r[0] for r in self.q("SELECT producto_id FROM gondola_item WHERE sucursal_id = ? ORDER BY producto_id", s)]
        snaps = [self.snapshot(s, p, now) for p in ids]
        abiertas = self.alertas(s)
        for snap in snaps:
            snap["alertas"] = [a for a in abiertas if a["producto_id"] == snap["producto_id"]]
            snap["desvio_hoy"] = self.q1(
                """SELECT COALESCE(SUM(-diferencia), 0) FROM conteo
                   WHERE sucursal_id = ? AND producto_id = ? AND diferencia < 0 AND created_at >= ?""",
                s, snap["producto_id"], iso(now.replace(hour=0, minute=0, second=0)))[0]
        return snaps

    def alertas(self, s, destinatario=None):
        sql = "SELECT * FROM alerta WHERE sucursal_id = ? AND estado = 'ABIERTA'"
        args = [s]
        if destinatario:
            sql += " AND destinatario = ?"
            args.append(destinatario)
        return [dict(r) for r in self.q(sql, *args)]

    def reposicion(self, s, now):
        """RF-05: repositor work list, ordered by priority, hours to empty, value."""
        items = []
        for a in self.alertas(s, "REPOSITOR"):
            snap = self.snapshot(s, a["producto_id"], now)
            items.append({**a, **{k: snap[k] for k in (
                "nombre", "precio", "stock_gondola", "conteo_informado", "nivel", "capacidad",
                "horas_a_vacio", "tiempo_reposicion_min", "conteo_at", "conteo_por", "estado", "deposito")}})
        items.sort(key=lambda i: (PRIORIDADES.index(i["prioridad"]),
                                  i["horas_a_vacio"] if i["horas_a_vacio"] is not None else
                                  (0 if i["stock_gondola"] == 0 else math.inf),
                                  -i["precio"]))
        minutos = sum(i["tiempo_reposicion_min"] for i in items if i["tipo"] == "REPONER")
        return {"items": items, "total_minutos": minutos}


def eventos_producto(eventos):
    return [e["data"] for e in eventos if e["type"] == "producto.actualizado"]
