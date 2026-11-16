import { NextResponse } from "next/server";
import { getDb } from "./db";
import { DomainError } from "./errors";
import { Stock } from "./stock";

let stock: Stock | null = null;
export const getStock = () => (stock ??= new Stock(getDb()));

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new DomainError("JSON inválido");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new DomainError("se esperaba un objeto JSON");
  return body as Record<string, unknown>;
}

/** Maps domain errors to `{error}` with their HTTP status; anything else is a 500. */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DomainError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error(e);
    return NextResponse.json({ error: "error interno" }, { status: 500 });
  }
}
