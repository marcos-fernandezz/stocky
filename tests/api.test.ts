import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db";
import { testDb } from "./helpers";

let db: Db;
const published: unknown[] = [];

vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), getDb: () => db }));
vi.mock("@/lib/realtime", () => ({ publish: async (ev: unknown[]) => void published.push(...ev) }));

const { POST: postConteo } = await import("@/app/api/sucursales/[s]/conteos/route");
const { GET: getProductos } = await import("@/app/api/sucursales/[s]/productos/route");
const { GET: getReposicion } = await import("@/app/api/sucursales/[s]/reposicion/route");
const { GET: getAlertas } = await import("@/app/api/sucursales/[s]/alertas/route");
const { GET: getSucursales } = await import("@/app/api/sucursales/route");
const { POST: postVenta } = await import("@/app/api/ventas/route");
const { PATCH: patchAlerta } = await import("@/app/api/alertas/[id]/route");
const { GET: tick } = await import("@/app/api/cron/tick/route");

const req = (body?: unknown, url = "http://x/", headers: Record<string, string> = {}) =>
  new Request(url, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers });
const ctx = <T>(p: T) => ({ params: Promise.resolve(p) });
const json = async (r: Response) => [r.status, await r.json()] as const;
const now = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 19); // Buenos Aires = UTC-3

const venta = (cid: string, cantidad = 1) => postVenta(req({
  comprobante_id: cid, sucursal_id: "S1", emitido_at: now(), lineas: [{ linea: 1, producto_id: "ID-1", cantidad }],
}));

beforeEach(async () => {
  ({ db } = await testDb());
  published.length = 0;
});

describe("route handlers", () => {
  it("count, sale, duplicate and state", async () => {
    const [st] = await json(await postConteo(req({ producto_id: "ID-1", unidades: 12, repositor_id: "ana" }), ctx({ s: "S1" })));
    expect(st).toBe(201);
    expect((await venta("C1", 10)).status).toBe(201);
    const [st2, dup] = await json(await venta("C1", 10));
    expect([st2, dup.duplicado]).toEqual([200, true]);
    const [, productos] = await json(await getProductos(req(), ctx({ s: "S1" })));
    const leche = productos.find((p: any) => p.producto_id === "ID-1");
    expect([leche.stock_gondola, leche.nivel, leche.estado]).toEqual([2, 17, "BAJO"]);
    const [, lista] = await json(await getReposicion(req(), ctx({ s: "S1" })));
    expect([lista.items[0].producto_id, lista.items[0].tipo]).toEqual(["ID-1", "REPONER"]);
    expect(published.some((e: any) => e.type === "alerta.creada" && e.data.prioridad === "ALTA")).toBe(true);
    expect((await json(await getSucursales()))[1]).toEqual(["S1", "S2"]);
  });

  it("errors map to status codes", async () => {
    const [st, err] = await json(await postConteo(req({ producto_id: "ID-1", unidades: 99, repositor_id: "a" }), ctx({ s: "S1" })));
    expect(st).toBe(409);
    expect(err.error).toContain("capacidad de 12");
    expect((await postVenta(req({ comprobante_id: "X" }))).status).toBe(422);
    expect((await postVenta(new Request("http://x/", { method: "POST", body: "{nope" }))).status).toBe(422);
    expect((await postVenta(new Request("http://x/", { method: "POST", body: " ".repeat(1_000_001) }))).status).toBe(422);
    expect((await patchAlerta(req({ motivo: "x" }), ctx({ id: "999" }))).status).toBe(404);
    expect((await patchAlerta(req({ motivo: "x" }), ctx({ id: "abc" }))).status).toBe(404);
  });

  it("dismissing an alert needs a reason and only works once", async () => {
    await venta("C1"); // no count -> RECONTAR
    const [, alertas] = await json(await getAlertas(req(undefined, "http://x/?destinatario=REPOSITOR"), ctx({ s: "S1" })));
    const id = String(alertas[0].id);
    expect((await patchAlerta(req({}), ctx({ id }))).status).toBe(422);
    expect((await patchAlerta(req({ motivo: "producto discontinuado" }), ctx({ id }))).status).toBe(200);
    expect((await patchAlerta(req({ motivo: "otra vez" }), ctx({ id }))).status).toBe(409);
  });

  it("cron tick requires the secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await tick(req())).status).toBe(401);
    expect((await tick(req(undefined, "http://x/", { authorization: "Bearer wrong!" }))).status).toBe(401);
    expect((await tick(req(undefined, "http://x/", { authorization: "Bearer s3cret" }))).status).toBe(200);
    vi.unstubAllEnvs();
    expect((await tick(req(undefined, "http://x/", { authorization: "Bearer undefined" }))).status).toBe(401);
  });
});
