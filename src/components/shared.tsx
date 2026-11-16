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
