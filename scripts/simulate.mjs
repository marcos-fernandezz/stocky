// POS simulator: sends random receipts to POST /api/ventas (spec-00 §10).
// Usage: npm run simulate -- --url https://<app>.vercel.app --sucursal S1 --cada 2 --n 20
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:3000" },
    sucursal: { type: "string", default: "S1" },
    cada: { type: "string", default: "2" },
    n: { type: "string", default: "0" },
  },
});

const PESOS = { "ID-1": 2.0, "ID-2": 1.0, "ID-3": 1.5, "ID-4": 0.5 }; // units/hour in the demo seed
const productos = a.sucursal === "S2" ? ["ID-1"] : Object.keys(PESOS);
const total = productos.reduce((t, p) => t + PESOS[p], 0);
const elegir = () => {
  let r = Math.random() * total;
  return productos.find((p) => (r -= PESOS[p]) <= 0) ?? productos[0];
};
const ahora = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 19); // Buenos Aires (UTC-3, no DST)

for (let i = 0; !Number(a.n) || i < Number(a.n); i++) {
  const elegidos = [...new Set(Array.from({ length: 1 + Math.floor(Math.random() * 3) }, elegir))].sort();
  const body = {
    comprobante_id: `SIM-${randomUUID().slice(0, 10)}`, sucursal_id: a.sucursal, emitido_at: ahora(),
    lineas: elegidos.map((producto_id, j) => ({ linea: j + 1, producto_id, cantidad: 1 })),
  };
  const r = await fetch(`${a.url}/api/ventas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  console.log(r.status, body.comprobante_id, elegidos.join(", "));
  await new Promise((ok) => setTimeout(ok, Number(a.cada) * 1000));
}
