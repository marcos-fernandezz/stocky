import { NextResponse } from "next/server";
import { getStock, handle } from "@/lib/api";
import { businessNow } from "@/lib/time";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ s: string }> };

export const GET = (_: Request, { params }: Ctx) => handle(async () => {
  const { s } = await params;
  return NextResponse.json(await getStock().productos(s, businessNow()));
});
