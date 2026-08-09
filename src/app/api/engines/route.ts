import { NextResponse } from "next/server";
import { ENGINES } from "@/lib/engine/providers";
import { requireAuth } from "@/lib/auth";

/** The measurement engines and whether this deployment can reach each one. */
export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
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
