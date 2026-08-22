import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { apiKeyConfigured } from "@/lib/engine/providers";
import {
  composeInstrument,
  stageLibrary,
  generateSituations,
  type Moderators,
} from "@/lib/engine/instrument";

export const maxDuration = 120;

const Body = z.object({
  category: z.string().trim().min(1).max(120),
  audience: z.string().trim().max(160).optional(),
  /** When the user edits the category read, the composer runs from their
   * values instead of classifying again. */
  moderators: z.record(z.string(), z.unknown()).optional(),
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
  const audience = parsed.data.audience || null;
  let moderators: Moderators;
  let situations;
  if (parsed.data.moderators) {
    moderators = parsed.data.moderators as unknown as Moderators;
    situations = await generateSituations({
      category: parsed.data.category,
      audience,
      decisionUnit: moderators.decision_unit,
    });
  } else {
    ({ moderators, situations } = await composeInstrument({
      category: parsed.data.category,
      audience,
    }));
  }
  // The whole library goes to the client with the composer's verdict on
  // each stage: the user sees every stage and starts from the recommended set.
  return NextResponse.json({
    moderators,
    stages: stageLibrary(moderators).map((s) => ({
      key: s.key,
      label: s.label,
      layer: s.layer,
      situational: s.situational,
      rivals: s.rivals,
      recommended: s.recommended,
    })),
    scenarios: situations,
  });
}
