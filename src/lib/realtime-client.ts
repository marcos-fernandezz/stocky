"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type StockEventType = "producto.actualizado" | "alerta.creada" | "alerta.cerrada";
export type StockEvent = { type: StockEventType; data: Record<string, unknown> };

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  client ??= createClient(url, key);
  return client;
}

/**
 * Listens to the branch's broadcast channel (`sucursal:<id>`), the same topic the server publishes to.
 * Returns an unsubscribe function. Without Supabase env vars it reports disconnected and does nothing:
 * screens still work by reloading data periodically.
 */
export function subscribeSucursal(
  sucursal: string,
  onEvent: (e: StockEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  const supabase = getClient();
  if (!supabase) {
    onStatus(false);
    return () => {};
  }
  const channel = supabase
    .channel(`sucursal:${sucursal}`)
    .on("broadcast", { event: "*" }, ({ event, payload }) => onEvent({ type: event as StockEventType, data: payload }))
    .subscribe((status) => onStatus(status === "SUBSCRIBED"));
  return () => {
    supabase.removeChannel(channel);
  };
}
