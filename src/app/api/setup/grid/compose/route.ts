import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { apiKeyConfigured } from "@/lib/engine/providers";
import { composeInstrument } from "@/lib/engine/instrument";

export const maxDuration = 120;

const Body = z.object({
  category: z.string().trim().min(1).max(120),
  audience: z.string().trim().max(160).optional(),
});

/**
 * Gate 1 of Landscape setup: classify the category, compose the stages,
 * propose the scenarios. The user confirms or edits these before a single
 * prompt is written (gate 2) or paraphrased (gate 3).
 */
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
  const { moderators, stages, situations } = await composeInstrument({
    category: parsed.data.category,
    audience: parsed.data.audience || null,
  });
  return NextResponse.json({
    moderators,
    stages: stages.map((s) => ({ key: s.key, label: s.label, layer: s.layer })),
    scenarios: situations,
  });
}
