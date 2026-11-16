import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, DomainError } from "@/lib/errors";
import { Stock } from "@/lib/stock";
import { iso } from "@/lib/time";
import { at, min, testDb } from "./helpers";
import type { Db } from "@/lib/db";

const T0 = at("2026-11-16T10:00:00");
let db: Db;
let st: Stock;
let n = 0;

beforeEach(async () => {
  ({ db } = await testDb());
  st = new Stock(db);
  n = 0;
});

const contar = (s: string, p: string, unidades: unknown, t = T0, extra = {}) =>
  st.registrarConteo(s, { producto_id: p, unidades, repositor_id: "ana", ...extra }, t);

const vender = (s: string, lineas: [string, number][], t: Date, cid?: string) =>
  st.registrarVenta({
    comprobante_id: cid ?? `C${++n}`, sucursal_id: s, emitido_at: iso(t),
    lineas: lineas.map(([p, c], i) => ({ linea: i + 1, producto_id: p, cantidad: c })),
  }, t);

const snap = (s: string, p: string, t = T0) => st.snapshot(db, s, p, t);
const abiertas = async (s: string, p: string) =>
  Object.fromEntries((await st.alertas(s)).filter((a) => a.producto_id === p).map((a) => [a.tipo, a]));

describe("spec-00 §12 acceptance (demo)", () => {
  it("1-4: full cycle on S1 milk", async () => {
    // 1. count 12 -> 12 of 12 (100%)
    await contar("S1", "ID-1", 12);
    let s = await snap("S1", "ID-1");
    expect([s.stock_gondola, s.conteo_informado, s.nivel, s.estado]).toEqual([12, 12, 100, "OK"]);
    expect(s.umbral).toBe(3); // no history: max(2, ceil(12 * 0.25))

    // 2. nine sales of 1 -> 3 of 12, BAJO, REPONER ALTA notified once
    const creadas = [];
    for (let i = 0; i < 9; i++) {
      const { eventos } = await vender("S1", [["ID-1", 1]], min(T0, i + 1));
      creadas.push(...eventos.filter((e) => e.type === "alerta.creada"));
    }
    s = await snap("S1", "ID-1", min(T0, 10));
    expect([s.stock_gondola, s.nivel, s.estado]).toEqual([3, 25, "BAJO"]);
    expect(creadas).toHaveLength(1);
    expect([creadas[0].data.tipo, creadas[0].data.prioridad, creadas[0].data.unidades_sugeridas]).toEqual(["REPONER", "ALTA", 9]);
    expect(creadas[0].data.nombre).toBe("Leche 1 L");

    // 3. three more -> 0 of 12, escalates to URGENTE and notifies again
    const ev = [];
    for (let i = 0; i < 3; i++) ev.push(...(await vender("S1", [["ID-1", 1]], min(T0, 20 + i))).eventos);
    const escaladas = ev.filter((e) => e.type === "alerta.creada");
    expect(escaladas).toHaveLength(1);
    expect(escaladas[0].data.escalada).toBe(true);
    expect((await abiertas("S1", "ID-1")).REPONER.prioridad).toBe("URGENTE");
    expect((await snap("S1", "ID-1", min(T0, 23))).estado).toBe("VACIO");

    // 4. recount 12 -> alert closed by the repositor, 100%, diferencia +12
    const t4 = min(T0, 30);
    const { result } = await contar("S1", "ID-1", 12, t4);
    expect([result.esperado, result.diferencia]).toEqual([0, 12]);
    expect(await abiertas("S1", "ID-1")).toEqual({});
    const [cerrada] = await db.query("SELECT * FROM alerta WHERE tipo = 'REPONER'");
    expect([cerrada.estado, cerrada.atendida_por]).toEqual(["ATENDIDA", "ana"]);
    expect((await snap("S1", "ID-1", t4)).nivel).toBe(100);
    const [periodo] = await db.query("SELECT * FROM vacio_periodo");
    expect([periodo.desde, periodo.hasta]).toEqual([iso(min(T0, 22)), iso(t4)]);
  });

  it("5: a resent receipt is not deducted twice", async () => {
    await contar("S1", "ID-1", 12);
    const a = await vender("S1", [["ID-1", 2]], min(T0, 1), "X1");
    const b = await vender("S1", [["ID-1", 2]], min(T0, 1), "X1");
    expect([a.status, b.status, b.result.duplicado, b.eventos]).toEqual([201, 200, true, []]);
    expect((await snap("S1", "ID-1", min(T0, 2))).stock_gondola).toBe(10);
  });

  it("6: a failure mid-receipt changes nothing; the retry applies once", async () => {
    await contar("S1", "ID-1", 12);
    await contar("S1", "ID-2", 15);
    const t = min(T0, 1);
    const real = Stock.prototype.insertLinea;
    const spy = vi.spyOn(Stock.prototype, "insertLinea").mockImplementation(async function (this: Stock, q, cid, l) {
      if (l.producto_id === "ID-2") throw new Error("fallo simulado");
      return real.call(this, q, cid, l);
    });
    await expect(vender("S1", [["ID-1", 1], ["ID-2", 1]], t, "X2")).rejects.toThrow("fallo simulado");
    spy.mockRestore();
    expect((await snap("S1", "ID-1", t)).stock_gondola).toBe(12);
    expect(await db.query("SELECT * FROM venta WHERE comprobante_id = 'X2'")).toEqual([]);

    const { status } = await vender("S1", [["ID-1", 1], ["ID-2", 1]], t, "X2");
    await vender("S1", [["ID-1", 1], ["ID-2", 1]], t, "X2");
    expect(status).toBe(201);
    expect((await snap("S1", "ID-1", t)).stock_gondola).toBe(11);
    expect((await snap("S1", "ID-2", t)).stock_gondola).toBe(14);
  });

  it("7: voiding a sale returns the units", async () => {
    await contar("S1", "ID-1", 12);
    const t = min(T0, 1);
    await vender("S1", [["ID-1", 2]], t, "V1");
    expect((await snap("S1", "ID-1", t)).stock_gondola).toBe(10);
    const { status } = await st.registrarVenta({ comprobante_id: "A1", sucursal_id: "S1", tipo: "ANULACION",
      comprobante_ref: "V1", emitido_at: iso(min(t, 1)) }, min(t, 1));
    expect(status).toBe(201);
    expect((await snap("S1", "ID-1", min(t, 1))).stock_gondola).toBe(12);
  });

  it("8: S2 without stock room alerts the manager, not the repositor", async () => {
    for (let i = 0; i < 12; i++) await vender("S2", [["ID-1", 1]], min(T0, i));
    await contar("S2", "ID-1", 3, min(T0, 30));
    const s = await snap("S2", "ID-1", min(T0, 30));
    expect([s.deposito, s.stock_gondola, s.estado]).toEqual([0, 3, "SIN_DEPOSITO"]);
    const a = await abiertas("S2", "ID-1");
    expect(a.SIN_DEPOSITO.destinatario).toBe("ENCARGADO");
    expect(a.REPONER).toBeUndefined();
    expect((await st.reposicion("S2", min(T0, 30))).items).toEqual([]);
  });

  it("9: a sale with no prior count asks for a recount", async () => {
    await vender("S1", [["ID-4", 1]], T0);
    expect((await snap("S1", "ID-4")).estado).toBe("SIN_CONTEO");
    expect((await abiertas("S1", "ID-4")).RECONTAR.prioridad).toBe("BAJA");
  });
});

describe("counts (RF-01)", () => {
  it("over capacity needs confirmation", async () => {
    await expect(contar("S1", "ID-1", 13)).rejects.toBeInstanceOf(ConflictError);
    expect((await contar("S1", "ID-1", 13, T0, { confirmar_capacidad: true })).result.aplicado).toBe(true);
  });

  it("rejects negative and non-integer values", async () => {
    for (const malo of [-1, "5", 2.5, true, null]) await expect(contar("S1", "ID-1", malo)).rejects.toBeInstanceOf(DomainError);
  });

  it("an older offline count does not override the newer one", async () => {
    await contar("S1", "ID-1", 10, T0);
    const { result } = await contar("S1", "ID-1", 4, min(T0, 5), { created_at: iso(min(T0, -5)) });
    expect(result.aplicado).toBe(false);
    expect((await snap("S1", "ID-1", min(T0, 5))).stock_gondola).toBe(10);
    expect((await db.query("SELECT COUNT(*)::int AS n FROM conteo"))[0].n).toBe(2);
  });

  it("a count closes VERIFICAR and RECONTAR", async () => {
    await vender("S1", [["ID-1", 1]], T0);
    await contar("S1", "ID-1", 1, min(T0, 1));
    await vender("S1", [["ID-1", 3]], min(T0, 2));
    expect(await abiertas("S1", "ID-1")).toHaveProperty("VERIFICAR");
    await contar("S1", "ID-1", 8, min(T0, 3));
    expect(await abiertas("S1", "ID-1")).toEqual({});
  });

  it("device times with an offset are converted to business time", async () => {
    await contar("S1", "ID-1", 5, T0, { created_at: "2026-11-16T12:59:00Z" }); // 09:59 in Buenos Aires
    expect((await snap("S1", "ID-1")).conteo_at).toBe("2026-11-16T09:59:00");
  });
});

describe("sales (RF-02)", () => {
  it("a sale emitted before the count does not deduct", async () => {
    await contar("S1", "ID-1", 12, T0);
    await vender("S1", [["ID-1", 2]], min(T0, -5));
    expect((await snap("S1", "ID-1")).stock_gondola).toBe(12);
  });

  it("a same-second sale deducts", async () => {
    await contar("S1", "ID-1", 12, T0);
    await vender("S1", [["ID-1", 2]], T0);
    expect((await snap("S1", "ID-1")).stock_gondola).toBe(10);
  });

  it("selling more than counted stays at 0 with desvío", async () => {
    await contar("S1", "ID-1", 2);
    const { status } = await vender("S1", [["ID-1", 5]], min(T0, 1));
    const s = await snap("S1", "ID-1", min(T0, 1));
    expect([status, s.stock_gondola, s.desvio]).toEqual([201, 0, 3]);
    expect(await abiertas("S1", "ID-1")).toHaveProperty("VERIFICAR");
  });

  it("repeated lines are summed", async () => {
    await contar("S1", "ID-1", 12);
    await vender("S1", [["ID-1", 1], ["ID-1", 2]], min(T0, 1));
    expect((await snap("S1", "ID-1", min(T0, 1))).stock_gondola).toBe(9);
  });

  it("an unknown product does not reject the sale", async () => {
    await contar("S1", "ID-1", 12);
    const { status } = await vender("S1", [["ID-1", 1], ["ZZZ", 1]], min(T0, 1));
    expect(status).toBe(201);
    expect((await snap("S1", "ZZZ", min(T0, 1))).estado).toBe("SIN_CONTEO");
    expect((await snap("S1", "ID-1", min(T0, 1))).stock_gondola).toBe(11);
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

  it("voiding twice is rejected", async () => {
    await vender("S1", [["ID-1", 1]], T0, "V1");
    const anul = { sucursal_id: "S1", tipo: "ANULACION", comprobante_ref: "V1", emitido_at: iso(T0) };
    await st.registrarVenta({ comprobante_id: "A1", ...anul }, T0);
    await expect(st.registrarVenta({ comprobante_id: "A2", ...anul }, T0)).rejects.toBeInstanceOf(DomainError);
  });
});

describe("threshold (§6) and periodic checks", () => {
  it("uses 4 weeks of history and skips empty-shelf hours", async () => {
    const now = at("2026-11-16T18:30:00");
    for (const [k, unidades] of [[1, 4], [2, 4], [3, 4], [4, 0]]) {
      const t = new Date(now.getTime() - k * 7 * 86_400_000 - 20 * 60_000); // 18:10
      for (let i = 0; i < unidades; i++) await vender("S1", [["ID-1", 1]], min(t, i));
    }
    const vacio = new Date(now.getTime() - 4 * 7 * 86_400_000 - 30 * 60_000); // 18:00, 4 weeks ago
    await db.query("INSERT INTO vacio_periodo VALUES ('S1', 'ID-1', $1, $2)", [iso(vacio), iso(min(vacio, 60))]);
    expect(await st.ventaHoraFranja(db, "S1", "ID-1", now)).toBe(4);
    await contar("S1", "ID-1", 12, now);
    // 4.0 * (0.5 h + 6/60 h) + 1 = 3.4 -> 4
    expect((await snap("S1", "ID-1", now)).umbral).toBe(4);
  });

  it("an improbable silence asks to verify the shelf (R3)", async () => {
    const now = at("2026-11-16T18:00:00");
    for (let k = 1; k <= 4; k++) {
      const t = new Date(now.getTime() - k * 7 * 86_400_000);
      for (let i = 0; i < 4; i++) await vender("S1", [["ID-1", 1]], min(t, 10 * i));
    }
    await contar("S1", "ID-1", 12, now);
    await st.tick(min(now, 30)); // e^(-4 * 0.5) = 0.13: still plausible
    expect(await abiertas("S1", "ID-1")).not.toHaveProperty("VERIFICAR");
    await st.tick(min(now, 50)); // e^(-4 * 0.83) = 0.036 < 0.05
    expect(await abiertas("S1", "ID-1")).toHaveProperty("VERIFICAR");
  });

  it("a count older than 24 h asks for a recount", async () => {
    await contar("S1", "ID-1", 12);
    await st.tick(min(T0, 25 * 60));
    expect(await abiertas("S1", "ID-1")).toHaveProperty("RECONTAR");
  });
});

describe("work list (RF-05)", () => {
  it("is prioritized and adds up the minutes", async () => {
    const t = min(T0, 5);
    await contar("S1", "ID-4", 1);
    await contar("S1", "ID-3", 3);
    await contar("S1", "ID-1", 12);
    await vender("S1", [["ID-4", 1]], t);
    const lista = await st.reposicion("S1", t);
    expect(lista.items.map((i) => [i.producto_id, i.prioridad])).toEqual([["ID-4", "URGENTE"], ["ID-3", "ALTA"]]);
    expect(lista.total_minutos).toBe(5 + 6);
    expect(new Set(lista.items.map((i) => i.estado))).toEqual(new Set(["ABIERTA"]));
  });
});

describe("history seed", () => {
  it("seed_history.sql loads 4 weeks of sales that feed the hour-slot rate", async () => {
    const { db: h } = await testDb(["seed.sql", "seed_history.sql"]);
    const [{ n }] = await h.query("SELECT COUNT(*)::int AS n FROM venta_linea l JOIN venta v USING (comprobante_id)");
    expect(n).toBeGreaterThan(500);
    const [{ dias }] = await h.query("SELECT COUNT(DISTINCT left(emitido_at, 10))::int AS dias FROM venta");
    expect(dias).toBe(28);
    // every product sells in (almost) every hour slot: one random draw per unit, not per hour
    const horas = await h.query(`SELECT l.producto_id, COUNT(DISTINCT substr(emitido_at, 12, 2))::int AS n
      FROM venta v JOIN venta_linea l USING (comprobante_id) WHERE v.sucursal_id = 'S1' GROUP BY 1`);
    for (const r of horas) expect(r.n).toBeGreaterThanOrEqual(10);
    // milk averages ~2 units/h off-peak
    const [{ avg }] = await h.query(`SELECT (COUNT(*)::float8 / (28 * 10)) AS avg FROM venta v JOIN venta_linea l USING (comprobante_id)
      WHERE v.sucursal_id = 'S1' AND l.producto_id = 'ID-1' AND substr(emitido_at, 12, 2) < '18'`);
    expect(avg).toBeGreaterThan(1.6);
    expect(avg).toBeLessThan(2.4);
  });
});
