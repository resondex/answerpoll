import { store } from "../store";
import type {
  BrandStats,
  DictionaryEntry,
  Framing,
  MentionRow,
  PromptBadge,
  PromptStats,
  PromptTheme,
  ResponseRow,
  RunMetrics,
  ThemeStats,
} from "../types";

const THEME_ORDER: PromptTheme[] = [
  "discovery",
  "recommendation",
  "comparison",
  "use_case",
  "branded",
];

/** Wilson 95% score interval for a binomial proportion. */
export function wilson(k: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * Read-time canonicalizer built from the project dictionary: raw extracted
 * names collapse onto canonical brands (aliases merged), so dictionary edits
 * retroactively clean every run without re-coding.
 */
export function buildCanonicalizer(entries: DictionaryEntry[]) {
  // Match strings (canonical + aliases) are fossilized and drive identity;
  // display_name is a renameable label that never affects matching, so
  // scheduled runs stay comparable across renames.
  const aliasMap = new Map<string, { canonical: string; display: string }>();
  for (const e of entries) {
    if (e.status !== "active") continue;
    const value = { canonical: e.canonical, display: e.display_name ?? e.canonical };
    aliasMap.set(e.canonical.trim().toLowerCase(), value);
    for (const a of e.aliases) aliasMap.set(a.trim().toLowerCase(), value);
  }
  return {
    /** User-facing label for a raw extracted name. */
    canonical(raw: string): string {
      return aliasMap.get(raw.trim().toLowerCase())?.display ?? raw.trim();
    },
    /** Stable identity key — from the fossilized canonical, never the label. */
    norm(raw: string): string {
      const hit = aliasMap.get(raw.trim().toLowerCase());
      return (hit?.canonical ?? raw).trim().toLowerCase();
    },
  };
}

export async function computeRunMetrics(
  runId: string
): Promise<RunMetrics | null> {
  const run = await store.getRun(runId);
  if (!run) return null;
  const [projectMaybe, responses, mentions] = await Promise.all([
    store.getProject(run.project_id),
    store.listResponses(runId),
    store.listMentionsForRun(runId),
  ]);
  const project = projectMaybe!;
  const [prompts, dictionary] = await Promise.all([
    store.listPrompts(project.id),
    store.getDictionary(project.id),
  ]);
  const canon = buildCanonicalizer(dictionary);

  const promptById = new Map(prompts.map((p) => [p.id, p]));
  const brandedPromptIds = new Set(
    prompts.filter((p) => p.theme === "branded").map((p) => p.id)
  );
  // Headline rates use unbranded prompts only — asking about the brand by
  // name trivially guarantees a mention.
  const unbranded = responses.filter((r) => !brandedPromptIds.has(r.prompt_id));
  const unbrandedIds = new Set(unbranded.map((r) => r.id));

  const targetNorm = canon.norm(project.brand);
  const competitorNorms = new Set(project.competitors.map((c) => canon.norm(c)));

  // --- per-brand stats over unbranded responses (canonicalized) ---
  const byBrand = new Map<string, { display: string; rows: MentionRow[] }>();
  const mentionNorm = new Map<string, string>(); // mention id -> canonical norm
  for (const m of mentions) {
    const norm = canon.norm(m.brand);
    mentionNorm.set(m.id, norm);
    if (!unbrandedIds.has(m.response_id)) continue;
    const entry =
      byBrand.get(norm) ?? { display: canon.canonical(m.brand), rows: [] };
    entry.rows.push(m);
    byBrand.set(norm, entry);
  }
  const totalMentions = [...byBrand.values()].reduce(
    (acc, e) => acc + e.rows.length,
    0
  );

  const brands: BrandStats[] = [...byBrand.entries()].map(([norm, entry]) => {
    // Aliases may merge several mentions of one brand within an answer;
    // count distinct answers, and take the best (lowest) rank per answer.
    const perResponse = new Map<string, MentionRow>();
    for (const row of entry.rows) {
      const prev = perResponse.get(row.response_id);
      if (!prev || row.rank < prev.rank) perResponse.set(row.response_id, row);
    }
    const rows = [...perResponse.values()];
    const k = rows.length;
    const n = unbranded.length;
    const ci = wilson(k, n);
    const framing: Record<Framing, number> = {
      recommended: 0,
      mentioned: 0,
      negative: 0,
    };
    for (const row of rows) framing[row.framing as Framing]++;
    return {
      brand: norm === targetNorm ? project.brand : entry.display,
      isTarget: norm === targetNorm,
      isCompetitor: competitorNorms.has(norm),
      mentionCount: k,
      mentionRate: n > 0 ? k / n : 0,
      ciLow: ci.low,
      ciHigh: ci.high,
      avgRank: k > 0 ? rows.reduce((acc, r) => acc + r.rank, 0) / k : null,
      shareOfVoice: totalMentions > 0 ? entry.rows.length / totalMentions : 0,
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
    if (mentionNorm.get(m.id) === targetNorm) {
      const prev = targetByResponse.get(m.response_id);
      if (!prev || m.rank < prev.rank) targetByResponse.set(m.response_id, m);
    }
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

  // --- topic rollups: target visibility aggregated per prompt theme ---
  const themes: ThemeStats[] = THEME_ORDER.flatMap((theme) => {
    const ps = promptStats.filter((p) => p.theme === theme);
    if (ps.length === 0) return [];
    const themeResponses = ps.reduce((a, p) => a + p.responses, 0);
    const hits = ps.reduce((a, p) => a + p.targetMentions, 0);
    const ci = wilson(hits, themeResponses);
    const rankSum = ps.reduce(
      (a, p) => a + (p.targetAvgRank ?? 0) * p.targetMentions,
      0
    );
    return [
      {
        theme,
        prompts: ps.length,
        responses: themeResponses,
        targetMentions: hits,
        targetRate: themeResponses > 0 ? hits / themeResponses : 0,
        ciLow: ci.low,
        ciHigh: ci.high,
        targetAvgRank: hits > 0 ? rankSum / hits : null,
      },
    ];
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

  // ------------------------------------------------------------------
  // Coded layer — present only for runs extracted with the full schema.
  // ------------------------------------------------------------------
  const codedRows = unbranded.filter((r) => r.outcome !== null);
  const coded = codedRows.length > 0;

  let firstPick: RunMetrics["firstPick"] = null;
  let outcomes: RunMetrics["outcomes"] = null;
  let topPicks: RunMetrics["topPicks"] = null;
  let reasonLift: RunMetrics["reasonLift"] = null;
  let promptGrid: RunMetrics["promptGrid"] = null;
  let negatives: RunMetrics["negatives"] = null;
  let positionDist: RunMetrics["positionDist"] = null;

  if (coded) {
    const isTargetPick = (r: ResponseRow) =>
      r.top_pick_brand !== null && canon.norm(r.top_pick_brand) === targetNorm;

    outcomes = {
      pick: codedRows.filter((r) => r.outcome === "pick").length,
      no_pick: codedRows.filter((r) => r.outcome === "no_pick").length,
      clarification: codedRows.filter((r) => r.outcome === "clarification")
        .length,
    };

    const wins = codedRows.filter(isTargetPick);
    const fpCi = wilson(wins.length, codedRows.length);
    firstPick = {
      rate: codedRows.length > 0 ? wins.length / codedRows.length : 0,
      ciLow: fpCi.low,
      ciHigh: fpCi.high,
      count: wins.length,
      of: codedRows.length,
    };

    // Who wins instead — over decided answers.
    const decided = codedRows.filter(
      (r) => r.outcome === "pick" && r.top_pick_brand
    );
    const pickCounts = new Map<string, { display: string; n: number }>();
    for (const r of decided) {
      const norm = canon.norm(r.top_pick_brand!);
      const e =
        pickCounts.get(norm) ?? {
          display: canon.canonical(r.top_pick_brand!),
          n: 0,
        };
      e.n++;
      pickCounts.set(norm, e);
    }
    topPicks = [...pickCounts.entries()]
      .map(([norm, e]) => ({
        brand: norm === targetNorm ? project.brand : e.display,
        isTarget: norm === targetNorm,
        isCompetitor: competitorNorms.has(norm),
        picks: e.n,
        shareOfDecided: decided.length > 0 ? e.n / decided.length : 0,
      }))
      .sort((a, b) => b.picks - a.picks);

    // Reason-code lift — argument share in wins vs overall vs target-absent.
    if (project.reason_taxonomy.length > 0) {
      const reasonsOf = (r: ResponseRow) =>
        new Set((r.reason_codes ?? "").split("|").filter(Boolean));
      const absent = codedRows.filter((r) => !targetByResponse.has(r.id));
      reasonLift = project.reason_taxonomy
        .map((code) => {
          const inAll = codedRows.filter((r) => reasonsOf(r).has(code)).length;
          const inWins = wins.filter((r) => reasonsOf(r).has(code)).length;
          const inAbsent = absent.filter((r) => reasonsOf(r).has(code)).length;
          const shareAll = codedRows.length > 0 ? inAll / codedRows.length : 0;
          const shareWins = wins.length > 0 ? inWins / wins.length : 0;
          const shareAbsent = absent.length > 0 ? inAbsent / absent.length : 0;
          return {
            code,
            n: inAll,
            shareAll,
            shareWins,
            shareAbsent,
            lift: shareWins - shareAll,
          };
        })
        .filter((r) => r.n > 0)
        .sort((a, b) => b.lift - a.lift);
    }

    // Prompt grid: modal pick per prompt + stability + badge.
    promptGrid = prompts
      .filter((p) => p.theme !== "branded")
      .map((p) => {
        const rows = codedRows.filter((r) => r.prompt_id === p.id);
        const decidedRows = rows.filter(
          (r) => r.outcome === "pick" && r.top_pick_brand
        );
        const counts = new Map<string, { display: string; n: number }>();
        for (const r of decidedRows) {
          const norm = canon.norm(r.top_pick_brand!);
          const e =
            counts.get(norm) ?? {
              display: canon.canonical(r.top_pick_brand!),
              n: 0,
            };
          e.n++;
          counts.set(norm, e);
        }
        let modalNorm: string | null = null;
        let modalN = 0;
        let tie = false;
        for (const [norm, e] of counts) {
          if (e.n > modalN) {
            modalNorm = norm;
            modalN = e.n;
            tie = false;
          } else if (e.n === modalN) tie = true;
        }
        const named = rows.filter((r) => targetByResponse.has(r.id)).length;
        const targetPicks = rows.filter(isTargetPick).length;
        const badge: PromptBadge =
          named === 0
            ? "absent"
            : !tie &&
                modalNorm === targetNorm &&
                decidedRows.length > 0 &&
                modalN / decidedRows.length >= 0.5
              ? "win"
              : "contested";
        return {
          promptId: p.id,
          text: p.text,
          theme: p.theme,
          answers: rows.length,
          decided: decidedRows.length,
          modalPick:
            modalNorm && !tie
              ? modalNorm === targetNorm
                ? project.brand
                : counts.get(modalNorm)!.display
              : null,
          modalShare:
            modalNorm && !tie && decidedRows.length > 0
              ? modalN / decidedRows.length
              : null,
          targetNamed: named,
          targetPicks,
          badge,
        };
      });

    // Negatives: answers framing the target negatively, with the quote.
    negatives = responses
      .filter((r) => {
        const tm = targetByResponse.get(r.id);
        return tm?.framing === "negative";
      })
      .map((r) => ({
        promptText: promptById.get(r.prompt_id)?.text ?? "",
        quote: r.focus_quote,
        interpretation: r.focus_interpretation,
      }));

    // Position distribution among answers where the target appears.
    const ranks = [...targetByResponse.entries()]
      .filter(([id]) => unbrandedIds.has(id))
      .map(([, m]) => m.rank);
    positionDist = {
      r1: ranks.filter((r) => r === 1).length,
      r2: ranks.filter((r) => r === 2).length,
      r3: ranks.filter((r) => r === 3).length,
      r4plus: ranks.filter((r) => r >= 4).length,
    };
  }

  return {
    runId,
    model: run.model,
    totalResponses: responses.length,
    unbrandedResponses: unbranded.length,
    brands,
    prompts: promptStats,
    themes,
    verbatims,
    coded,
    firstPick,
    outcomes,
    positionDist,
    topPicks,
    reasonLift,
    promptGrid,
    negatives,
    dictionaryVersion: project.dictionary_version,
  };
}
