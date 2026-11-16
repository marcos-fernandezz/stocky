import { NextResponse } from "next/server";
import { getStock, handle, readJson } from "@/lib/api";
import { publish } from "@/lib/realtime";
import { businessNow } from "@/lib/time";

/** RF-02: one receipt (comprobante), applied all-or-nothing and idempotent by comprobante_id. */
export const POST = (req: Request) => handle(async () => {
  const { status, result, eventos } = await getStock().registrarVenta(await readJson(req), businessNow());
  await publish(eventos);
  return NextResponse.json(result, { status });
});
