"use client";

import { useCallback, useEffect, useState } from "react";
import type { StockEvent } from "@/lib/realtime-client";
import {
  api, Dot, hhmm, load, periodoTexto, save, SucursalSelect, sucPath, useLive, useSucursal, useToast,
  type Alerta, type Producto, type Resultado, type Ronda,
} from "./shared";

type Reporte = { producto_id: string; resultado: Resultado; repositor_id: string };
type Pendiente = { suc: string; body: Reporte };

const TEXTO: Record<Resultado, string> = { OK: "Góndola OK", REPUSE: "Quiebre repuesto", SIN_STOCK: "Sin stock: avisamos al encargado" };

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.connect(ctx.destination);
    o.frequency.value = 880;
    o.start();
    o.stop(ctx.currentTime + 0.3);
  } catch {}
}

export default function Repositor() {
  const { sucursales, suc, select } = useSucursal();
  const { toast, node: toastNode } = useToast();
  const [ronda, setRonda] = useState<Ronda | null>(null);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [buscar, setBuscar] = useState("");
  const [quien, setQuien] = useState("");
  const [notif, setNotif] = useState("🔔 Activar avisos");
  const [pendientes, setPendientes] = useState("");

  // Name recorded on every report. No auth in the MVP.
  useEffect(() => {
    setQuien(load<string>("repositor") || "");
    if ("Notification" in window && Notification.permission === "granted") setNotif("🔔 Avisos activos");
  }, []);
  const repositor = () => quien.trim() || "repositor";

  const cargar = useCallback(async () => {
    if (!suc) return;
    try {
      const [r, prods] = await Promise.all([
        api<Ronda>("GET", `${sucPath(suc)}/ronda`),
        api<Producto[]>("GET", `${sucPath(suc)}/productos`),
      ]);
      setRonda(r.data && "sucursal" in r.data ? r.data : null);
      setProductos(Array.isArray(prods.data) ? prods.data : []);
    } catch {} // offline: keep the last data on screen
  }, [suc]);

  // ---------- notifications ----------
  const avisar = (a: Alerta) => {
    const texto = a.tipo === "RONDA" ? `Hora de la pasada (${suc})` : `Revisá la góndola: ${a.nombre ?? a.producto_id} vende menos de lo esperado`;
    toast(texto);
    beep();
    navigator.vibrate?.([200, 100, 200]);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Stocky", { body: texto, tag: `alerta-${a.id}` });
    }
  };

  const onEvent = (e: StockEvent) => {
    const a = e.data as unknown as Alerta;
    if (e.type === "alerta.creada" && a.destinatario === "REPOSITOR") avisar(a);
  };

  const connected = useLive(suc, cargar, onEvent);

  // ---------- offline queue ----------
  const vaciarCola = useCallback(async () => {
    const cola = load<Pendiente[]>("cola-reportes") || [];
    if (!cola.length) return;
    save("cola-reportes", []);
    for (const { suc: s, body } of cola) {
      try {
        await api("POST", `${sucPath(s)}/reportes`, body);
      } catch {
        save("cola-reportes", [...(load<Pendiente[]>("cola-reportes") || []), { suc: s, body }]);
      }
    }
    setPendientes((load<Pendiente[]>("cola-reportes") || []).length ? "Reportes pendientes de envío" : "");
  }, []);

  useEffect(() => {
    if (suc) vaciarCola();
  }, [suc, vaciarCola]);
  useEffect(() => {
    addEventListener("online", vaciarCola);
    return () => removeEventListener("online", vaciarCola);
  }, [vaciarCola]);

  // ---------- actions ----------
  const reportar = async (producto_id: string, resultado: Resultado) => {
    const body: Reporte = { producto_id, resultado, repositor_id: repositor() };
    try {
      const r = await api<{ error?: string }>("POST", `${sucPath(suc)}/reportes`, body);
      if (r.status >= 400) return toast(r.data?.error || "Error al guardar");
      toast(TEXTO[resultado], resultado === "SIN_STOCK" ? "var(--alta)" : "var(--ok)");
      cargar();
    } catch {
      save("cola-reportes", [...(load<Pendiente[]>("cola-reportes") || []), { suc, body }]);
      setPendientes("Reportes pendientes de envío");
      toast("Sin conexión: el reporte se enviará al reconectar", "var(--alta)");
    }
  };

  const terminarPasada = async (id: Alerta["id"]) => {
    try {
      const r = await api<{ error?: string }>("PATCH", `/api/alertas/${id}`, { estado: "ATENDIDA", por: repositor() });
      if (r.status >= 400) return toast(r.data?.error || "Error");
      toast("Pasada registrada", "var(--ok)");
      cargar();
    } catch {
      toast("Sin conexión", "var(--alta)");
    }
  };

  const pedirAvisos = async () => {
    if (!("Notification" in window)) return toast("Este navegador no soporta notificaciones");
    const p = await Notification.requestPermission();
    setNotif(p === "granted" ? "🔔 Avisos activos" : "🔕 Avisos bloqueados");
  };

  const porId = Object.fromEntries(productos.map((p) => [p.producto_id, p]));
  const f = buscar.trim().toLowerCase();
  const todos = productos.filter((p) => !f || p.nombre.toLowerCase().includes(f) || p.producto_id.toLowerCase().includes(f));

  return (
    <>
      <header>
        <Dot on={connected} />
        <h1>Reposición</h1>
        <SucursalSelect sucursales={sucursales} value={suc} onChange={select} />
        <input
          value={quien}
          onChange={(e) => setQuien(e.target.value)}
          onBlur={() => save("repositor", quien.trim())}
          placeholder="Tu nombre"
          aria-label="Tu nombre"
          style={{ font: "inherit", padding: "6px 10px", borderRadius: 8, border: 0, width: 130 }}
        />
        <button type="button" onClick={pedirAvisos}>{notif}</button>
      </header>
      <main>
        <div className="row">
          <h2>{periodoTexto(ronda?.periodo ?? null)}</h2>
        </div>
        {ronda?.ronda ? (
          <div className="card MEDIA">
            <div className="row">
              <span>
                <b>Hacé la pasada</b>
                <br />
                <span className="muted">Dejá en cada góndola al menos lo que se vende en este período y marcá los quiebres que encuentres.</span>
              </span>
              <button type="button" className="big" onClick={() => terminarPasada(ronda.ronda!.id)}>Terminé la pasada</button>
            </div>
          </div>
        ) : ronda?.periodo ? <div className="empty">✅ Pasada hecha</div> : null}

        <h2>Revisar góndola</h2>
        <div>
          {ronda?.alertas.length ? ronda.alertas.map((a) => {
            const p = a.producto_id ? porId[a.producto_id] : undefined;
            return (
              <div className={`card ${a.prioridad}`} key={a.id}>
                <div className="row">
                  <span className="name">{a.nombre ?? a.producto_id}</span>
                  <span className={`badge ${a.prioridad}`}>{a.prioridad}</span>
                </div>
                <p className="muted" style={{ margin: "4px 0" }}>
                  Vende menos de lo esperado{p ? `: se esperaban ~${p.esperado ?? "?"} y se vendieron ${p.vendido_periodo}` : ""} (desde {hhmm(a.creada_at)})
                </p>
                <Acciones pid={a.producto_id!} ok onReportar={reportar} />
              </div>
            );
          }) : <div className="empty">✅ Nada para revisar</div>}
        </div>
        <p className="muted">{pendientes}</p>

        <h2>Todos los productos</h2>
        <input type="search" value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar producto o código…" aria-label="Buscar producto" />
        <div style={{ marginTop: 10 }}>
          {todos.length ? todos.map((p) => (
            <div className="card" key={p.producto_id}>
              <div className="row">
                <span className="name">{p.nombre}</span>
                <span className={`badge ${p.estado}`}>{p.estado}</span>
              </div>
              <div className="row">
                <span>
                  {p.umbral != null ? <>Dejá al menos <b>{Math.ceil(p.umbral)}</b> · </> : null}
                  vendidos {p.vendido_periodo}{p.umbral != null ? ` de ~${p.umbral}` : ""}
                  {p.quiebre_desde ? <span className="muted"> · sin stock desde {hhmm(p.quiebre_desde)}</span> : null}
                </span>
              </div>
              {p.estado === "QUIEBRE" ? (
                <div className="row"><span /><button type="button" className="big" onClick={() => reportar(p.producto_id, "REPUSE")}>Repuse</button></div>
              ) : (
                <Acciones pid={p.producto_id} onReportar={reportar} />
              )}
            </div>
          )) : <div className="empty">Sin resultados</div>}
        </div>
      </main>
      {toastNode}
    </>
  );
}

function Acciones({ pid, ok, onReportar }: { pid: string; ok?: boolean; onReportar: (pid: string, r: Resultado) => void }) {
  return (
    <div className="row" style={{ justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
      {ok ? <button type="button" className="big ghost" onClick={() => onReportar(pid, "OK")}>Estaba OK</button> : null}
      <button type="button" className="big ghost" onClick={() => onReportar(pid, "REPUSE")}>Vacía · repuse</button>
      <button type="button" className="big ghost" onClick={() => onReportar(pid, "SIN_STOCK")}>Sin stock</button>
    </div>
  );
}
