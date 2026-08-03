import {
  getProject,
  getRun,
  listPrompts,
  listResponses,
  listMentionsForRun,
} from "../db";
import type {
  BrandStats,
  Framing,
  MentionRow,
  PromptStats,
  RunMetrics,
} from "../types";

/** Wilson 95% score interval for a binomial proportion. */
function wilson(k: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function computeRunMetrics(runId: string): RunMetrics | null {
  const run = getRun(runId);
  if (!run) return null;
  const project = getProject(run.project_id)!;
  const prompts = listPrompts(project.id);
  const responses = listResponses(runId);
  const mentions = listMentionsForRun(runId);

  const promptById = new Map(prompts.map((p) => [p.id, p]));
  const brandedPromptIds = new Set(
    prompts.filter((p) => p.theme === "branded").map((p) => p.id)
  );
  // Headline rates use unbranded prompts only — asking about the brand by
  // name trivially guarantees a mention.
  const unbranded = responses.filter((r) => !brandedPromptIds.has(r.prompt_id));
  const unbrandedIds = new Set(unbranded.map((r) => r.id));

  const targetNorm = project.brand.trim().toLowerCase();
  const competitorNorms = new Set(
    project.competitors.map((c) => c.trim().toLowerCase())
  );

  // --- per-brand stats over unbranded responses ---
  const byBrand = new Map<string, { display: string; rows: MentionRow[] }>();
  for (const m of mentions) {
    if (!unbrandedIds.has(m.response_id)) continue;
    const entry = byBrand.get(m.brand_norm) ?? { display: m.brand, rows: [] };
    entry.rows.push(m);
    byBrand.set(m.brand_norm, entry);
  }
  const totalMentions = [...byBrand.values()].reduce(
    (acc, e) => acc + e.rows.length,
    0
  );

  const brands: BrandStats[] = [...byBrand.entries()].map(([norm, entry]) => {
    const k = entry.rows.length;
    const n = unbranded.length;
    const ci = wilson(k, n);
    const framing: Record<Framing, number> = {
      recommended: 0,
      mentioned: 0,
      negative: 0,
    };
    for (const row of entry.rows) framing[row.framing as Framing]++;
    return {
      brand: norm === targetNorm ? project.brand : entry.display,
      isTarget: norm === targetNorm,
      isCompetitor: competitorNorms.has(norm),
      mentionCount: k,
      mentionRate: n > 0 ? k / n : 0,
      ciLow: ci.low,
      ciHigh: ci.high,
      avgRank:
        k > 0 ? entry.rows.reduce((acc, r) => acc + r.rank, 0) / k : null,
      shareOfVoice: totalMentions > 0 ? k / totalMentions : 0,
      framing,
    };
  });
  brands.sort((a, b) => b.mentionRate - a.mentionRate);

  // Guarantee the target brand appears even at zero mentions.
  if (!brands.some((b) => b.isTarget)) {
    const ci = wilson(0, unbranded.length);
    brands.push({
      brand: project.brand,
      isTarget: true,
      isCompetitor: false,
      mentionCount: 0,
      mentionRate: 0,
      ciLow: ci.low,
      ciHigh: ci.high,
      avgRank: null,
      shareOfVoice: 0,
      framing: { recommended: 0, mentioned: 0, negative: 0 },
    });
  }

  // --- per-prompt stats for the target brand ---
  const targetByResponse = new Map<string, MentionRow>();
  for (const m of mentions) {
    if (m.brand_norm === targetNorm) targetByResponse.set(m.response_id, m);
  }
  const promptStats: PromptStats[] = prompts.map((p) => {
    const rows = responses.filter((r) => r.prompt_id === p.id);
    const hits = rows.filter((r) => targetByResponse.has(r.id));
    const ranks = hits.map((r) => targetByResponse.get(r.id)!.rank);
    return {
      promptId: p.id,
      text: p.text,
      theme: p.theme,
      responses: rows.length,
      targetMentions: hits.length,
      targetRate: rows.length > 0 ? hits.length / rows.length : 0,
      targetAvgRank:
        ranks.length > 0
          ? ranks.reduce((a, b) => a + b, 0) / ranks.length
          : null,
    };
  });

  // --- sample verbatims: prefer responses that mention the target ---
  const withTarget = unbranded.filter((r) => targetByResponse.has(r.id));
  const withoutTarget = unbranded.filter((r) => !targetByResponse.has(r.id));
  const verbatims = [...withTarget.slice(0, 2), ...withoutTarget.slice(0, 2)].map(
    (r) => ({
      promptText: promptById.get(r.prompt_id)?.text ?? "",
      text: r.text.length > 600 ? r.text.slice(0, 600) + "…" : r.text,
      mentionsTarget: targetByResponse.has(r.id),
    })
  );

  return {
    runId,
    model: run.model,
    mock: run.mock === 1,
    totalResponses: responses.length,
    unbrandedResponses: unbranded.length,
    brands,
    prompts: promptStats,
    verbatims,
  };
}
