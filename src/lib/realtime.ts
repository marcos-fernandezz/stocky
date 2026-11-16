import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Evento } from "./stock";

let client: SupabaseClient | null | undefined;

function getClient(): SupabaseClient | null {
  if (client === undefined) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    client = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  }
  return client;
}

/**
 * Broadcasts domain events to `sucursal:<id>` over Supabase's REST endpoint (no websocket kept open,
 * which suits serverless). Runs after the DB commit; a failed broadcast never fails the request:
 * screens also reload every 30 s.
 */
export async function publish(eventos: Evento[]): Promise<void> {
  try {
    const supabase = getClient();
    if (!supabase || !eventos.length) return;
    const porSucursal = new Map<string, Evento[]>();
    for (const e of eventos) porSucursal.set(e.sucursal_id, [...(porSucursal.get(e.sucursal_id) ?? []), e]);
    await Promise.all([...porSucursal].map(async ([s, evs]) => {
      const channel = supabase.channel(`sucursal:${s}`);
      try {
        for (const e of evs) await channel.httpSend(e.type, e.data);
      } finally {
        await supabase.removeChannel(channel).catch(() => {});
      }
    }));
  } catch (err) {
    // The write is already committed: never turn a broadcast problem into a failed request.
    console.error("realtime publish failed", err);
  }
}
