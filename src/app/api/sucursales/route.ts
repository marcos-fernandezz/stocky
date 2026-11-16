import { NextResponse } from "next/server";
import { getStock, handle } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = () => handle(async () => NextResponse.json(await getStock().sucursales()));
