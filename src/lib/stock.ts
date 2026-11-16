/** Shelf stock domain: counts, sales, thresholds and alerts (spec-00). */
import type { Db, Q, Row } from "./db";
import { ConflictError, DomainError, NotFoundError } from "./errors";
import { HOUR, fromIso, iso, parseTs, plus, startOfDay, startOfHour } from "./time";

export const SEGURIDAD = 1;              // safety units in the threshold formula
export const RESPUESTA_DEFAULT_H = 0.5;  // response time until there is history
export const CONTEO_VENCE_H = 24;        // a count older than this asks for a recount
export const ALTA_ROTACION_UH = 1.0;     // units/hour from which silence-detection (R3) applies
export const P_SILENCIO = 0.05;          // R3 fires when P(no sales in the elapsed time) < this
const SEMANAS = 4;
const WEEK = 7 * 24 * HOUR;

export const PRIORIDADES = ["URGENTE", "ALTA", "MEDIA", "BAJA"] as const;
const TIPOS_CONTEO = new Set(["REPOSICION", "VERIFICACION", "INICIAL"]);
const CIERRA_AL_CONTAR = "'REPONER', 'VERIFICAR', 'RECONTAR'"; // closed by a count (RF-01)

export type Evento = { type: "producto.actualizado" | "alerta.creada" | "alerta.cerrada"; sucursal_id: string; data: Row };
export type Snapshot = Row & { estado: string; estado_anterior: string };

const prio = (p: string) => PRIORIDADES.indexOf(p as (typeof PRIORIDADES)[number]);

function int(value: unknown, campo: string, minimo: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimo) {
    throw new DomainError(`${campo}: debe ser un entero ≥ ${minimo}`);
  }
  return value;
}

function str(value: unknown, campo: string): string {
  if (typeof value !== "string" || !value.trim()) throw new DomainError(`${campo}: requerido`);
  return value.trim();
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

async function one<T = Row>(q: Q, text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q.query<T>(text, params))[0];
}

const VENTAS_VALIDAS = `
  FROM venta_linea l JOIN venta v USING (comprobante_id)
  WHERE v.tipo = 'VENTA' AND v.anulada_por IS NULL AND v.sucursal_id = $1 AND l.producto_id = $2`;

export class Stock {
  constructor(private db: Db) {}

  // ---------- derived figures (F4) ----------

  /** Units of non-voided sales emitted at or after `desde`.
   * Same-second sales count as after the count: the shelf is underestimated, never overestimated. */
  private async vendidoDesde(q: Q, s: string, p: string, desde: string): Promise<number> {
    return (await one(q, `SELECT COALESCE(SUM(l.cantidad), 0)::int AS n ${VENTAS_VALIDAS} AND v.emitido_at >= $3`, [s, p, desde]))!.n;
  }

  private async ventasEntre(q: Q, s: string, p: string, desde: Date, hasta: Date): Promise<number> {
    return (await one(q, `SELECT COALESCE(SUM(l.cantidad), 0)::int AS n ${VENTAS_VALIDAS}
      AND v.emitido_at >= $3 AND v.emitido_at < $4`, [s, p, iso(desde), iso(hasta)]))!.n;
  }

  /** Average units/hour for this weekday+hour over the last 4 weeks, skipping hours with an
   * empty shelf (censored demand). null = no history before today. */
  async ventaHoraFranja(q: Q, s: string, p: string, now: Date): Promise<number | null> {
    const hoy = startOfDay(now);
    if (!(await this.ventasEntre(q, s, p, plus(hoy, -SEMANAS * WEEK), hoy))) return null;
    const hora = startOfHour(now);
    const muestras: number[] = [];
    for (let k = 1; k <= SEMANAS; k++) {
      const ini = plus(hora, -k * WEEK);
      const fin = plus(ini, HOUR);
      const vacio = await one(q, `SELECT 1 FROM vacio_periodo WHERE sucursal_id = $1 AND producto_id = $2
        AND desde < $3 AND (hasta IS NULL OR hasta > $4)`, [s, p, iso(fin), iso(ini)]);
      if (!vacio) muestras.push(await this.ventasEntre(q, s, p, ini, fin));
    }
    return muestras.length ? muestras.reduce((a, b) => a + b, 0) / muestras.length : null;
  }

  async tiempoRespuestaH(q: Q, s: string, now: Date): Promise<number> {
    const rows = await q.query(`SELECT creada_at, atendida_at FROM alerta
      WHERE sucursal_id = $1 AND tipo = 'REPONER' AND estado = 'ATENDIDA'
        AND atendida_por IS NOT NULL AND atendida_at >= $2`, [s, iso(plus(now, -7 * 24 * HOUR))]);
    if (!rows.length) return RESPUESTA_DEFAULT_H;
    return median(rows.map((r) => (fromIso(r.atendida_at).getTime() - fromIso(r.creada_at).getTime()) / HOUR));
  }

  static umbral(item: Row, ventaHora: number | null, respuestaH: number): number {
    const minimo = item.minimo_exhibicion;
    if (ventaHora === null) return item.capacidad ? Math.max(minimo, Math.ceil(item.capacidad * 0.25)) : minimo;
    const horas = respuestaH + item.tiempo_reposicion_min / 60;
    // round() before ceil() avoids 2.0000000001 -> 3 from float noise.
    return Math.max(minimo, Math.ceil(round(ventaHora * horas + SEGURIDAD, 6)));
  }

  async snapshot(q: Q, s: string, p: string, now: Date): Promise<Snapshot> {
    const item = await one(q, `SELECT g.*, COALESCE(pr.nombre, g.producto_id) AS nombre,
        COALESCE(pr.precio, 0)::float8 AS precio, sg.unidades AS stock_general
      FROM gondola_item g
      LEFT JOIN producto pr ON pr.id = g.producto_id
      LEFT JOIN stock_general sg ON sg.sucursal_id = g.sucursal_id AND sg.producto_id = g.producto_id
      WHERE g.sucursal_id = $1 AND g.producto_id = $2`, [s, p]);
    if (!item) throw new NotFoundError(`producto ${p} no está en la góndola de ${s}`);
    const contado = item.conteo_at !== null;
    const informado: number = item.conteo_informado ?? 0;
    const vendido = contado ? await this.vendidoDesde(q, s, p, item.conteo_at) : 0;
    const stock = Math.max(0, informado - vendido);
    const vendidoHoy = await this.ventasEntre(q, s, p, startOfDay(now), plus(now, 1000));
    const deposito = Math.max(0, (item.stock_general ?? 0) - vendidoHoy - stock);
    const vh = await this.ventaHoraFranja(q, s, p, now);
    const umbral = Stock.umbral(item, vh, await this.tiempoRespuestaH(q, s, now));
    const cap: number | null = item.capacidad;
    const ultima = (await one(q, `SELECT MAX(v.emitido_at) AS t ${VENTAS_VALIDAS}`, [s, p]))!.t;

    const estado = !contado ? "SIN_CONTEO"
      : stock === 0 ? "VACIO"
      : stock <= umbral && deposito === 0 ? "SIN_DEPOSITO"
      : stock <= umbral ? "BAJO"
      : "OK";

    return {
      sucursal_id: s,
      producto_id: p,
      nombre: item.nombre,
      precio: item.precio,
      capacidad: cap,
      tiempo_reposicion_min: item.tiempo_reposicion_min,
      conteo_informado: item.conteo_informado,
      conteo_at: item.conteo_at,
      conteo_por: item.conteo_por,
      conteo_vencido: contado && now.getTime() - fromIso(item.conteo_at).getTime() > CONTEO_VENCE_H * HOUR,
      vendido_desde_conteo: vendido,
      stock_gondola: stock,
      desvio: contado ? Math.max(0, vendido - informado) : 0,
      nivel: informado ? Math.round((stock * 100) / informado) : 0,
      stock_general: item.stock_general,
      vendido_hoy: vendidoHoy,
      deposito,
      venta_hora: vh !== null ? round(vh, 2) : null,
      umbral,
      horas_a_vacio: vh ? round(stock / vh, 1) : null,
      a_reponer: cap ? Math.max(0, Math.min(cap - stock, deposito)) : deposito,
      ultima_venta_at: ultima,
      estado,
      estado_anterior: item.estado,
    };
  }

  /** R3: a fast mover with stock on the shelf that stopped selling. */
  private silencioImprobable(snap: Snapshot, now: Date): boolean {
    const vh = snap.venta_hora;
    if (!vh || vh < ALTA_ROTACION_UH || snap.stock_gondola === 0) return false;
    const desde = [snap.conteo_at, snap.ultima_venta_at].filter(Boolean).sort().at(-1)!;
    const horas = (now.getTime() - fromIso(desde).getTime()) / HOUR;
    // ponytail: Poisson with the current hour's rate; integrate per-hour rates if false alarms show up.
    return Math.exp(-vh * horas) < P_SILENCIO;
  }

  // ---------- alerts (F5) ----------

  private alertasDeseadas(snap: Snapshot, now: Date): Map<string, [string, string, number | null]> {
    const quiere = new Map<string, [string, string, number | null]>();
    if (snap.conteo_at === null) return quiere.set("RECONTAR", ["BAJA", "REPOSITOR", null]);
    if (snap.conteo_vencido) quiere.set("RECONTAR", ["BAJA", "REPOSITOR", null]);
    if (snap.stock_gondola <= snap.umbral) {
      if (snap.deposito > 0) quiere.set("REPONER", [snap.stock_gondola === 0 ? "URGENTE" : "ALTA", "REPOSITOR", snap.a_reponer]);
      else quiere.set("SIN_DEPOSITO", ["ALTA", "ENCARGADO", null]);
    }
    if (snap.desvio > 0 || this.silencioImprobable(snap, now)) quiere.set("VERIFICAR", ["MEDIA", "REPOSITOR", null]);
    return quiere;
  }

  private alertaDict(row: Row, snap: Snapshot): Row {
    return { ...row, nombre: snap.nombre, stock_gondola: snap.stock_gondola, conteo_informado: snap.conteo_informado };
  }

  /** Recompute state and alerts for one product. Must run inside a transaction. */
  async evaluar(q: Q, s: string, p: string, now: Date, siempre = true): Promise<Evento[]> {
    const snap = await this.snapshot(q, s, p, now);
    const eventos: Evento[] = [];
    const cambio = snap.estado !== snap.estado_anterior;
    const ahora = iso(now);

    if (cambio) {
      await q.query("UPDATE gondola_item SET estado = $1 WHERE sucursal_id = $2 AND producto_id = $3", [snap.estado, s, p]);
      if (snap.estado_anterior === "VACIO") {
        await q.query("UPDATE vacio_periodo SET hasta = $1 WHERE sucursal_id = $2 AND producto_id = $3 AND hasta IS NULL", [ahora, s, p]);
      }
      if (snap.estado === "VACIO") {
        await q.query("INSERT INTO vacio_periodo (sucursal_id, producto_id, desde) VALUES ($1, $2, $3)", [s, p, ahora]);
      }
    }

    const quiere = this.alertasDeseadas(snap, now);
    const abiertas = new Map((await q.query(
      "SELECT * FROM alerta WHERE sucursal_id = $1 AND producto_id = $2 AND estado = 'ABIERTA'", [s, p])).map((r) => [r.tipo, r]));

    for (const [tipo, row] of abiertas) {
      if (!quiere.has(tipo)) {
        await q.query("UPDATE alerta SET estado = 'ATENDIDA', atendida_at = $1, motivo = 'resuelta automáticamente' WHERE id = $2", [ahora, row.id]);
        eventos.push({ type: "alerta.cerrada", sucursal_id: s, data: { id: row.id, tipo, producto_id: p } });
      }
    }

    for (const [tipo, [prioridad, dest, unidades]] of quiere) {
      const row = abiertas.get(tipo);
      if (!row) {
        const nueva = (await one(q, `INSERT INTO alerta (sucursal_id, producto_id, tipo, prioridad, destinatario, unidades_sugeridas, creada_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [s, p, tipo, prioridad, dest, unidades, ahora]))!;
        eventos.push({ type: "alerta.creada", sucursal_id: s, data: this.alertaDict(nueva, snap) });
      } else if (prio(prioridad) < prio(row.prioridad)) {
        // Escalation (ALTA -> URGENTE) notifies again.
        const esc = (await one(q, "UPDATE alerta SET prioridad = $1, unidades_sugeridas = $2 WHERE id = $3 RETURNING *", [prioridad, unidades, row.id]))!;
        eventos.push({ type: "alerta.creada", sucursal_id: s, data: { ...this.alertaDict(esc, snap), escalada: true } });
      } else if (row.unidades_sugeridas !== unidades || row.prioridad !== prioridad) {
        await q.query("UPDATE alerta SET prioridad = $1, unidades_sugeridas = $2 WHERE id = $3", [prioridad, unidades, row.id]);
      }
    }

    if (siempre || cambio || eventos.length) {
      snap.estado_anterior = snap.estado;
      eventos.unshift({ type: "producto.actualizado", sucursal_id: s, data: snap });
    }
    return eventos;
  }

  /** Serializes writes per branch across concurrent serverless invocations. */
  private lock(q: Q, s: string) {
    return q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [s]);
  }

  private alta(q: Q, s: string, p: string) {
    return q.query("INSERT INTO gondola_item (sucursal_id, producto_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [s, p]);
  }

  // ---------- commands ----------

  /** RF-01. */
  async registrarConteo(s: string, body: Row, now: Date): Promise<{ result: Row; eventos: Evento[] }> {
    const p = str(body.producto_id, "producto_id");
    const repositor = str(body.repositor_id, "repositor_id");
    const unidades = int(body.unidades, "unidades", 0);
    const tipo = body.tipo ?? "REPOSICION";
    if (!TIPOS_CONTEO.has(tipo)) throw new DomainError(`tipo: debe ser uno de ${[...TIPOS_CONTEO].sort().join(", ")}`);
    // created_at from the device keeps offline counts in order (RNF-04).
    let at = body.created_at ? parseTs(body.created_at, "created_at") : now;
    if (at > now) at = now;

    return this.db.tx(async (q) => {
      await this.lock(q, s);
      await this.alta(q, s, p);
      const item = (await one(q, "SELECT * FROM gondola_item WHERE sucursal_id = $1 AND producto_id = $2", [s, p]))!;
      if (item.capacidad && unidades > item.capacidad && !body.confirmar_capacidad) {
        throw new ConflictError(`¿Superás la capacidad de ${item.capacidad}? Confirmá el conteo.`);
      }
      const esperado: number | null = item.conteo_at ? (await this.snapshot(q, s, p, at)).stock_gondola : null;
      const diferencia = esperado === null ? null : unidades - esperado;
      await q.query(`INSERT INTO conteo (sucursal_id, producto_id, repositor_id, unidades, esperado, diferencia, tipo, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [s, p, repositor, unidades, esperado, diferencia, tipo, iso(at)]);

      if (item.conteo_at && iso(at) <= item.conteo_at) {
        // An older offline count arriving late: keep it as history only.
        return { result: { aplicado: false, esperado }, eventos: [] };
      }
      await q.query(`UPDATE gondola_item SET conteo_informado = $1, conteo_at = $2, conteo_por = $3,
          capacidad = COALESCE(capacidad, NULLIF($1, 0)) WHERE sucursal_id = $4 AND producto_id = $5`,
        [unidades, iso(at), repositor, s, p]);
      const eventos: Evento[] = [];
      const cerradas = await q.query(`UPDATE alerta SET estado = 'ATENDIDA', atendida_at = $1, atendida_por = $2
        WHERE sucursal_id = $3 AND producto_id = $4 AND estado = 'ABIERTA' AND tipo IN (${CIERRA_AL_CONTAR}) RETURNING id, tipo`,
        [iso(now), repositor, s, p]);
      for (const r of cerradas) eventos.push({ type: "alerta.cerrada", sucursal_id: s, data: { id: r.id, tipo: r.tipo, producto_id: p } });
      eventos.push(...(await this.evaluar(q, s, p, now)));
      return { result: { aplicado: true, esperado, diferencia, producto: productos(eventos) }, eventos };
    });
  }

  /** Inserted one by one so a failure mid-receipt rolls back the whole sale (all-or-nothing). */
  async insertLinea(q: Q, comprobanteId: string, l: Row) {
    await q.query("INSERT INTO venta_linea (comprobante_id, linea, producto_id, cantidad) VALUES ($1, $2, $3, $4)",
      [comprobanteId, l.linea, l.producto_id, l.cantidad]);
  }

  /** RF-02. */
  async registrarVenta(body: Row, now: Date): Promise<{ status: number; result: Row; eventos: Evento[] }> {
    const cid = str(body.comprobante_id, "comprobante_id");
    const s = str(body.sucursal_id, "sucursal_id");
    const tipo = body.tipo ?? "VENTA";
    const emitido = iso(parseTs(body.emitido_at, "emitido_at"));
    const lineas: Row[] = [];
    let ref = "";
    if (tipo === "VENTA") {
      if (!Array.isArray(body.lineas) || !body.lineas.length) throw new DomainError("lineas: una VENTA necesita al menos una línea");
      body.lineas.forEach((l: unknown, idx: number) => {
        const i = idx + 1;
        if (!l || typeof l !== "object") throw new DomainError(`lineas[${i}]: objeto inválido`);
        const r = l as Row;
        lineas.push({
          linea: int(r.linea ?? i, `lineas[${i}].linea`, 1),
          producto_id: str(r.producto_id, `lineas[${i}].producto_id`),
          cantidad: int(r.cantidad, `lineas[${i}].cantidad`, 1),
        });
      });
      if (new Set(lineas.map((l) => l.linea)).size !== lineas.length) throw new DomainError("lineas: número de línea repetido");
    } else if (tipo === "ANULACION") {
      ref = str(body.comprobante_ref, "comprobante_ref");
    } else {
      throw new DomainError("tipo: VENTA o ANULACION");
    }

    return this.db.tx(async (q) => {
      await this.lock(q, s);
      // Checked under the lock so two concurrent retries of one receipt apply once.
      const previa = await one(q, "SELECT * FROM venta WHERE comprobante_id = $1", [cid]);
      if (previa) return { status: 200, result: { duplicado: true, venta: previa }, eventos: [] };
      await q.query(`INSERT INTO venta (comprobante_id, sucursal_id, tipo, comprobante_ref, emitido_at, procesada_at)
        VALUES ($1, $2, $3, $4, $5, $6)`, [cid, s, tipo, tipo === "ANULACION" ? ref : null, emitido, iso(now)]);
      let afectados: string[];
      if (tipo === "VENTA") {
        for (const l of lineas) await this.insertLinea(q, cid, l);
        afectados = [...new Set(lineas.map((l) => l.producto_id))];
      } else {
        const original = await one(q, "SELECT * FROM venta WHERE comprobante_id = $1 AND tipo = 'VENTA'", [ref]);
        if (!original || original.sucursal_id !== s) throw new DomainError(`comprobante_ref: la venta ${ref} no existe en ${s}`);
        if (original.anulada_por) throw new DomainError(`comprobante_ref: la venta ${ref} ya fue anulada`);
        await q.query("UPDATE venta SET anulada_por = $1 WHERE comprobante_id = $2", [cid, ref]);
        afectados = (await q.query("SELECT DISTINCT producto_id FROM venta_linea WHERE comprobante_id = $1", [ref])).map((r) => r.producto_id);
      }
      const eventos: Evento[] = [];
      for (const p of afectados.sort()) {
        await this.alta(q, s, p); // unknown product: registered as "sin conteo"
        eventos.push(...(await this.evaluar(q, s, p, now)));
      }
      return { status: 201, result: { duplicado: false, comprobante_id: cid, productos: productos(eventos) }, eventos };
    });
  }

  async descartarAlerta(id: number, body: Row, now: Date): Promise<{ result: Row; eventos: Evento[] }> {
    const motivo = str(body.motivo, "motivo");
    return this.db.tx(async (q) => {
      const row = await one(q, "SELECT * FROM alerta WHERE id = $1 FOR UPDATE", [id]);
      if (!row) throw new NotFoundError("alerta inexistente");
      if (row.estado !== "ABIERTA") throw new ConflictError("la alerta ya está cerrada");
      await q.query("UPDATE alerta SET estado = 'DESCARTADA', atendida_at = $1, atendida_por = $2, motivo = $3 WHERE id = $4",
        [iso(now), body.por ?? null, motivo, id]);
      return {
        result: { id, estado: "DESCARTADA" },
        eventos: [{ type: "alerta.cerrada", sucursal_id: row.sucursal_id, data: { id, tipo: row.tipo, producto_id: row.producto_id } }],
      };
    });
  }

  /** Periodic re-evaluation: hour-slot thresholds, stale counts and silence (R3). One transaction per branch. */
  async tick(now: Date): Promise<Evento[]> {
    const eventos: Evento[] = [];
    const sucursales = (await this.db.query("SELECT DISTINCT sucursal_id FROM gondola_item")).map((r) => r.sucursal_id);
    for (const s of sucursales) {
      eventos.push(...(await this.db.tx(async (q) => {
        await this.lock(q, s);
        const out: Evento[] = [];
        for (const r of await q.query("SELECT producto_id FROM gondola_item WHERE sucursal_id = $1", [s])) {
          out.push(...(await this.evaluar(q, s, r.producto_id, now, false)));
        }
        return out;
      })));
    }
    return eventos;
  }

  // ---------- queries ----------

  async sucursales(): Promise<string[]> {
    return (await this.db.query("SELECT DISTINCT sucursal_id FROM gondola_item ORDER BY 1")).map((r) => r.sucursal_id);
  }

  async productos(s: string, now: Date): Promise<Row[]> {
    const q = this.db;
    const ids = (await q.query("SELECT producto_id FROM gondola_item WHERE sucursal_id = $1 ORDER BY producto_id", [s])).map((r) => r.producto_id);
    const abiertas = await this.alertas(s);
    const out: Row[] = [];
    for (const p of ids) {
      const snap: Row = await this.snapshot(q, s, p, now);
      snap.alertas = abiertas.filter((a) => a.producto_id === p);
      snap.desvio_hoy = (await one(q, `SELECT COALESCE(SUM(-diferencia), 0)::int AS n FROM conteo
        WHERE sucursal_id = $1 AND producto_id = $2 AND diferencia < 0 AND created_at >= $3`, [s, p, iso(startOfDay(now))]))!.n;
      out.push(snap);
    }
    return out;
  }

  async alertas(s: string, destinatario?: string | null): Promise<Row[]> {
    return destinatario
      ? this.db.query("SELECT * FROM alerta WHERE sucursal_id = $1 AND estado = 'ABIERTA' AND destinatario = $2 ORDER BY id", [s, destinatario])
      : this.db.query("SELECT * FROM alerta WHERE sucursal_id = $1 AND estado = 'ABIERTA' ORDER BY id", [s]);
  }

  /** RF-05: repositor work list, ordered by priority, hours to empty, value. */
  async reposicion(s: string, now: Date): Promise<{ items: Row[]; total_minutos: number }> {
    const items: Row[] = [];
    for (const a of await this.alertas(s, "REPOSITOR")) {
      const snap = await this.snapshot(this.db, s, a.producto_id, now);
      items.push({
        ...a,
        estado_producto: snap.estado,
        ...Object.fromEntries(["nombre", "precio", "stock_gondola", "conteo_informado", "nivel", "capacidad", "horas_a_vacio",
          "tiempo_reposicion_min", "conteo_at", "conteo_por", "deposito"].map((k) => [k, snap[k]])),
      });
    }
    const vacio = (i: Row) => i.horas_a_vacio ?? (i.stock_gondola === 0 ? 0 : Infinity);
    items.sort((a, b) => prio(a.prioridad) - prio(b.prioridad) || vacio(a) - vacio(b) || b.precio - a.precio);
    const total = items.filter((i) => i.tipo === "REPONER").reduce((t, i) => t + i.tiempo_reposicion_min, 0);
    return { items, total_minutos: total };
  }
}

export const productos = (eventos: Evento[]) => eventos.filter((e) => e.type === "producto.actualizado").map((e) => e.data);
