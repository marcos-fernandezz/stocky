import { NextResponse } from "next/server";
import { getStock, handle } from "@/lib/api";
import { businessNow } from "@/lib/time";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ s: string }> };

/** RF-05: prioritized work list for the repositor. */
export const GET = (_: Request, { params }: Ctx) => handle(async () => {
  const { s } = await params;
  return NextResponse.json(await getStock().reposicion(s, businessNow()));
});
