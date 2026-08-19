import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { apiKeyConfigured } from "@/lib/engine/providers";
import { buildInstrument } from "@/lib/engine/instrument";

export const maxDuration = 120;

const Body = z.object({
  brand: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(120),
  competitors: z.array(z.string().trim().min(1).max(80)).max(8),
  audience: z.string().trim().max(160).optional(),
});

/**
 * The instrument designer's setup call: classified category → composed
 * stages → situations → a grid of prompts. The classic path (/api/setup +
 * /api/prompts/generate) is untouched; this is the alternative battery
 * builder, chosen in the setup UI.
 */
export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  if (!apiKeyConfigured()) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 503 }
    );
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { brand, category, competitors, audience } = parsed.data;
  const instrument = await buildInstrument({
    brand,
    category,
    competitors,
    audience: audience || null,
  });
  return NextResponse.json({ instrument });
}
