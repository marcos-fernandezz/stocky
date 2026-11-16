"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { StockEvent } from "@/lib/realtime-client";
import {
  api, Dot, hhmm, nowIso, periodoTexto, SucursalSelect, sucPath, useLive, useSucursal, useToast, type Alerta, type Producto, type Sucursal,
} from "./shared";

const ESTADOS = ["TODOS", "QUIEBRE", "ANOMALIA", "OK"];

export default function Encargado() {
  const { sucursales, suc, select } = useSucursal();
  const { toast, node: toastNode } = useToast();
  const [filtro, setFiltro] = useState("TODOS");
  const [productos, setProductos] = useState<Producto[]>([]);
  const [alertas, setAlertas] = useState<Alerta[]>([]);
  const [auto, setAuto] = useState(false);
  const [cfg, setCfg] = useState<Sucursal | null>(null);
  // The auto-sale interval reads the latest list/branch without restarting.
  const latest = useRef({ productos, suc });
  latest.current = { productos, suc };

  const cargar = useCallback(async () => {
    if (!suc) return;
    try {
      const [prods, al, c] = await Promise.all([
        api<Producto[]>("GET", `${sucPath(suc)}/productos`),
        api<Alerta[]>("GET", `${sucPath(suc)}/alertas?destinatario=ENCARGADO`),
        api<Sucursal>("GET", sucPath(suc)),
      ]);
      setCfg((prev) => prev?.id === c.data?.id ? prev : c.data); // do not overwrite a half-edited form
      setProductos(Array.isArray(prods.data) ? prods.data : []);
      setAlertas(Array.isArray(al.data) ? al.data : []);
    } catch {}
  }, [suc]);

  const onEvent = (e: StockEvent) => {
    if (e.type === "alerta.creada" && e.data.destinatario === "ENCARGADO") toast(`Sin stock: ${String(e.data.nombre ?? "")}`, "#6a1b9a");
  };
  const connected = useLive(suc, cargar, onEvent);

  const vender = useCallback(
    async (pid: string, n: number) => {
      const cid = `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        const r = await api<{ error?: string }>("POST", "/api/ventas", {
          comprobante_id: cid, sucursal_id: latest.current.suc, emitido_at: nowIso(),
          lineas: [{ linea: 1, producto_id: pid, cantidad: n }],
        });
        if (r.status >= 400) toast(r.data?.error || "Error");
      } catch {
        toast("Error");
      }
    },
    [toast],
  );

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => {
      const vendibles = latest.current.productos;
      if (vendibles.length) vender(vendibles[Math.floor(Math.random() * vendibles.length)].producto_id, 1);
    }, 3000);
    return () => clearInterval(t);
  }, [auto, vender]);

  const guardarCfg = async (e: FormEvent) => {
    e.preventDefault();
    if (!cfg) return;
    const { pasadas_por_dia, apertura, cierre } = cfg;
    try {
      const r = await api<Sucursal & { error?: string }>("PATCH", sucPath(suc), { pasadas_por_dia, apertura, cierre });
      if (r.status >= 400) return toast(r.data?.error || "Error");
      setCfg(r.data);
      toast("Configuración guardada", "var(--ok)");
      cargar();
    } catch {
      toast("Sin conexión");
    }
  };

  const filas = productos.filter((p) => filtro === "TODOS" || p.estado === filtro);

  return (
    <>
      <header>
        <Dot on={connected} />
        <h1>Estado de sucursal</h1>
        <SucursalSelect sucursales={sucursales} value={suc} onChange={select} />
      </header>
      <main style={{ maxWidth: 1500 }}>
        <h2>Pasadas por día</h2>
        {cfg ? (
          <form className="row" style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap" }} onSubmit={guardarCfg}>
            <label>Pasadas <input type="number" min={1} max={24} required value={cfg.pasadas_por_dia}
              onChange={(e) => setCfg({ ...cfg, pasadas_por_dia: Number(e.target.value) })} style={{ width: 60 }} /></label>
            <label>de <input type="number" min={0} max={23} required value={cfg.apertura}
              onChange={(e) => setCfg({ ...cfg, apertura: Number(e.target.value) })} style={{ width: 60 }} /> h</label>
            <label>a <input type="number" min={1} max={24} required value={cfg.cierre}
              onChange={(e) => setCfg({ ...cfg, cierre: Number(e.target.value) })} style={{ width: 60 }} /> h</label>
            <button type="submit">Guardar</button>
            <span className="muted">{periodoTexto(productos[0]?.periodo ?? null)}</span>
          </form>
        ) : null}

        <h2>Alertas para el encargado</h2>
        <div>
          {alertas.length ? alertas.map((a) => (
            <div className={`card ${a.prioridad}`} key={a.id}>
              <div className="row">
                <span><b>{a.nombre ?? a.producto_id}</b> · sin mercadería: el repositor no pudo reponer (desde {hhmm(a.creada_at)})</span>
                <span className={`badge ${a.prioridad}`}>{a.tipo.replace("_", " ")}</span>
              </div>
            </div>
          )) : <div className="empty">Sin alertas</div>}
        </div>

        <h2>Productos</h2>
        <div className="chips">
          {ESTADOS.map((e) => (
            <button type="button" key={e} className={e === filtro ? "on" : ""} aria-pressed={e === filtro} onClick={() => setFiltro(e)}>
              {e.replace("_", " ")}
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Producto</th><th>Estado</th><th>Umbral del período</th><th>Esperado hasta ahora</th><th>Vendido en el período</th>
                <th>Vendido hoy</th><th>Última venta</th><th>Sin stock desde</th><th>Alertas</th>
                <th>Simular caja</th>
              </tr>
            </thead>
            <tbody>
              {filas.length ? filas.map((p) => (
                <tr key={p.producto_id}>
                  <td><b>{p.nombre}</b><br /><span className="muted">{p.producto_id}</span></td>
                  <td><span className={`badge ${p.estado}`}>{p.estado.replace("_", " ")}</span></td>
                  <td>{p.umbral ?? "—"}</td>
                  <td>{p.esperado ?? "—"}</td>
                  <td>{p.vendido_periodo}</td>
                  <td>{p.vendido_hoy}</td>
                  <td>{hhmm(p.ultima_venta_at)}</td>
                  <td>{hhmm(p.quiebre_desde)}</td>
                  <td>
                    {p.alertas.map((a) => (
                      <span key={a.id}><span className={`badge ${a.prioridad}`}>{a.tipo}</span> </span>
                    ))}
                  </td>
                  <td>
                    <button type="button" onClick={() => vender(p.producto_id, 1)}>−1</button>{" "}
                    <button type="button" onClick={() => vender(p.producto_id, 3)}>−3</button>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={10} className="empty">Sin productos en este estado</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <h2>Simulador de caja</h2>
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button className="big" type="button" onClick={() => setAuto((a) => !a)}>{auto ? "⏸ Detener" : "▶ Venta automática"}</button>
          <span className="muted">Emite un comprobante al azar cada 3 s (reemplaza al POS en la demo).</span>
        </div>
      </main>
      {toastNode}
    </>
  );
}
