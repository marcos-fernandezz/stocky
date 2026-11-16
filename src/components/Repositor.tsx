"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { StockEvent } from "@/lib/realtime-client";
import {
  api, Dot, hhmm, load, NivelBar, nowIso, save, SucursalSelect, sucPath, useLive, useSucursal, useToast,
  type ItemReposicion, type Producto,
} from "./shared";

const PRIO_AVISO = new Set(["URGENTE", "ALTA"]);

type Conteo = {
  producto_id: string;
  unidades: number;
  repositor_id: string;
  tipo: "REPOSICION";
  created_at: string;
  confirmar_capacidad?: boolean;
};
type Pendiente = { suc: string; body: Conteo };

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
  const [items, setItems] = useState<ItemReposicion[]>([]);
  const [totalMin, setTotalMin] = useState(0);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [buscar, setBuscar] = useState("");
  const [quien, setQuien] = useState("");
  const [notif, setNotif] = useState("🔔 Activar avisos");
  const [pendientes, setPendientes] = useState("");
  const [actual, setActual] = useState<Producto | null>(null);
  const [unidades, setUnidades] = useState("");
  const dlg = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Name recorded on every count (RNF-07). No auth in the MVP.
  useEffect(() => {
    setQuien(load<string>("repositor") || "");
    if ("Notification" in window && Notification.permission === "granted") setNotif("🔔 Avisos activos");
  }, []);
  const repositor = () => quien.trim() || "repositor";

  const cargar = useCallback(async () => {
    if (!suc) return;
    try {
      const [rep, prods] = await Promise.all([
        api<{ items: ItemReposicion[]; total_minutos: number }>("GET", `${sucPath(suc)}/reposicion`),
        api<Producto[]>("GET", `${sucPath(suc)}/productos`),
      ]);
      setProductos(Array.isArray(prods.data) ? prods.data : []);
      setItems(rep.data?.items || []);
      setTotalMin(rep.data?.total_minutos ?? 0);
    } catch {} // offline: keep the last data on screen
  }, [suc]);

  // ---------- alerts (RF-04) ----------
  const avisar = (a: ItemReposicion) => {
    const texto = `${a.prioridad} · ${a.nombre} (${suc}) · quedan ${a.stock_gondola} de ${a.conteo_informado ?? "?"}` +
      (a.unidades_sugeridas ? ` · reponer ${a.unidades_sugeridas} u.` : "");
    toast(texto);
    beep();
    navigator.vibrate?.([200, 100, 200]);
    if ("Notification" in window && Notification.permission === "granted") {
      // `renotify` is valid in browsers but missing from TS's NotificationOptions.
      new Notification("Stocky · reponer", {
        body: texto, tag: `alerta-${a.id}`, renotify: true, requireInteraction: a.prioridad === "URGENTE",
      } as NotificationOptions);
    }
  };

  const onEvent = (e: StockEvent) => {
    const a = e.data as unknown as ItemReposicion;
    if (e.type === "alerta.creada" && a.destinatario === "REPOSITOR" && PRIO_AVISO.has(a.prioridad)) avisar(a);
  };

  const connected = useLive(suc, cargar, onEvent);

  // ---------- offline queue (RNF-04) ----------
  const vaciarCola = useCallback(async () => {
    const cola = load<Pendiente[]>("cola") || [];
    if (!cola.length) return;
    save("cola", []);
    for (const { suc: s, body } of cola) {
      try {
        await api("POST", `${sucPath(s)}/conteos`, { ...body, confirmar_capacidad: true });
      } catch {
        save("cola", [...(load<Pendiente[]>("cola") || []), { suc: s, body }]);
      }
    }
    setPendientes((load<Pendiente[]>("cola") || []).length ? "Conteos pendientes de envío" : "");
  }, []);

  useEffect(() => {
    if (suc) vaciarCola();
  }, [suc, vaciarCola]);
  useEffect(() => {
    addEventListener("online", vaciarCola);
    return () => removeEventListener("online", vaciarCola);
  }, [vaciarCola]);

  // ---------- count (RF-01: tap "Repuse" -> confirm number -> save) ----------
  const abrirConteo = (pid: string, sugerido: number | null) => {
    const p = productos.find((x) => x.producto_id === pid);
    if (!p) return;
    setActual(p);
    setUnidades(String(sugerido != null ? Math.min(sugerido, p.capacidad ?? sugerido) : p.stock_gondola));
    dlg.current?.showModal();
    requestAnimationFrame(() => input.current?.select());
  };

  const enviarConteo = async (body: Conteo): Promise<void> => {
    try {
      const r = await api<{ error?: string }>("POST", `${sucPath(suc)}/conteos`, body);
      if (r.status === 409 && confirm(r.data?.error || "")) return enviarConteo({ ...body, confirmar_capacidad: true });
      if (r.status >= 400) return toast(r.data?.error || "Error al guardar");
      toast(`Conteo guardado: ${body.unidades} u.`, "var(--ok)");
    } catch {
      // Offline (RNF-04): queue with the device time and retry later.
      save("cola", [...(load<Pendiente[]>("cola") || []), { suc, body }]);
      toast("Sin conexión: el conteo se enviará al reconectar", "var(--alta)");
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(unidades);
    if (unidades.trim() === "" || !Number.isInteger(n) || n < 0) return toast("Ingresá un número entero ≥ 0");
    dlg.current?.close();
    if (!actual) return;
    enviarConteo({ producto_id: actual.producto_id, unidades: n, repositor_id: repositor(), tipo: "REPOSICION", created_at: nowIso() });
  };

  const pedirAvisos = async () => {
    if (!("Notification" in window)) return toast("Este navegador no soporta notificaciones");
    const p = await Notification.requestPermission();
    setNotif(p === "granted" ? "🔔 Avisos activos" : "🔕 Avisos bloqueados");
  };

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
          <h2>Reponer ahora</h2>
          <span className="muted">{items.length ? `Total: ${totalMin} min` : ""}</span>
        </div>
        <div>
          {items.length ? items.map((i) => <Tarjeta key={i.id} i={i} onContar={abrirConteo} />) : <div className="empty">✅ Nada para reponer</div>}
        </div>
        <p className="muted">{pendientes}</p>

        <h2>Todos los productos</h2>
        <input type="search" value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar producto o código…" aria-label="Buscar producto" />
        <div style={{ marginTop: 10 }}>
          {todos.length ? todos.map((p) => (
            <div className="card" key={p.producto_id}>
              <div className="row">
                <span className="name">{p.nombre}</span>
                <span className={`badge ${p.estado}`}>{p.estado.replace("_", " ")}</span>
              </div>
              <div className="row">
                <span>{p.stock_gondola} de {p.conteo_informado ?? "?"} · {p.nivel}%</span>
                <button type="button" className="big ghost" onClick={() => abrirConteo(p.producto_id, null)}>Contar</button>
              </div>
              <NivelBar item={p} />
            </div>
          )) : <div className="empty">Sin resultados</div>}
        </div>
      </main>

      <dialog ref={dlg}>
        <form onSubmit={onSubmit}>
          <div className="name">{actual?.nombre}</div>
          <div className="muted">{actual && `Capacidad ${actual.capacidad ?? "?"} · el sistema calcula ${actual.stock_gondola}`}</div>
          <p style={{ margin: "12px 0 0" }}>¿Cuántas unidades hay ahora en la góndola?</p>
          <div className="stepper">
            <button type="button" aria-label="Restar uno" onClick={() => setUnidades((u) => String(Math.max(0, Number(u) - 1)))}>−</button>
            <input
              ref={input}
              type="number"
              min={0}
              inputMode="numeric"
              required
              aria-label="Unidades en góndola"
              value={unidades}
              onChange={(e) => setUnidades(e.target.value)}
            />
            <button type="button" aria-label="Sumar uno" onClick={() => setUnidades((u) => String(Number(u) + 1))}>+</button>
          </div>
          <div className="row">
            <button type="button" className="big ghost" onClick={() => dlg.current?.close()}>Cancelar</button>
            <button type="submit" className="big">Guardar conteo</button>
          </div>
        </form>
      </dialog>
      {toastNode}
    </>
  );
}

function Tarjeta({ i, onContar }: { i: ItemReposicion; onContar: (pid: string, sugerido: number | null) => void }) {
  const titulo = { REPONER: `Reponer ${i.unidades_sugeridas} u. · ${i.tiempo_reposicion_min} min`, VERIFICAR: "Verificar góndola", RECONTAR: "Recontar" }[
    i.tipo as "REPONER" | "VERIFICAR" | "RECONTAR"
  ];
  const vacia = i.stock_gondola === 0 ? "Góndola vacía" : i.horas_a_vacio != null ? `Se vacía en ~${i.horas_a_vacio} h` : "";
  const reponer = i.tipo === "REPONER";
  return (
    <div className={`card ${i.prioridad}`}>
      <div className="row">
        <span className="name">{i.nombre}</span>
        <span className={`badge ${i.prioridad}`}>{i.prioridad}</span>
      </div>
      <div className="row">
        <span><b>{i.stock_gondola} de {i.conteo_informado ?? "?"}</b> · {i.nivel}%</span>
        <span className="muted">{vacia}</span>
      </div>
      <NivelBar item={i} />
      <div className="row">
        <span>
          <b>{titulo}</b>
          <br />
          <span className="muted">Último conteo {hhmm(i.conteo_at)}{i.conteo_por ? ` · ${i.conteo_por}` : ""}</span>
        </span>
        <button type="button" className="big" onClick={() => onContar(i.producto_id, reponer ? i.stock_gondola + (i.unidades_sugeridas ?? 0) : null)}>
          {reponer ? "Repuse" : "Contar"}
        </button>
      </div>
    </div>
  );
}
