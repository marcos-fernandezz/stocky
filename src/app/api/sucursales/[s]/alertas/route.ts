import { NextResponse } from "next/server";
import { getStock, handle } from "@/lib/api";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ s: string }> };

export const GET = (req: Request, { params }: Ctx) => handle(async () => {
  const { s } = await params;
  return NextResponse.json(await getStock().alertas(s, new URL(req.url).searchParams.get("destinatario")));
});
