import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, NotFoundError } from "@/lib/errors";
import { Stock } from "@/lib/stock";
import { iso } from "@/lib/time";
import { at, min, testDb } from "./helpers";
import type { Db } from "@/lib/db";

// Monday. S1: 3 rounds 08-12 / 12-16 / 16-20. S2: 2 rounds 08-14 / 14-20.
const T0 = at("2026-11-16T10:00:00");
const WEEK = 7 * 86_400_000;
let db: Db;
let st: Stock;
let n = 0;

beforeEach(async () => {
  ({ db } = await testDb());
  st = new Stock(db);
  n = 0;
});

const vender = (s: string, lineas: [string, number][], t: Date, cid?: string) =>
  st.registrarVenta({
    comprobante_id: cid ?? `C${++n}`, sucursal_id: s, emitido_at: iso(t),
    lineas: lineas.map(([p, c], i) => ({ linea: i + 1, producto_id: p, cantidad: c })),
  }, t);

const reportar = (p: string, resultado: string, t: Date, s = "S1") =>
  st.reportar(s, { producto_id: p, resultado, repositor_id: "ana" }, t);

const snap = (s: string, p: string, t = T0) => st.snapshot(db, s, p, t);
const abiertas = async (s: string, p: string | null = null) =>
  Object.fromEntries((await st.alertas(s)).filter((a) => a.producto_id === p).map((a) => [a.tipo, a]));

/** `unidades[k-1]` units of ID-1 sold at 09:00 on the Monday k weeks before T0. */
async function historia(unidades: number[], p = "ID-1") {
  for (const [i, u] of unidades.entries()) {
    const t = at("2026-11-16T09:00:00");
    if (u) await vender("S1", [[p, u]], new Date(t.getTime() - (i + 1) * WEEK));
  }
}

describe("periods (S2)", () => {
  it("splits business hours into the encargado's rounds per day", async () => {
    const cfg = await st.config(db, "S1");
    expect(st.periodo(cfg, T0)).toMatchObject({ n: 1, de: 3, inicio: "2026-11-16T08:00:00", fin: "2026-11-16T12:00:00" });
    expect(st.periodo(cfg, at("2026-11-16T16:00:00"))).toMatchObject({ n: 3, inicio: "2026-11-16T16:00:00" });
    expect(st.periodo(cfg, at("2026-11-16T07:59:59"))).toBeNull();
    expect(st.periodo(cfg, at("2026-11-16T20:00:00"))).toBeNull();

    await st.configurar("S1", { pasadas_por_dia: 4 });
    const nuevo = await st.config(db, "S1");
    expect(st.periodo(nuevo, at("2026-11-16T11:30:00"))).toMatchObject({ n: 2, de: 4, inicio: "2026-11-16T11:00:00", fin: "2026-11-16T14:00:00" });
  });

  it("validates the configuration", async () => {
    for (const body of [{ pasadas_por_dia: 0 }, { pasadas_por_dia: 2.5 }, { apertura: 20, cierre: 8 }, { cierre: 25 }]) {
      await expect(st.configurar("S1", body)).rejects.toBeInstanceOf(DomainError);
    }
    await expect(st.configurar("NOPE", { pasadas_por_dia: 2 })).rejects.toBeInstanceOf(NotFoundError);
    expect(await st.configurar("S1", { apertura: 9, cierre: 21 })).toMatchObject({ pasadas_por_dia: 3, apertura: 9, cierre: 21 });
  });
});

describe("umbral = average sold per period (S4)", () => {
  it("averages the same period and weekday over 4 weeks", async () => {
    await historia([7, 6, 8, 7]);
    const s = await snap("S1", "ID-1");
    expect(s.umbral).toBe(7);
    expect(s.esperado).toBe(7); // all history sold at 09:00, before 10:00
    expect((await snap("S1", "ID-1", at("2026-11-16T08:30:00"))).esperado).toBe(0);
    expect((await snap("S1", "ID-1", at("2026-11-16T13:00:00"))).umbral).toBe(0); // nothing sold 12-16
  });

  it("skips periods with a stock-out so a quiebre does not lower it", async () => {
    await historia([6, 8, 0, 7]);
    const t = new Date(at("2026-11-16T08:30:00").getTime() - 3 * WEEK);
    await db.query("INSERT INTO vacio_periodo VALUES ('S1', 'ID-1', $1, $2)", [iso(t), iso(min(t, 120))]);
    expect((await snap("S1", "ID-1")).umbral).toBe(7);
  });

  it("is null without history", async () => {
    expect((await snap("S1", "ID-2")).umbral).toBeNull();
  });
});

describe("rounds (S3)", () => {
  it("opens one RONDA per period and closes the unfinished one", async () => {
    const t1 = at("2026-11-16T08:01:00");
    const ev = await st.tick(t1);
    expect(ev.filter((e) => e.type === "alerta.creada").map((e) => [e.sucursal_id, e.data.tipo])).toEqual([["S1", "RONDA"], ["S2", "RONDA"]]);
    expect(await st.tick(min(t1, 1))).toEqual([]);
    const r1 = (await abiertas("S1")).RONDA;
    expect([r1.destinatario, r1.producto_id]).toEqual(["REPOSITOR", null]);

    await st.tick(at("2026-11-16T12:01:00"));
    const [vieja] = await db.query("SELECT * FROM alerta WHERE id = $1", [r1.id]);
    expect([vieja.estado, vieja.motivo]).toEqual(["DESCARTADA", "pasada no realizada"]);
    const r2 = (await abiertas("S1")).RONDA;
    expect(r2.id).not.toBe(r1.id);

    // the repositor finishes it: no new round until the next period
    await st.cerrarAlerta(r2.id, { estado: "ATENDIDA", por: "ana" }, at("2026-11-16T12:30:00"));
    await st.tick(at("2026-11-16T12:40:00"));
    expect((await abiertas("S1")).RONDA).toBeUndefined();
    expect(await st.tick(at("2026-11-16T21:00:00"))).toEqual([]);
  });
});

describe("sales anomaly (S5)", () => {
  it("expected 7 shampoos and sold none: alert; sold 5: no alert", async () => {
    await historia([7, 7, 7, 7]);
    await historia([7, 7, 7, 7], "ID-2");
    await vender("S1", [["ID-2", 5]], at("2026-11-16T09:10:00"));
    const ev = await st.tick(at("2026-11-16T11:00:00"));
    const nuevas = ev.filter((e) => e.type === "alerta.creada" && e.data.tipo === "VENTA_ANOMALA");
    expect(nuevas.map((e) => [e.data.producto_id, e.data.prioridad, e.data.destinatario])).toEqual([["ID-1", "ALTA", "REPOSITOR"]]);
    expect(nuevas[0].data.nombre).toBe("Leche 1 L");
    expect((await snap("S1", "ID-1", at("2026-11-16T11:00:00"))).estado).toBe("ANOMALIA");
    // one per product per period
    await st.tick(at("2026-11-16T11:30:00"));
    expect((await db.query("SELECT COUNT(*)::int AS n FROM alerta WHERE tipo = 'VENTA_ANOMALA'"))[0].n).toBe(1);
  });

  it("selling far below the average also alerts (7 expected, 2 sold)", async () => {
    await historia([7, 7, 7, 7]);
    await vender("S1", [["ID-1", 2]], at("2026-11-16T09:10:00"));
    await st.tick(at("2026-11-16T11:00:00"));
    expect(await abiertas("S1", "ID-1")).toHaveProperty("VENTA_ANOMALA");
  });

  it("an OK answer closes it and it does not reopen in the same period", async () => {
    await historia([7, 7, 7, 7]);
    await st.tick(at("2026-11-16T11:00:00"));
    const { eventos } = await reportar("ID-1", "OK", at("2026-11-16T11:05:00"));
    expect(eventos.some((e) => e.type === "alerta.cerrada" && e.data.tipo === "VENTA_ANOMALA")).toBe(true);
    await st.tick(at("2026-11-16T11:30:00"));
    expect(await abiertas("S1", "ID-1")).toEqual({});
    expect(await db.query("SELECT * FROM vacio_periodo")).toEqual([]);
  });
});

describe("quiebre reports (S6)", () => {
  it("REPUSE records the stock-out from the last sale until now", async () => {
    await vender("S1", [["ID-1", 1]], at("2026-11-16T08:40:00"));
    await reportar("ID-1", "REPUSE", T0);
    expect(await db.query("SELECT desde, hasta FROM vacio_periodo")).toEqual([{ desde: "2026-11-16T08:40:00", hasta: "2026-11-16T10:00:00" }]);
    expect((await snap("S1", "ID-1", min(T0, 1))).estado).toBe("OK");
  });

  it("SIN_STOCK keeps it open and escalates; REPUSE closes it", async () => {
    await vender("S1", [["ID-1", 1]], at("2026-11-16T08:40:00"));
    const { eventos } = await reportar("ID-1", "SIN_STOCK", T0);
    const a = (await abiertas("S1", "ID-1")).SIN_STOCK;
    expect([a.destinatario, a.prioridad]).toEqual(["ENCARGADO", "ALTA"]);
    expect(eventos.some((e) => e.type === "alerta.creada" && e.data.tipo === "SIN_STOCK")).toBe(true);
    const s = await snap("S1", "ID-1", min(T0, 5));
    expect([s.estado, s.quiebre_desde]).toEqual(["QUIEBRE", "2026-11-16T08:40:00"]);

    await reportar("ID-1", "REPUSE", min(T0, 60));
    expect(await db.query("SELECT desde, hasta FROM vacio_periodo")).toEqual([{ desde: "2026-11-16T08:40:00", hasta: "2026-11-16T11:00:00" }]);
    expect(await abiertas("S1", "ID-1")).toEqual({});
  });

  it("a sale during an open stock-out closes it", async () => {
    await reportar("ID-1", "SIN_STOCK", T0);
    const { eventos } = await vender("S1", [["ID-1", 1]], min(T0, 30));
    expect(eventos.some((e) => e.type === "alerta.cerrada" && e.data.tipo === "SIN_STOCK")).toBe(true);
    expect(await db.query("SELECT desde, hasta FROM vacio_periodo")).toEqual([{ desde: "2026-11-16T10:00:00", hasta: "2026-11-16T10:30:00" }]);
  });

  it("a late receipt emitted before the report does not close the stock-out", async () => {
    await vender("S1", [["ID-1", 1]], at("2026-11-16T09:00:00"));
    await reportar("ID-1", "SIN_STOCK", T0);
    // buffered POS receipt: emitted 09:30, arrives 10:05
    await st.registrarVenta({ comprobante_id: "LATE", sucursal_id: "S1", emitido_at: "2026-11-16T09:30:00",
      lineas: [{ linea: 1, producto_id: "ID-1", cantidad: 1 }] }, min(T0, 5));
    expect(await db.query("SELECT desde, hasta FROM vacio_periodo")).toEqual([{ desde: "2026-11-16T09:30:00", hasta: null }]);
    expect(await abiertas("S1", "ID-1")).toHaveProperty("SIN_STOCK");
  });

  it("no anomaly alert while the stock-out is already known", async () => {
    await historia([7, 7, 7, 7]);
    await reportar("ID-1", "SIN_STOCK", at("2026-11-16T08:05:00"));
    await st.tick(at("2026-11-16T11:00:00"));
    expect(await abiertas("S1", "ID-1")).not.toHaveProperty("VENTA_ANOMALA");
  });

  it("validations", async () => {
    await expect(reportar("ID-1", "QUIZAS", T0)).rejects.toBeInstanceOf(DomainError);
    await expect(st.reportar("S1", { producto_id: "ID-1", resultado: "OK" }, T0)).rejects.toBeInstanceOf(DomainError);
    await expect(reportar("ZZZ", "OK", T0)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("sales", () => {
  it("a resent receipt is counted once", async () => {
    const a = await vender("S1", [["ID-1", 2]], T0, "X1");
    const b = await vender("S1", [["ID-1", 2]], T0, "X1");
    expect([a.status, b.status, b.result.duplicado, b.eventos]).toEqual([201, 200, true, []]);
    expect((await snap("S1", "ID-1")).vendido_hoy).toBe(2);
  });

  it("a failure mid-receipt changes nothing; the retry applies once", async () => {
    const real = Stock.prototype.insertLinea;
    const spy = vi.spyOn(Stock.prototype, "insertLinea").mockImplementation(async function (this: Stock, q, cid, l) {
      if (l.producto_id === "ID-2") throw new Error("fallo simulado");
      return real.call(this, q, cid, l);
    });
    await expect(vender("S1", [["ID-1", 1], ["ID-2", 1]], T0, "X2")).rejects.toThrow("fallo simulado");
    spy.mockRestore();
    expect(await db.query("SELECT * FROM venta WHERE comprobante_id = 'X2'")).toEqual([]);
    expect((await vender("S1", [["ID-1", 1], ["ID-2", 1]], T0, "X2")).status).toBe(201);
    await vender("S1", [["ID-1", 1], ["ID-2", 1]], T0, "X2");
    expect([(await snap("S1", "ID-1")).vendido_hoy, (await snap("S1", "ID-2")).vendido_hoy]).toEqual([1, 1]);
  });

  it("voiding a sale removes it from the figures; voiding twice is rejected", async () => {
    await vender("S1", [["ID-1", 2], ["ID-1", 1]], T0, "V1");
    expect((await snap("S1", "ID-1")).vendido_periodo).toBe(3);
    const anul = { sucursal_id: "S1", tipo: "ANULACION", comprobante_ref: "V1", emitido_at: iso(T0) };
    expect((await st.registrarVenta({ comprobante_id: "A1", ...anul }, T0)).status).toBe(201);
    expect((await snap("S1", "ID-1")).vendido_hoy).toBe(0);
    await expect(st.registrarVenta({ comprobante_id: "A2", ...anul }, T0)).rejects.toBeInstanceOf(DomainError);
  });

  it("an unknown product or branch does not reject the sale", async () => {
    expect((await vender("S9", [["ID-1", 1], ["ZZZ", 1]], T0)).status).toBe(201);
    expect((await snap("S9", "ZZZ")).vendido_hoy).toBe(1);
    expect(await st.sucursales()).toEqual(["S1", "S2", "S9"]);
  });

  it("validations", async () => {
    const casos = [
      { comprobante_id: "B1", sucursal_id: "S1", emitido_at: iso(T0), lineas: [] },
      { comprobante_id: "B2", sucursal_id: "S1", emitido_at: iso(T0), lineas: [{ linea: 1, producto_id: "ID-1", cantidad: 0 }] },
      { comprobante_id: "B3", sucursal_id: "S1", emitido_at: "ayer", lineas: [{ linea: 1, producto_id: "ID-1", cantidad: 1 }] },
      { comprobante_id: "B4", sucursal_id: "S1", tipo: "ANULACION", comprobante_ref: "NOPE", emitido_at: iso(T0) },
    ];
    for (const body of casos) await expect(st.registrarVenta(body, T0)).rejects.toBeInstanceOf(DomainError);
    expect((await db.query("SELECT COUNT(*)::int AS n FROM venta"))[0].n).toBe(0);
  });
});

describe("history seed", () => {
  it("seed_history.sql loads 4 weeks of sales that feed the period average", async () => {
    const { db: h } = await testDb(["seed.sql", "seed_history.sql"]);
    const [{ dias }] = await h.query("SELECT COUNT(DISTINCT left(emitido_at, 10))::int AS dias FROM venta");
    expect(dias).toBe(28);
    // milk sells ~2 units/h off-peak: ~8 in the 08-12 round
    const [{ hoy }] = await h.query("SELECT to_char(now() at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD') AS hoy");
    const s = await new Stock(h).snapshot(h, "S1", "ID-1", at(`${hoy}T11:59:00`));
    expect(s.umbral).toBeGreaterThan(5);
    expect(s.umbral).toBeLessThan(11);
  });
});

describe("migration 0002", () => {
  it("closes the empty-shelf periods the old estimate left open", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { readFile } = await import("node:fs/promises");
    const pg = new PGlite();
    const sql = (f: string) => readFile(`supabase/migrations/${f}`, "utf8");
    await pg.exec(await sql("0001_init.sql"));
    await pg.exec("INSERT INTO gondola_item (sucursal_id, producto_id) VALUES ('S1', 'ID-1'); INSERT INTO vacio_periodo VALUES ('S1', 'ID-1', '2026-11-10T09:00:00', NULL)");
    await pg.exec(await sql("0002_rondas.sql"));
    expect((await pg.query("SELECT COUNT(*)::int AS n FROM vacio_periodo WHERE hasta IS NULL")).rows).toEqual([{ n: 0 }]);
  });
});
