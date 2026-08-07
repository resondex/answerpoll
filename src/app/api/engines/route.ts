import { NextResponse } from "next/server";
import { ENGINES } from "@/lib/engine/providers";

/** The measurement engines and whether this deployment can reach each one. */
export async function GET() {
  return NextResponse.json({
    engines: ENGINES.map((e) => ({
      id: e.id,
      label: e.label,
      vendor: e.vendor,
      available: Boolean(process.env[e.keyEnv]),
      keyEnv: e.keyEnv,
    })),
  });
}
