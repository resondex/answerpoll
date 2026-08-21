import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { apiKeyConfigured } from "@/lib/engine/providers";
import { composeStages, generateGrid, type Moderators } from "@/lib/engine/instrument";

export const maxDuration = 120;

const Body = z.object({
  brand: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(120),
  competitors: z.array(z.string().trim().min(1).max(80)).max(8),
  audience: z.string().trim().max(160).optional(),
  moderators: z.record(z.string(), z.unknown()),
  /** Stage keys the user kept at gate 1; composition is recomputed server
   * side from the moderators so stage hints never leave the engine. */
  stageKeys: z.array(z.string().trim().min(1)).min(1).max(30),
  scenarios: z
    .array(z.object({ label: z.string().trim().min(1).max(60), description: z.string().trim().max(240) }))
    .max(4),
});

/** Gate 2: write one seed prompt per cell for the confirmed stages and scenarios. */
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
  const { brand, category, competitors, audience, stageKeys, scenarios } = parsed.data;
  const moderators = parsed.data.moderators as unknown as Moderators;
  const kept = new Set(stageKeys);
  const stages = composeStages(moderators).filter((s) => kept.has(s.key));
  if (stages.length === 0) {
    return NextResponse.json({ error: "keep at least one stage" }, { status: 400 });
  }
  const cells = await generateGrid({
    brand,
    category,
    competitors,
    audience: audience || null,
    moderators,
    stages,
    situations: scenarios,
  });
  return NextResponse.json({ cells });
}
