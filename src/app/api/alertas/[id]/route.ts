import { NextResponse } from "next/server";
import { getStock, handle, readJson } from "@/lib/api";
import { NotFoundError } from "@/lib/errors";
import { publish } from "@/lib/realtime";
import { businessNow } from "@/lib/time";

type Ctx = { params: Promise<{ id: string }> };

/** Close an open alert: `{estado: "ATENDIDA", por}` marks it done, `{motivo, por}` dismisses it. */
export const PATCH = (req: Request, { params }: Ctx) => handle(async () => {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError("alerta inexistente");
  const { result, eventos } = await getStock().cerrarAlerta(id, await readJson(req), businessNow());
  await publish(eventos);
  return NextResponse.json(result);
});
