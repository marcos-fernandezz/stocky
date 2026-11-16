import postgres from "postgres";

export type Row = Record<string, any>;

/** Minimal query port: production uses postgres.js (Supabase), tests use PGlite (in-process Postgres). */
export interface Q {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Q {
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
}

export function postgresDb(url: string): Db {
  // prepare:false is required by Supabase's transaction pooler (port 6543); few connections per serverless instance.
  const sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  const wrap = (s: postgres.Sql | postgres.TransactionSql): Q => ({
    query: async (text, params = []) => (await s.unsafe(text, params as any[])) as any,
  });
  return {
    ...wrap(sql),
    tx: (fn) => sql.begin((t) => fn(wrap(t))) as Promise<any>,
  };
}

type PGliteLike = { query: (t: string, p?: any[]) => Promise<{ rows: any[] }> };

/** In-process Postgres (PGlite): tests and offline local demo. Applies the real migration + seeds. */
export async function pgliteDb(seeds = ["seed.sql"]): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const pg = new PGlite();
  for (const f of ["migrations/0001_init.sql", ...seeds]) await pg.exec(await readFile(join(process.cwd(), "supabase", f), "utf8"));
  const wrap = (c: PGliteLike): Q => ({ query: async (text, params = []) => (await c.query(text, params as any[])).rows as any });
  return { ...wrap(pg), tx: (fn) => pg.transaction((t) => fn(wrap(t))) };
}

function lazy(p: Promise<Db>): Db {
  return { query: async (t, a) => (await p).query(t, a), tx: async (fn) => (await p).tx(fn) };
}

let db: Db | null = null;

/** DATABASE_URL=pglite://memory runs without Supabase (data lives only while the process runs). */
export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL no está configurada");
    db = url.startsWith("pglite:") ? lazy(pgliteDb(["seed.sql", "seed_history.sql"])) : postgresDb(url);
  }
  return db;
}
