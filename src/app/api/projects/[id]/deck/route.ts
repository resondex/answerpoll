import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireAuth, requireProject } from "@/lib/auth";
import { apiKeyConfigured } from "@/lib/engine/providers";
import { buildCanonicalizer, computeRunMetrics } from "@/lib/engine/metrics";
import { computeProjectTrend } from "@/lib/engine/trend";
import { buildRunInsights, type InsightsBundle } from "@/lib/engine/insights";
import { buildStudyDeck, type DeckVariant } from "@/lib/engine/deck";
import type { MentionRow } from "@/lib/types";

export const maxDuration = 120;

/** The summary deck as a direct download — the artifact people want without
 * the zip. ?variant=ai_beta adds the verified AI narrative captions. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth);
  if (project instanceof NextResponse) return project;
  const runs = await store.listRuns(id);
  const run = runs.find((r) => r.status === "complete");
  if (!run) {
    return NextResponse.json(
      { error: "no completed run yet" },
      { status: 404 }
    );
  }
  const variant: DeckVariant =
    new URL(req.url).searchParams.get("variant") === "ai_beta"
      ? "ai_beta"
      : "standard";

  const [metrics, prompts, responses, mentions, trend, dictionary] =
    await Promise.all([
      computeRunMetrics(run.id),
      store.listPrompts(id),
      store.listResponses(run.id),
      store.listMentionsForRun(run.id),
      computeProjectTrend(id),
      store.getDictionary(id),
    ]);
  if (!metrics) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let insights: InsightsBundle | null = null;
  if (apiKeyConfigured()) {
    try {
      insights = await buildRunInsights(run.id);
    } catch (err) {
      console.error("insights unavailable for deck:", err);
    }
  }
  const canon = buildCanonicalizer(dictionary);
  const mentionsByResponse = new Map<string, MentionRow[]>();
  for (const m of mentions) {
    const list = mentionsByResponse.get(m.response_id) ?? [];
    list.push(m);
    mentionsByResponse.set(m.response_id, list);
  }
  for (const list of mentionsByResponse.values()) {
    list.sort((a, b) => a.rank - b.rank);
  }
  const promptIdx = new Map(prompts.map((p, i) => [p.id, i]));
  const buffer = await buildStudyDeck({
    project,
    run,
    metrics,
    prompts,
    responses,
    mentionsByResponse,
    canon,
    dictionary,
    insights,
    promptCode: (pid) => `P${String((promptIdx.get(pid) ?? 0) + 1).padStart(2, "0")}`,
    trend,
    variant,
  });
  const slug = project.brand.replace(/[^a-zA-Z0-9]+/g, "_");
  const stamp = (run.completed_at ?? run.created_at).slice(0, 10);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": `attachment; filename="${slug}_summary_deck${variant === "ai_beta" ? "_ai_beta" : ""}_${stamp}.pptx"`,
    },
  });
}
