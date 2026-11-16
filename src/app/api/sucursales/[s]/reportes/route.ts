import { NextResponse } from "next/server";
import { getStock, handle, readJson } from "@/lib/api";
import { publish } from "@/lib/realtime";
import { businessNow } from "@/lib/time";

type Ctx = { params: Promise<{ s: string }> };

/** The repositor reports a product: `{producto_id, resultado: OK | REPUSE | SIN_STOCK, repositor_id}`. */
export const POST = (req: Request, { params }: Ctx) => handle(async () => {
  const { s } = await params;
  const { result, eventos } = await getStock().reportar(s, await readJson(req), businessNow());
  await publish(eventos);
  return NextResponse.json(result, { status: 201 });
});
