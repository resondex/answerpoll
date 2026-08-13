import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";
import { requireAuth, requireRun } from "@/lib/auth";
import { buildCanonicalizer } from "@/lib/engine/metrics";
import type { LabelMetric } from "@/lib/types";

export const maxDuration = 60;

const METRICS = ["mentioned", "recommended", "chosen"] as const;

/**
 * The answers behind one figure. The caller names the metric and the brand —
 * the same pair the Workbench cell represents — and gets back the answers it
 * counts, each with the sentence that caused the coding and any human verdict
 * already recorded.
 *
 * Deriving the answer set from the metric (rather than from a filter the
 * client assembles) is what lets any cell open its own evidence without
 * per-cell wiring.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth);
  if (loaded instanceof NextResponse) return loaded;
  const { run } = loaded;
  const project = await store.getProject(run.project_id);
  if (!project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!project.evidence_drawer) {
    return NextResponse.json(
      { error: "The evidence drawer is switched off for this tracker" },
      { status: 403 }
    );
  }

  const url = new URL(req.url);
  const metric = url.searchParams.get("metric") ?? "";
  const brand = url.searchParams.get("brand") ?? "";
  if (!METRICS.includes(metric as (typeof METRICS)[number]) || !brand) {
    return NextResponse.json(
      { error: "metric and brand are required" },
      { status: 400 }
    );
  }

  const [responses, mentions, dictionary, prompts, labels] = await Promise.all([
    store.listResponses(id),
    store.listMentionsForRun(id),
    store.getDictionary(run.project_id),
    store.listPrompts(run.project_id),
    store.listLabelsForRun(id),
  ]);
  const canon = buildCanonicalizer(dictionary);
  const norm = canon.norm(brand);
  const promptText = new Map(prompts.map((p) => [p.id, p.text]));
  // Branded prompts name the brand in the question, so they sit outside every
  // headline rate — the drawer has to use the same base or the count it shows
  // will not match the figure that opened it.
  const brandedIds = new Set(
    prompts.filter((p) => p.theme === "branded").map((p) => p.id)
  );
  const unbranded = responses.filter((r) => !brandedIds.has(r.prompt_id));

  const byResponse = new Map<string, (typeof mentions)[number]>();
  for (const m of mentions) {
    if (canon.norm(m.brand) !== norm) continue;
    const prev = byResponse.get(m.response_id);
    if (!prev || m.rank < prev.rank) byResponse.set(m.response_id, m);
  }

  const inMetric = (r: (typeof unbranded)[number]): boolean => {
    const mention = byResponse.get(r.id);
    const chosen = Boolean(
      r.top_pick_brand && canon.norm(r.top_pick_brand) === norm
    );
    if (metric === "chosen") return chosen;
    if (metric === "recommended") {
      return chosen || mention?.framing === "recommended";
    }
    return Boolean(mention);
  };

  const labelFor = new Map(
    labels
      .filter((l) => l.metric === metric && l.brand_norm === norm)
      .map((l) => [l.response_id, l.verdict === 1])
  );

  const rows = unbranded
    .filter((r) => inMetric(r) || labelFor.has(r.id))
    .map((r) => {
      const mention = byResponse.get(r.id);
      return {
        id: r.id,
        model: r.model,
        repeat: r.repeat_idx,
        prompt: promptText.get(r.prompt_id) ?? "",
        text: r.text,
        // The span that caused the coding — what a reviewer actually judges.
        quote: r.focus_quote,
        framing: mention?.framing ?? null,
        rank: mention?.rank ?? null,
        codedIn: inMetric(r),
        label: labelFor.get(r.id) ?? null,
      };
    });

  return NextResponse.json({
    metric: metric as LabelMetric,
    brand: canon.canonical(brand),
    brandNorm: norm,
    // The denominator the figure was computed over, stated rather than implied.
    base: unbranded.length,
    count: rows.filter((r) => r.codedIn).length,
    reviewed: rows.filter((r) => r.label !== null).length,
    humanOverride: Boolean(project.human_override),
    answers: rows,
  });
}

const labelSchema = z.object({
  responseId: z.string().min(1),
  metric: z.enum(METRICS),
  brand: z.string().trim().min(1),
  verdict: z.boolean(),
});

/** Record one human verdict. Never changes coding — see lib/types.ts. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth, { write: true });
  if (loaded instanceof NextResponse) return loaded;
  const project = await store.getProject(loaded.run.project_id);
  if (!project || !project.evidence_drawer) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsed = labelSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid label" }, { status: 400 });
  }
  const canon = buildCanonicalizer(await store.getDictionary(project.id));
  await store.upsertAnswerLabel({
    projectId: project.id,
    responseId: parsed.data.responseId,
    metric: parsed.data.metric,
    brand: canon.canonical(parsed.data.brand),
    brandNorm: canon.norm(parsed.data.brand),
    verdict: parsed.data.verdict,
    labeledBy: auth.email ?? auth.userId ?? null,
  });
  return NextResponse.json({ ok: true });
}
