import { NextResponse } from "next/server";
import { getStock, handle, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ s: string }> };

/** Branch config: rounds per day and business hours. */
export const GET = (_: Request, { params }: Ctx) => handle(async () => {
  const { s } = await params;
  return NextResponse.json(await getStock().sucursal(s));
});

/** The encargado changes `{pasadas_por_dia?, apertura?, cierre?}`. */
export const PATCH = (req: Request, { params }: Ctx) => handle(async () => {
  const { s } = await params;
  return NextResponse.json(await getStock().configurar(s, await readJson(req)));
});
