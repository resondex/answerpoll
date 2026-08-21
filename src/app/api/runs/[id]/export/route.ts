import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { engineMode } from "@/lib/engine/providers";
import { requireAuth, requireRun } from "@/lib/auth";
import {
  buildCanonicalizer,
  computeRunMetrics,
  dictionaryRoles,
} from "@/lib/engine/metrics";

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: (string | number | null)[][]): string {
  // Leading BOM so Excel detects UTF-8 — without it, curly quotes and
  // em-dashes in LLM answers render as mojibake (â€™ / ‚Äô).
  return (
    "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n"
  );
}

/**
 * Download a run's results.
 *   ?format=json                 — complete archive: metrics + every raw
 *                                  response and its extracted mentions
 *   ?format=csv&table=brands     — brand summary (default table)
 *   ?format=csv&table=prompts    — per-prompt target visibility
 *   ?format=csv&table=responses  — raw data, one row per sampled answer
 *   ?format=csv&table=mentions   — raw data, long format, one row per
 *                                  brand mention (tidy — ready for R)
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
  const { run, project } = loaded;
  const [metrics, responses, mentions, prompts] = await Promise.all([
    computeRunMetrics(id),
    store.listResponses(id),
    store.listMentionsForRun(id),
    store.listPrompts(run.project_id),
  ]);
  if (!metrics) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const promptById = new Map(prompts.map((p) => [p.id, p]));
  const mentionsByResponse = new Map<string, typeof mentions>();
  for (const m of mentions) {
    const list = mentionsByResponse.get(m.response_id) ?? [];
    list.push(m);
    mentionsByResponse.set(m.response_id, list);
  }
  for (const list of mentionsByResponse.values()) {
    list.sort((a, b) => a.rank - b.rank);
  }
  const dictionary = await store.getDictionary(project.id);
  const canon = buildCanonicalizer(dictionary);
  const targetNorm = canon.norm(project.brand);
  const roleOf = dictionaryRoles(dictionary, project, canon);

  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "csv";
  const table = url.searchParams.get("table") ?? "brands";
  const stamp = (run.completed_at ?? run.created_at).slice(0, 10);
  const slug = project.brand.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  if (format === "json") {
    const raw = responses.map((r) => {
      const p = promptById.get(r.prompt_id);
      return {
        response_id: r.id,
        prompt: p?.text ?? "",
        theme: p?.theme ?? "",
        repeat_idx: r.repeat_idx,
        created_at: r.created_at,
        text: r.text,
        outcome: r.outcome,
        top_pick_brand: r.top_pick_brand,
        reason_codes: r.reason_codes ? r.reason_codes.split("|") : [],
        clarification_requested: r.clarification_requested,
        gives_recommendation: r.gives_recommendation,
        includes_prices: r.includes_prices,
        includes_specs: r.includes_specs,
        total_recommendations: r.total_recommendations,
        focus_quote: r.focus_quote,
        focus_interpretation: r.focus_interpretation,
        mentions: (mentionsByResponse.get(r.id) ?? []).map((m) => ({
          brand: m.brand,
          rank: m.rank,
          framing: m.framing,
        })),
      };
    });
    return new NextResponse(
      JSON.stringify({ project, run, metrics, responses: raw }, null, 2),
      {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="procerno_${slug}_${stamp}.json"`,
        },
      }
    );
  }

  let rows: (string | number | null)[][];
  if (table === "prompts") {
    rows = [
      ["prompt", "theme", "responses", "target_mentions", "target_rate", "target_avg_position"],
      ...metrics.prompts.map((p) => [
        p.text,
        p.theme,
        p.responses,
        p.targetMentions,
        p.targetRate.toFixed(4),
        p.targetAvgRank?.toFixed(2) ?? null,
      ]),
    ];
  } else if (table === "responses") {
    rows = [
      ["response_id", "engine", "mode", "coder_model", "prompt", "theme", "repeat_idx", "created_at", "brands_in_order", "mention_count", "target_mentioned", "outcome", "top_pick_brand", "reason_codes", "clarification_requested", "gives_recommendation", "includes_prices", "includes_specs", "total_recommendations", "focus_quote", "focus_interpretation", "text"],
      ...responses.map((r) => {
        const p = promptById.get(r.prompt_id);
        const ms = mentionsByResponse.get(r.id) ?? [];
        return [
          r.id,
          r.model,
          engineMode(r.model),
          r.coder_model ?? "",
          p?.text ?? "",
          p?.theme ?? "",
          r.repeat_idx,
          r.created_at,
          ms.map((m) => m.brand).join("|"),
          ms.length,
          ms.some((m) => m.brand_norm === targetNorm) ? 1 : 0,
          r.outcome,
          r.top_pick_brand,
          r.reason_codes,
          r.clarification_requested,
          r.gives_recommendation,
          r.includes_prices,
          r.includes_specs,
          r.total_recommendations,
          r.focus_quote,
          r.focus_interpretation,
          r.text,
        ];
      }),
    ];
  } else if (table === "mentions") {
    rows = [
      ["response_id", "prompt", "theme", "repeat_idx", "brand", "rank", "framing", "brand_type"],
      ...responses.flatMap((r) => {
        const p = promptById.get(r.prompt_id);
        return (mentionsByResponse.get(r.id) ?? []).map((m) => [
          r.id,
          p?.text ?? "",
          p?.theme ?? "",
          r.repeat_idx,
          m.brand,
          m.rank,
          m.framing,
          roleOf(m.brand_norm),
        ]);
      }),
    ];
  } else {
    rows = [
      ["brand", "type", "mention_count", "mention_rate", "ci_low", "ci_high", "avg_position", "share_of_voice", "recommended", "mentioned", "negative"],
      ...metrics.brands.map((b) => [
        b.brand,
        b.isTarget ? "target" : b.isCompetitor ? "competitor" : "emerged",
        b.mentionCount,
        b.mentionRate.toFixed(4),
        b.ciLow.toFixed(4),
        b.ciHigh.toFixed(4),
        b.avgRank?.toFixed(2) ?? null,
        b.shareOfVoice.toFixed(4),
        b.framing.recommended,
        b.framing.mentioned,
        b.framing.negative,
      ]),
    ];
  }

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="procerno_${slug}_${table}_${stamp}.csv"`,
    },
  });
}
