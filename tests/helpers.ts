import { pgliteDb } from "@/lib/db";

/** Fresh in-process Postgres with the real migration and seed applied. */
export const testDb = async (seeds?: string[]) => ({ db: await pgliteDb(seeds) });

export const at = (s: string) => new Date(s + "Z");
export const min = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
