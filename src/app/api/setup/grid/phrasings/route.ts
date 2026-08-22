import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { apiKeyConfigured } from "@/lib/engine/providers";
import { generatePhrasings, type Moderators } from "@/lib/engine/instrument";

export const maxDuration = 120;

const Body = z.object({
  brand: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(120),
  competitors: z.array(z.string().trim().min(1).max(80)).max(8),
  audience: z.string().trim().max(160).optional(),
  moderators: z.record(z.string(), z.unknown()),
  /** One layer's worth of confirmed cells - the UI calls this once per
   * layer so no request runs near the platform limit. */
  cells: z
    .array(
      z.object({
        stage: z.string().trim().min(1),
        situation: z.string().trim().nullable(),
        angle: z.string().trim().min(1),
        text: z.string().trim().min(1),
      })
    )
    .min(1)
    .max(30),
  count: z.number().int().min(2).max(20).default(10),
  force: z.boolean().optional(),
});

/** Gate 3: the paraphrase set for each confirmed seed prompt. */
export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  if (!apiKeyConfigured()) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured" }, { status: 503 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { brand, category, competitors, audience, cells, count, force } = parsed.data;
  const phrasings = await generatePhrasings({
    brand,
    category,
    competitors,
    audience: audience || null,
    moderators: parsed.data.moderators as unknown as Moderators,
    cells,
    count,
    force,
  });
  return NextResponse.json({ phrasings });
}
