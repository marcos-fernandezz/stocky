"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StockEvent } from "@/lib/realtime-client";
import { api, Dot, hhmm, NivelBar, nowIso, SucursalSelect, sucPath, useLive, useSucursal, useToast, type Alerta, type Producto } from "./shared";

const ESTADOS = ["TODOS", "VACIO", "BAJO", "SIN_DEPOSITO", "SIN_CONTEO", "OK"];

export default function Encargado() {
  const { sucursales, suc, select } = useSucursal();
  const { toast, node: toastNode } = useToast();
  const [filtro, setFiltro] = useState("TODOS");
  const [productos, setProductos] = useState<Producto[]>([]);
  const [alertas, setAlertas] = useState<Alerta[]>([]);
  const [auto, setAuto] = useState(false);
  // The auto-sale interval reads the latest list/branch without restarting.
  const latest = useRef({ productos, suc });
  latest.current = { productos, suc };

  const cargar = useCallback(async () => {
    if (!suc) return;
    try {
      const [prods, al] = await Promise.all([
        api<Producto[]>("GET", `${sucPath(suc)}/productos`),
        api<Alerta[]>("GET", `${sucPath(suc)}/alertas?destinatario=ENCARGADO`),
      ]);
      setProductos(Array.isArray(prods.data) ? prods.data : []);
      setAlertas(Array.isArray(al.data) ? al.data : []);
    } catch {}
  }, [suc]);

  const onEvent = (e: StockEvent) => {
    if (e.type === "alerta.creada" && e.data.destinatario === "ENCARGADO") toast(`Sin depósito: ${String(e.data.nombre ?? "")}`, "#6a1b9a");
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
      const vendibles = latest.current.productos.filter((p) => p.conteo_at);
      if (vendibles.length) vender(vendibles[Math.floor(Math.random() * vendibles.length)].producto_id, 1);
    }, 3000);
    return () => clearInterval(t);
  }, [auto, vender]);

  const nombres = Object.fromEntries(productos.map((p) => [p.producto_id, p.nombre]));
  const filas = productos.filter((p) => filtro === "TODOS" || p.estado === filtro);

  return (
    <>
      <header>
        <Dot on={connected} />
        <h1>Estado de sucursal</h1>
        <SucursalSelect sucursales={sucursales} value={suc} onChange={select} />
      </header>
      <main style={{ maxWidth: 1500 }}>
        <h2>Alertas para el encargado</h2>
        <div>
          {alertas.length ? alertas.map((a) => (
            <div className={`card ${a.prioridad}`} key={a.id}>
              <div className="row">
                <span><b>{nombres[a.producto_id] || a.producto_id}</b> · sin mercadería en depósito (desde {hhmm(a.creada_at)})</span>
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
                <th>Producto</th><th>Estado</th><th>Góndola</th><th>Nivel</th><th>Umbral</th><th>Venta/h</th>
                <th>Depósito</th><th>Stock general</th><th>Vendido hoy</th><th>Pérdida hoy</th><th>Último conteo</th><th>Alertas</th>
                <th>Simular caja</th>
              </tr>
            </thead>
            <tbody>
              {filas.length ? filas.map((p) => (
                <tr key={p.producto_id}>
                  <td><b>{p.nombre}</b><br /><span className="muted">{p.producto_id}</span></td>
                  <td><span className={`badge ${p.estado}`}>{p.estado.replace("_", " ")}</span></td>
                  <td>{p.stock_gondola} de {p.conteo_informado ?? "?"}</td>
                  <td style={{ minWidth: 90 }}>{p.nivel}% <NivelBar item={p} /></td>
                  <td>{p.umbral}</td>
                  <td>{p.venta_hora ?? "—"}</td>
                  <td>{p.deposito}</td>
                  <td>{p.stock_general ?? "—"}</td>
                  <td>{p.vendido_hoy}</td>
                  <td>{p.desvio_hoy || 0}</td>
                  <td>{hhmm(p.conteo_at)} {p.conteo_por ? `· ${p.conteo_por}` : ""}{p.conteo_vencido ? " ⚠️" : ""}</td>
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
                <tr><td colSpan={13} className="empty">Sin productos en este estado</td></tr>
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
