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
  const supabase = getClient();
  if (!supabase || !eventos.length) return;
  const porSucursal = Map.groupBy(eventos, (e) => e.sucursal_id);
  await Promise.all([...porSucursal].map(async ([s, evs]) => {
    const channel = supabase.channel(`sucursal:${s}`);
    try {
      for (const e of evs) await channel.httpSend(e.type, e.data);
    } catch (err) {
      console.error("realtime publish failed", s, err);
    } finally {
      await supabase.removeChannel(channel);
    }
  }));
}
