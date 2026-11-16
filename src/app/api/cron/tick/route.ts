import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getStock, handle } from "@/lib/api";
import { publish } from "@/lib/realtime";
import { businessNow } from "@/lib/time";

export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return !!secret && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Periodic re-evaluation (opens rounds, checks sales anomalies). Called every minute by pg_cron (README). */
const tick = (req: Request) => handle(async () => {
  if (!authorized(req)) return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  const eventos = await getStock().tick(businessNow());
  await publish(eventos);
  return NextResponse.json({ eventos: eventos.length });
});

export const GET = tick;
export const POST = tick;
