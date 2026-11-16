import { NextResponse } from "next/server";
import { getStock, handle, readJson } from "@/lib/api";
import { publish } from "@/lib/realtime";
import { businessNow } from "@/lib/time";

type Ctx = { params: Promise<{ s: string }> };

/** RF-01: the repositor reports units on the shelf. */
export const POST = (req: Request, { params }: Ctx) => handle(async () => {
  const { s } = await params;
  const { result, eventos } = await getStock().registrarConteo(s, await readJson(req), businessNow());
  await publish(eventos);
  return NextResponse.json(result, { status: result.aplicado ? 201 : 200 });
});
