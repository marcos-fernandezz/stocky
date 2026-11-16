/** Rounds per period and sales-anomaly alerts (spec-01). No estimated shelf stock: sales history drives everything. */
import type { Db, Q, Row } from "./db";
import { ConflictError, DomainError, NotFoundError } from "./errors";
import { HOUR, fromIso, iso, parseTs, plus, startOfDay } from "./time";

export const P_ANOMALIA = 0.05; // VENTA_ANOMALA fires when P(selling this little | expected) < this
const SEMANAS = 4;
const WEEK = 7 * 24 * HOUR;

export const PRIORIDADES = ["URGENTE", "ALTA", "MEDIA", "BAJA"] as const;
export const RESULTADOS = ["OK", "REPUSE", "SIN_STOCK"] as const;

export type Evento = { type: "producto.actualizado" | "alerta.creada" | "alerta.cerrada"; sucursal_id: string; data: Row };
export type Periodo = { n: number; de: number; inicio: string; fin: string };

function int(value: unknown, campo: string, minimo: number, maximo = Infinity): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimo || value > maximo) {
    throw new DomainError(`${campo}: debe ser un entero entre ${minimo} y ${maximo}`);
  }
  return value;
}

function str(value: unknown, campo: string): string {
  if (typeof value !== "string" || !value.trim()) throw new DomainError(`${campo}: requerido`);
  return value.trim();
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** P(X ≤ k) for X ~ Poisson(λ). */
export function poissonCdf(k: number, lambda: number): number {
  let term = Math.exp(-lambda);
  let sum = term;
  for (let i = 1; i <= k; i++) sum += (term *= lambda / i);
  return sum;
}

async function one<T = Row>(q: Q, text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q.query<T>(text, params))[0];
}

const VENTAS_VALIDAS = `
  FROM venta_linea l JOIN venta v USING (comprobante_id)
  WHERE v.tipo = 'VENTA' AND v.anulada_por IS NULL AND v.sucursal_id = $1 AND l.producto_id = $2`;

export class Stock {
  constructor(private db: Db) {}

  // ---------- periods (S2) ----------

  async config(q: Q, s: string): Promise<Row> {
    const cfg = await one(q, "SELECT * FROM sucursal WHERE id = $1", [s]);
    if (!cfg) throw new NotFoundError(`sucursal ${s} inexistente`);
    return cfg;
  }

  /** The round period `now` falls in: business hours split into `pasadas_por_dia` equal parts. null = store closed. */
  periodo(cfg: Row, now: Date): Periodo | null {
    const abre = plus(startOfDay(now), cfg.apertura * HOUR).getTime();
    const largo = ((cfg.cierre - cfg.apertura) * HOUR) / cfg.pasadas_por_dia;
    const i = Math.floor((now.getTime() - abre) / largo);
    if (i < 0 || i >= cfg.pasadas_por_dia) return null;
    return { n: i + 1, de: cfg.pasadas_por_dia, inicio: iso(new Date(abre + i * largo)), fin: iso(new Date(abre + (i + 1) * largo)) };
  }

  // ---------- figures (S4) ----------

  private async ventasEntre(q: Q, s: string, p: string, desde: Date, hasta: Date): Promise<number> {
    return (await one(q, `SELECT COALESCE(SUM(l.cantidad), 0)::int AS n ${VENTAS_VALIDAS}
      AND v.emitido_at >= $3 AND v.emitido_at < $4`, [s, p, iso(desde), iso(hasta)]))!.n;
  }

  /** Average units sold in [ini, fin) on the same weekday over the last 4 weeks, skipping weeks with a
   * stock-out inside the `censura` window, the whole period by default (censored demand). null = no sales history before today. */
  async promedio(q: Q, s: string, p: string, ini: Date, fin: Date, censura = { ini, fin }): Promise<number | null> {
    const hoy = startOfDay(ini);
    if (!(await this.ventasEntre(q, s, p, plus(hoy, -SEMANAS * WEEK), hoy))) return null;
    const muestras: number[] = [];
    for (let k = 1; k <= SEMANAS; k++) {
      const quiebre = await one(q, `SELECT 1 FROM vacio_periodo WHERE sucursal_id = $1 AND producto_id = $2
        AND desde < $3 AND (hasta IS NULL OR hasta > $4)`, [s, p, iso(plus(censura.fin, -k * WEEK)), iso(plus(censura.ini, -k * WEEK))]);
      if (!quiebre) muestras.push(await this.ventasEntre(q, s, p, plus(ini, -k * WEEK), plus(fin, -k * WEEK)));
    }
    return muestras.length ? muestras.reduce((a, b) => a + b, 0) / muestras.length : null;
  }

  async snapshot(q: Q, s: string, p: string, now: Date): Promise<Row> {
    const item = await one(q, `SELECT g.producto_id, COALESCE(pr.nombre, g.producto_id) AS nombre, COALESCE(pr.precio, 0)::float8 AS precio
      FROM gondola_item g LEFT JOIN producto pr ON pr.id = g.producto_id
      WHERE g.sucursal_id = $1 AND g.producto_id = $2`, [s, p]);
    if (!item) throw new NotFoundError(`producto ${p} no está en la góndola de ${s}`);
    const per = this.periodo(await this.config(q, s), now);
    let umbral: number | null = null;
    let esperado: number | null = null;
    let vendidoPeriodo = 0;
    if (per) {
      const ini = fromIso(per.inicio);
      const fin = fromIso(per.fin);
      umbral = await this.promedio(q, s, p, ini, fin);
      // Expected so far = what used to sell in the same elapsed window, so intra-period peaks are respected.
      esperado = umbral === null ? null : await this.promedio(q, s, p, ini, now, { ini, fin });
      vendidoPeriodo = await this.ventasEntre(q, s, p, ini, plus(now, 1000));
    }
    const quiebre = await one(q, "SELECT desde FROM vacio_periodo WHERE sucursal_id = $1 AND producto_id = $2 AND hasta IS NULL", [s, p]);
    const anomalia = await one(q, "SELECT 1 FROM alerta WHERE sucursal_id = $1 AND producto_id = $2 AND tipo = 'VENTA_ANOMALA' AND estado = 'ABIERTA'", [s, p]);
    return {
      sucursal_id: s,
      ...item,
      periodo: per,
      umbral: umbral === null ? null : round(umbral, 1),
      esperado: esperado === null ? null : round(esperado, 1),
      vendido_periodo: vendidoPeriodo,
      vendido_hoy: await this.ventasEntre(q, s, p, startOfDay(now), plus(now, 1000)),
      ultima_venta_at: (await one(q, `SELECT MAX(v.emitido_at) AS t ${VENTAS_VALIDAS}`, [s, p]))!.t,
      quiebre_desde: quiebre?.desde ?? null,
      estado: quiebre ? "QUIEBRE" : anomalia ? "ANOMALIA" : "OK",
    };
  }

  // ---------- alerts ----------

  private async abrir(q: Q, s: string, p: string | null, tipo: string, prioridad: string, destinatario: string, ahora: string, extra: Row = {}): Promise<Evento> {
    const row = (await one(q, `INSERT INTO alerta (sucursal_id, producto_id, tipo, prioridad, destinatario, creada_at)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [s, p, tipo, prioridad, destinatario, ahora]))!;
    return { type: "alerta.creada", sucursal_id: s, data: { ...row, ...extra } };
  }

  /** Closes the open alerts of these types for a product; returns their events. */
  private async cerrar(q: Q, s: string, p: string, tipos: string[], ahora: string, por: string | null, motivo: string | null): Promise<Evento[]> {
    const rows = await q.query(`UPDATE alerta SET estado = 'ATENDIDA', atendida_at = $1, atendida_por = $2, motivo = $3
      WHERE sucursal_id = $4 AND producto_id = $5 AND estado = 'ABIERTA' AND tipo = ANY($6) RETURNING id, tipo`, [ahora, por, motivo, s, p, tipos]);
    return rows.map((r) => ({ type: "alerta.cerrada", sucursal_id: s, data: { id: r.id, tipo: r.tipo, producto_id: p } }));
  }

  /** S3 + S5 for one branch: one RONDA per period, one VENTA_ANOMALA per product per period. */
  private async evaluarSucursal(q: Q, s: string, now: Date): Promise<Evento[]> {
    const per = this.periodo(await this.config(q, s), now);
    if (!per) return [];
    const ahora = iso(now);
    const eventos: Evento[] = [];

    if (!(await one(q, "SELECT 1 FROM alerta WHERE sucursal_id = $1 AND tipo = 'RONDA' AND creada_at >= $2", [s, per.inicio]))) {
      const viejas = await q.query(`UPDATE alerta SET estado = 'DESCARTADA', atendida_at = $1, motivo = 'pasada no realizada'
        WHERE sucursal_id = $2 AND tipo = 'RONDA' AND estado = 'ABIERTA' RETURNING id`, [ahora, s]);
      for (const r of viejas) eventos.push({ type: "alerta.cerrada", sucursal_id: s, data: { id: r.id, tipo: "RONDA", producto_id: null } });
      eventos.push(await this.abrir(q, s, null, "RONDA", "MEDIA", "REPOSITOR", ahora, { periodo: per }));
    }

    for (const { producto_id: p } of await q.query("SELECT producto_id FROM gondola_item WHERE sucursal_id = $1 ORDER BY producto_id", [s])) {
      const ya = await one(q, `SELECT 1 FROM alerta WHERE sucursal_id = $1 AND producto_id = $2 AND tipo = 'VENTA_ANOMALA'
        AND (creada_at >= $3 OR estado = 'ABIERTA')`, [s, p, per.inicio]);
      if (ya) continue;
      const snap = await this.snapshot(q, s, p, now);
      if (snap.estado === "QUIEBRE" || !snap.esperado) continue;
      // ponytail: Poisson assumes independent sales; tune P_ANOMALIA if bulk buyers cause false alarms.
      if (poissonCdf(snap.vendido_periodo, snap.esperado) < P_ANOMALIA) {
        eventos.push(await this.abrir(q, s, p, "VENTA_ANOMALA", "ALTA", "REPOSITOR", ahora,
          { nombre: snap.nombre, esperado: snap.esperado, vendido_periodo: snap.vendido_periodo }));
      }
    }
    return eventos;
  }

  /** Serializes writes per branch across concurrent serverless invocations. */
  private lock(q: Q, s: string) {
    return q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [s]);
  }

  // ---------- commands ----------

  /** S2: the encargado sets rounds per day and business hours. */
  async configurar(s: string, body: Row): Promise<Row> {
    return this.db.tx(async (q) => {
      const cfg = { ...(await this.config(q, s)) };
      if (body.pasadas_por_dia !== undefined) cfg.pasadas_por_dia = int(body.pasadas_por_dia, "pasadas_por_dia", 1, 24);
      if (body.apertura !== undefined) cfg.apertura = int(body.apertura, "apertura", 0, 23);
      if (body.cierre !== undefined) cfg.cierre = int(body.cierre, "cierre", 1, 24);
      if (cfg.cierre <= cfg.apertura) throw new DomainError("cierre: debe ser posterior a la apertura");
      return (await one(q, "UPDATE sucursal SET pasadas_por_dia = $1, apertura = $2, cierre = $3 WHERE id = $4 RETURNING *",
        [cfg.pasadas_por_dia, cfg.apertura, cfg.cierre, s]))!;
    });
  }

  /** S6: the repositor reports a product. OK = shelf fine; REPUSE = it was empty and got restocked;
   * SIN_STOCK = empty and nothing in the back room (stays open, escalates to the encargado). */
  async reportar(s: string, body: Row, now: Date): Promise<{ result: Row; eventos: Evento[] }> {
    const p = str(body.producto_id, "producto_id");
    const repositor = str(body.repositor_id, "repositor_id");
    const resultado = body.resultado;
    if (!RESULTADOS.includes(resultado)) throw new DomainError(`resultado: debe ser uno de ${RESULTADOS.join(", ")}`);
    const ahora = iso(now);

    return this.db.tx(async (q) => {
      await this.lock(q, s);
      const snap = await this.snapshot(q, s, p, now);
      const eventos = await this.cerrar(q, s, p, ["VENTA_ANOMALA"], ahora, repositor, resultado);
      // The shelf emptied with its last sale: nobody can buy what is not there.
      const desde = snap.ultima_venta_at ?? ahora;
      if (resultado === "REPUSE") {
        const abierto = await q.query("UPDATE vacio_periodo SET hasta = $1 WHERE sucursal_id = $2 AND producto_id = $3 AND hasta IS NULL RETURNING 1",
          [ahora, s, p]);
        if (!abierto.length) await q.query("INSERT INTO vacio_periodo (sucursal_id, producto_id, desde, hasta) VALUES ($1, $2, $3, $4)", [s, p, desde, ahora]);
        eventos.push(...(await this.cerrar(q, s, p, ["SIN_STOCK"], ahora, repositor, "repuesto")));
      } else if (resultado === "SIN_STOCK" && !snap.quiebre_desde) {
        await q.query("INSERT INTO vacio_periodo (sucursal_id, producto_id, desde) VALUES ($1, $2, $3)", [s, p, desde]);
        eventos.push(await this.abrir(q, s, p, "SIN_STOCK", "ALTA", "ENCARGADO", ahora, { nombre: snap.nombre, atendida_por: repositor }));
      }
      const producto = await this.snapshot(q, s, p, now);
      eventos.push({ type: "producto.actualizado", sucursal_id: s, data: producto });
      return { result: { producto }, eventos };
    });
  }

  /** Inserted one by one so a failure mid-receipt rolls back the whole sale (all-or-nothing). */
  async insertLinea(q: Q, comprobanteId: string, l: Row) {
    await q.query("INSERT INTO venta_linea (comprobante_id, linea, producto_id, cantidad) VALUES ($1, $2, $3, $4)",
      [comprobanteId, l.linea, l.producto_id, l.cantidad]);
  }

  /** Receives one POS receipt (or a void), idempotent by comprobante_id. */
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
      await q.query("INSERT INTO sucursal (id) VALUES ($1) ON CONFLICT DO NOTHING", [s]);
      await q.query(`INSERT INTO venta (comprobante_id, sucursal_id, tipo, comprobante_ref, emitido_at, procesada_at)
        VALUES ($1, $2, $3, $4, $5, $6)`, [cid, s, tipo, tipo === "ANULACION" ? ref : null, emitido, iso(now)]);
      const eventos: Evento[] = [];
      let afectados: string[];
      if (tipo === "VENTA") {
        for (const l of lineas) await this.insertLinea(q, cid, l);
        afectados = [...new Set(lineas.map((l) => l.producto_id))].sort();
        for (const p of afectados) {
          await q.query("INSERT INTO gondola_item (sucursal_id, producto_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [s, p]);
          const abierto = await one(q, `SELECT v.desde, COALESCE(MAX(a.creada_at), v.desde) AS reportado
            FROM vacio_periodo v LEFT JOIN alerta a ON a.sucursal_id = v.sucursal_id AND a.producto_id = v.producto_id
              AND a.tipo = 'SIN_STOCK' AND a.estado = 'ABIERTA'
            WHERE v.sucursal_id = $1 AND v.producto_id = $2 AND v.hasta IS NULL GROUP BY v.desde`, [s, p]);
          if (abierto && emitido >= abierto.reportado) {
            // Sold after the stock-out was reported: the shelf is no longer empty.
            await q.query("UPDATE vacio_periodo SET hasta = $1 WHERE sucursal_id = $2 AND producto_id = $3 AND hasta IS NULL", [emitido, s, p]);
            eventos.push(...(await this.cerrar(q, s, p, ["SIN_STOCK"], iso(now), null, "volvió a venderse")));
          } else if (abierto && emitido > abierto.desde) {
            // A late receipt from before the report only proves the shelf emptied after it.
            await q.query("UPDATE vacio_periodo SET desde = $1 WHERE sucursal_id = $2 AND producto_id = $3 AND hasta IS NULL", [emitido, s, p]);
          }
        }
      } else {
        const original = await one(q, "SELECT * FROM venta WHERE comprobante_id = $1 AND tipo = 'VENTA'", [ref]);
        if (!original || original.sucursal_id !== s) throw new DomainError(`comprobante_ref: la venta ${ref} no existe en ${s}`);
        if (original.anulada_por) throw new DomainError(`comprobante_ref: la venta ${ref} ya fue anulada`);
        await q.query("UPDATE venta SET anulada_por = $1 WHERE comprobante_id = $2", [cid, ref]);
        afectados = (await q.query("SELECT DISTINCT producto_id FROM venta_linea WHERE comprobante_id = $1 ORDER BY 1", [ref])).map((r) => r.producto_id);
      }
      const productos: Row[] = [];
      for (const p of afectados) {
        const snap = await this.snapshot(q, s, p, now);
        productos.push(snap);
        eventos.push({ type: "producto.actualizado", sucursal_id: s, data: snap });
      }
      return { status: 201, result: { duplicado: false, comprobante_id: cid, productos }, eventos };
    });
  }

  /** Closes an open alert: `estado: "ATENDIDA"` marks it done (a finished round); otherwise it is dismissed with a reason. */
  async cerrarAlerta(id: number, body: Row, now: Date): Promise<{ result: Row; eventos: Evento[] }> {
    const atendida = body.estado === "ATENDIDA";
    const motivo = atendida ? (body.motivo ?? null) : str(body.motivo, "motivo");
    const estado = atendida ? "ATENDIDA" : "DESCARTADA";
    return this.db.tx(async (q) => {
      const row = await one(q, "SELECT * FROM alerta WHERE id = $1 FOR UPDATE", [id]);
      if (!row) throw new NotFoundError("alerta inexistente");
      if (row.estado !== "ABIERTA") throw new ConflictError("la alerta ya está cerrada");
      await q.query("UPDATE alerta SET estado = $1, atendida_at = $2, atendida_por = $3, motivo = $4 WHERE id = $5",
        [estado, iso(now), body.por ?? null, motivo, id]);
      return {
        result: { id, estado },
        eventos: [{ type: "alerta.cerrada", sucursal_id: row.sucursal_id, data: { id, tipo: row.tipo, producto_id: row.producto_id } }],
      };
    });
  }

  /** Every minute: opens rounds and checks sales anomalies. One transaction per branch. */
  async tick(now: Date): Promise<Evento[]> {
    const eventos: Evento[] = [];
    for (const s of await this.sucursales()) {
      eventos.push(...(await this.db.tx(async (q) => {
        await this.lock(q, s);
        return this.evaluarSucursal(q, s, now);
      })));
    }
    return eventos;
  }

  // ---------- queries ----------

  sucursal(s: string): Promise<Row> {
    return this.config(this.db, s);
  }

  async sucursales(): Promise<string[]> {
    return (await this.db.query("SELECT id FROM sucursal ORDER BY 1")).map((r) => r.id);
  }

  async productos(s: string, now: Date): Promise<Row[]> {
    const ids = (await this.db.query("SELECT producto_id FROM gondola_item WHERE sucursal_id = $1 ORDER BY producto_id", [s])).map((r) => r.producto_id);
    const abiertas = await this.alertas(s);
    const out: Row[] = [];
    for (const p of ids) out.push({ ...(await this.snapshot(this.db, s, p, now)), alertas: abiertas.filter((a) => a.producto_id === p) });
    return out;
  }

  async alertas(s: string, destinatario?: string | null): Promise<Row[]> {
    const rows = destinatario
      ? await this.db.query("SELECT * FROM alerta WHERE sucursal_id = $1 AND estado = 'ABIERTA' AND destinatario = $2 ORDER BY id", [s, destinatario])
      : await this.db.query("SELECT * FROM alerta WHERE sucursal_id = $1 AND estado = 'ABIERTA' ORDER BY id", [s]);
    const nombres = new Map((await this.db.query("SELECT id, nombre FROM producto")).map((r) => [r.id, r.nombre]));
    return rows.map((a) => ({ ...a, nombre: a.producto_id ? nombres.get(a.producto_id) ?? a.producto_id : null }));
  }

  /** Repositor screen: the branch config, current period, its open round and the alerts to answer. */
  async ronda(s: string, now: Date): Promise<Row> {
    const sucursal = await this.config(this.db, s);
    const alertas = await this.alertas(s, "REPOSITOR");
    return {
      sucursal,
      periodo: this.periodo(sucursal, now),
      ronda: alertas.find((a) => a.tipo === "RONDA") ?? null,
      alertas: alertas.filter((a) => a.tipo !== "RONDA"),
    };
  }
}
