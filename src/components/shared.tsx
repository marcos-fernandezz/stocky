"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeSucursal, type StockEvent } from "@/lib/realtime-client";

export type Alerta = {
  id: number | string;
  sucursal_id: string;
  producto_id: string;
  tipo: "REPONER" | "SIN_DEPOSITO" | "VERIFICAR" | "RECONTAR";
  prioridad: "URGENTE" | "ALTA" | "MEDIA" | "BAJA";
  destinatario: "REPOSITOR" | "ENCARGADO";
  unidades_sugeridas: number | null;
  creada_at: string;
  atendida_at: string | null;
  atendida_por: string | null;
  motivo: string | null;
  estado: string;
};

export type Producto = {
  sucursal_id: string;
  producto_id: string;
  nombre: string;
  precio: number;
  capacidad: number | null;
  tiempo_reposicion_min: number;
  conteo_informado: number | null;
  conteo_at: string | null;
  conteo_por: string | null;
  conteo_vencido: boolean;
  vendido_desde_conteo: number;
  stock_gondola: number;
  desvio: number;
  nivel: number;
  stock_general: number | null;
  vendido_hoy: number;
  deposito: number;
  venta_hora: number | null;
  umbral: number;
  horas_a_vacio: number | null;
  a_reponer: number;
  ultima_venta_at: string | null;
  estado: string;
  alertas: Alerta[];
  desvio_hoy: number;
};

export type ItemReposicion = Alerta & {
  estado_producto: string;
  nombre: string;
  precio: number;
  stock_gondola: number;
  conteo_informado: number | null;
  nivel: number;
  capacidad: number | null;
  horas_a_vacio: number | null;
  tiempo_reposicion_min: number;
  conteo_at: string | null;
  conteo_por: string | null;
  deposito: number;
};

export const hhmm = (iso: string | null | undefined) => (iso ? iso.slice(11, 16) : "—");

/** Current business time in Argentina as a naive ISO string (YYYY-MM-DDTHH:MM:SS), independent of the device offset. */
export function nowIso(): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** JSON localStorage access; any failure (private mode, quota, bad JSON) reads as null and writes are dropped. */
export function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}
export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/** Throws only on network failure (used to detect offline). */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  const r = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = (await r.json().catch(() => null)) as T | null;
  return { status: r.status, data };
}

export const sucPath = (suc: string) => `/api/sucursales/${encodeURIComponent(suc)}`;

export function NivelBar({ item }: { item: { nivel: number | null; stock_gondola: number; estado?: string; estado_producto?: string } }) {
  const pct = item.nivel ?? 0;
  // Work-list items carry the alert's own `estado`, so prefer the product's.
  const estado = item.estado_producto || item.estado;
  const cls = item.stock_gondola === 0 ? "zero" : estado === "BAJO" || estado === "SIN_DEPOSITO" ? "low" : "";
  return (
    <div className={`bar ${cls}`} role="img" aria-label={`Nivel ${pct}%`}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Branch list + selection persisted in localStorage. */
export function useSucursal() {
  const [sucursales, setSucursales] = useState<string[]>([]);
  const [suc, setSuc] = useState<string>("");
  useEffect(() => {
    api<string[]>("GET", "/api/sucursales")
      .then(({ data }) => {
        const list = Array.isArray(data) ? data : [];
        const saved = load<string>("sucursal");
        setSucursales(list);
        setSuc(saved && list.includes(saved) ? saved : list[0] ?? "");
      })
      .catch(() => {});
  }, []);
  const select = useCallback((s: string) => {
    save("sucursal", s);
    setSuc(s);
  }, []);
  return { sucursales, suc, select };
}

export function SucursalSelect({ sucursales, value, onChange }: { sucursales: string[]; value: string; onChange: (s: string) => void }) {
  return (
    <select aria-label="Sucursal" value={value} onChange={(e) => onChange(e.target.value)}>
      {sucursales.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );
}

/**
 * Live updates: any realtime event triggers a debounced (250 ms) reload; `onEvent` also sees each event.
 * Reloads on subscribe and every 30 s as a fallback when realtime is unconfigured or down.
 */
export function useLive(suc: string, reload: () => void, onEvent: (e: StockEvent) => void) {
  const [connected, setConnected] = useState(false);
  const reloadRef = useRef(reload);
  const eventRef = useRef(onEvent);
  reloadRef.current = reload;
  eventRef.current = onEvent;
  useEffect(() => {
    if (!suc) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reloadRef.current(), 250);
    };
    reloadRef.current();
    const unsubscribe = subscribeSucursal(
      suc,
      (e) => {
        debounced();
        eventRef.current(e);
      },
      (on) => {
        setConnected(on);
        if (on) debounced();
      },
    );
    const poll = setInterval(() => reloadRef.current(), 30_000);
    return () => {
      unsubscribe();
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, [suc]);
  return connected;
}

export function Dot({ on }: { on: boolean }) {
  return <span className={`dot${on ? " on" : ""}`} title="Conexión en vivo" />;
}

export function useToast() {
  const [state, setState] = useState<{ msg: string; color?: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toast = useCallback((msg: string, color?: string) => {
    setState({ msg, color });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 6000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const node = (
    <div id="toast" role="status" aria-live="assertive" style={{ display: state ? "block" : "none", background: state?.color || undefined }}>
      {state?.msg}
    </div>
  );
  return { toast, node };
}
