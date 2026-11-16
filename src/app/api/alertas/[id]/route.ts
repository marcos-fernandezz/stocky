import { NextResponse } from "next/server";
import { getStock, handle, readJson } from "@/lib/api";
import { NotFoundError } from "@/lib/errors";
import { publish } from "@/lib/realtime";
import { businessNow } from "@/lib/time";

type Ctx = { params: Promise<{ id: string }> };

/** Dismiss an open alert with a reason. */
export const PATCH = (req: Request, { params }: Ctx) => handle(async () => {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError("alerta inexistente");
  const { result, eventos } = await getStock().descartarAlerta(id, await readJson(req), businessNow());
  await publish(eventos);
  return NextResponse.json(result);
});
