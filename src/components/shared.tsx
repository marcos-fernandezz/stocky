"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeSucursal, type StockEvent } from "@/lib/realtime-client";

export type Alerta = {
  id: number | string;
  sucursal_id: string;
  producto_id: string | null;
  nombre: string | null;
  tipo: "RONDA" | "VENTA_ANOMALA" | "SIN_STOCK";
  prioridad: "URGENTE" | "ALTA" | "MEDIA" | "BAJA";
  destinatario: "REPOSITOR" | "ENCARGADO";
  creada_at: string;
  atendida_at: string | null;
  atendida_por: string | null;
  motivo: string | null;
  estado: string;
};

export type Periodo = { n: number; de: number; inicio: string; fin: string };

export type Sucursal = { id: string; pasadas_por_dia: number; apertura: number; cierre: number };

export type Producto = {
  sucursal_id: string;
  producto_id: string;
  nombre: string;
  precio: number;
  periodo: Periodo | null;
  umbral: number | null;
  esperado: number | null;
  vendido_periodo: number;
  vendido_hoy: number;
  ultima_venta_at: string | null;
  quiebre_desde: string | null;
  estado: "OK" | "ANOMALIA" | "QUIEBRE";
  alertas: Alerta[];
};

export type Ronda = { sucursal: Sucursal; periodo: Periodo | null; ronda: Alerta | null; alertas: Alerta[] };

export type Resultado = "OK" | "REPUSE" | "SIN_STOCK";

// Business times are naive wall-clock strings: format them as UTC so no device offset shifts them.
const HORA = new Intl.DateTimeFormat("es-AR", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DIA_HORA = new Intl.DateTimeFormat("es-AR", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const hhmm = (iso: string | null | undefined) => (iso ? HORA.format(new Date(iso + "Z")) : "—");

/** Time if it is today, otherwise day and time, so an old sale never reads as recent. */
export const cuando = (iso: string | null | undefined) =>
  !iso ? "—" : iso.slice(0, 10) === nowIso().slice(0, 10) ? hhmm(iso) : DIA_HORA.format(new Date(iso + "Z"));

/** Argentine number format: 6.3 -> "6,3". */
export const num = (x: number | null | undefined) => (x == null ? "—" : x.toLocaleString("es-AR"));

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

/** Human labels for the enums the API returns. */
export const ESTADO_LABEL: Record<Producto["estado"], string> = { OK: "OK", ANOMALIA: "Vende poco", QUIEBRE: "Sin stock" };
export const TIPO_LABEL: Record<Alerta["tipo"], string> = { RONDA: "Pasada", VENTA_ANOMALA: "Vende poco", SIN_STOCK: "Sin stock" };

const ICONOS = {
  campana: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  check: "M20 6 9 17l-5-5",
  play: "M6 4l14 8-14 8z",
  pausa: "M7 4h3v16H7zM14 4h3v16h-3z",
} as const;

/** Small stroke icon set (one family, 2px stroke). */
export function Icono({ nombre, size = 18 }: { nombre: keyof typeof ICONOS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONOS[nombre]} />
    </svg>
  );
}

/** Sales pace in the current period: sold vs. the period average (umbral). */
export function Ritmo({ p }: { p: Pick<Producto, "vendido_periodo" | "umbral" | "estado"> }) {
  if (!p.umbral) return null;
  const pct = Math.min(100, Math.round((p.vendido_periodo * 100) / p.umbral));
  return (
    <div className={`ritmo ${p.estado}`} role="img" aria-label={`Vendido ${p.vendido_periodo} de ${num(p.umbral)} esperados en el período`}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** "Pasada 1 de 3 · 08:00–12:00" */
export const periodoTexto = (p: Periodo | null) => (p ? `Pasada ${p.n} de ${p.de} · ${hhmm(p.inicio)}–${hhmm(p.fin)}` : "Fuera de horario");

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
  const t = on ? "En vivo" : "Se actualiza cada 30 s";
  return <span className={`dot${on ? " on" : ""}`} title={t} role="img" aria-label={t} />;
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
    <div id="toast" role="status" aria-live="polite" style={{ display: state ? "block" : "none", background: state?.color || undefined }}>
      {state?.msg}
    </div>
  );
  return { toast, node };
}
