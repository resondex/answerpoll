import JSZip from "jszip";
import { store } from "../store";
import {
  buildCanonicalizer,
  computeRunMetrics,
  dictionaryRoles,
  wilson,
} from "./metrics";
import { computeProjectTrend } from "./trend";
import { apiKeyConfigured, openaiClient } from "./providers";
import { buildRunInsights, type InsightsBundle } from "./insights";
import { buildAnalysisWorkbook, buildScorecardWorkbook } from "./workbooks";
import { buildStudyDeck } from "./deck";
import { seededShuffle, verifyStudy, type StudyVerification } from "./verify";
import type { MentionRow, Project, ResponseRow, Run } from "../types";

const SUMMARY_MODEL = process.env.SUGGEST_MODEL ?? "gpt-5-mini";
const SUMMARY_CACHE_MS = 365 * 24 * 3600 * 1000;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows: (string | number | null)[][]): string {
  return (
    "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n"
  );
}

function promptCode(i: number): string {
  return `P${String(i + 1).padStart(2, "0")}`;
}

/**
 * Build the downloadable study bundle for a project — the full deliverable:
 * index, executive summary, scorecard, analysis tables, coded dataset,
 * response library, methodology. Built from the latest completed run plus
 * the trend across all completed runs.
 */
export async function buildStudyBundle(
  project: Project
): Promise<{ filename: string; buffer: Buffer } | null> {
  const runs = await store.listRuns(project.id);
  const complete = runs.filter((r) => r.status === "complete");
  if (complete.length === 0) return null;
  const run = complete[0];

  const [metrics, prompts, responses, mentions, trend, dictionary] =
    await Promise.all([
      computeRunMetrics(run.id),
      store.listPrompts(project.id),
      store.listResponses(run.id),
      store.listMentionsForRun(run.id),
      computeProjectTrend(project.id),
      store.getDictionary(project.id),
    ]);
  if (!metrics) return null;
  const canon = buildCanonicalizer(dictionary);

  const promptById = new Map(prompts.map((p, i) => [p.id, { ...p, idx: i }]));
  const mentionsByResponse = new Map<string, MentionRow[]>();
  for (const m of mentions) {
    const list = mentionsByResponse.get(m.response_id) ?? [];
    list.push(m);
    mentionsByResponse.set(m.response_id, list);
  }
  for (const list of mentionsByResponse.values()) list.sort((a, b) => a.rank - b.rank);

  const targetNorm = canon.norm(project.brand);
  const brandType = dictionaryRoles(dictionary, project, canon);

  const brandedIds = new Set(prompts.filter((p) => p.theme === "branded").map((p) => p.id));
  const unbranded = responses.filter((r) => !brandedIds.has(r.prompt_id));

  // First-named: the target is the first brand in the answer.
  const firstNamed = unbranded.filter(
    (r) => mentionsByResponse.get(r.id)?.[0]?.brand_norm === targetNorm
  );
  const fnRate = unbranded.length > 0 ? firstNamed.length / unbranded.length : 0;
  const fnCi = wilson(firstNamed.length, unbranded.length);
  const target = metrics.brands.find((b) => b.isTarget)!;

  const stamp = (run.completed_at ?? run.created_at).slice(0, 10);
  const slug = project.brand.replace(/[^a-zA-Z0-9]+/g, "_");
  const title = `${project.brand} AI Visibility Study`;
  const header = `${title} - ${project.category} | Answerpoll by Resondex | ${stamp}`;

  const zip = new JSZip();
  const root = zip.folder(`${slug}_ai_visibility_study_${stamp}`)!;

  // ---------- 02: scorecard ----------
  const scorecardRows: (string | number | null)[][] = [
    ["metric", "value", "95% CI", "what it captures"],
    ["Representation", pct(target.mentionRate), `${pct(target.ciLow)}-${pct(target.ciHigh)}`,
      `Any mention of ${project.brand} in an unbranded answer (${target.mentionCount} of ${metrics.unbrandedResponses})`],
    ["First-named", pct(fnRate), `${pct(fnCi.low)}-${pct(fnCi.high)}`,
      `${project.brand} is the FIRST brand named (${firstNamed.length} of ${unbranded.length})`],
    ["Average position", target.avgRank ? `#${target.avgRank.toFixed(1)}` : "-", "",
      "Where the brand sits in the answer when it appears"],
    ["Share of voice", pct(target.shareOfVoice), "",
      "Share of all brand mentions across answers"],
    ["Answers sampled", metrics.unbrandedResponses, "",
      `${prompts.filter((p) => p.theme !== "branded").length} unbranded prompts x ${run.repeats} repeats, ${run.model}`],
    ["Brands surfaced", metrics.brands.length, "",
      "Distinct brands the model named, including unprompted competitors"],
  ];
  if (metrics.coded && metrics.firstPick) {
    scorecardRows.splice(2, 0, [
      "First pick",
      pct(metrics.firstPick.rate),
      `${pct(metrics.firstPick.ciLow)}-${pct(metrics.firstPick.ciHigh)}`,
      `An answer crowns ${project.brand} as THE recommendation (${metrics.firstPick.count} of ${metrics.firstPick.of}) - being mentioned is representation, being picked is the win`,
    ]);
    if (metrics.outcomes) {
      scorecardRows.push([
        "Answer outcomes",
        `${metrics.outcomes.pick} pick / ${metrics.outcomes.no_pick} no pick / ${metrics.outcomes.clarification} clarification`,
        "",
        "Whether answers committed to a recommendation, explained without one, or asked a question",
      ]);
    }
  }
  root.file("02_scorecard/scorecard.csv", toCsv(scorecardRows));

  const gridRows: (string | number | null)[][] = [
    ["code", "theme", "prompt", "answers", "target_named", "named_rate", "target_first_named", "avg_position"],
  ];
  for (const p of prompts) {
    const info = promptById.get(p.id)!;
    const rows = responses.filter((r) => r.prompt_id === p.id);
    const named = rows.filter((r) =>
      mentionsByResponse.get(r.id)?.some((m) => m.brand_norm === targetNorm)
    );
    const first = rows.filter(
      (r) => mentionsByResponse.get(r.id)?.[0]?.brand_norm === targetNorm
    );
    const ranks = named
      .map((r) => mentionsByResponse.get(r.id)!.find((m) => m.brand_norm === targetNorm)!.rank);
    gridRows.push([
      promptCode(info.idx), p.theme, p.text, rows.length, named.length,
      rows.length ? (named.length / rows.length).toFixed(2) : null,
      first.length,
      ranks.length ? (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1) : null,
    ]);
  }
  root.file("02_scorecard/prompt_grid.csv", toCsv(gridRows));

  // ---------- 03: analysis tables ----------
  root.file("03_analysis/brand_leaderboard.csv", toCsv([
    ["brand", "type", "mention_count", "mention_rate", "ci_low", "ci_high", "avg_position", "share_of_voice", "recommended", "mentioned", "negative"],
    ...metrics.brands.map((b) => [
      b.brand, b.isTarget ? "target" : b.isCompetitor ? "competitor" : "emerged",
      b.mentionCount, b.mentionRate.toFixed(4), b.ciLow.toFixed(4), b.ciHigh.toFixed(4),
      b.avgRank?.toFixed(2) ?? null, b.shareOfVoice.toFixed(4),
      b.framing.recommended, b.framing.mentioned, b.framing.negative,
    ]),
  ]));
  root.file("03_analysis/theme_rollup.csv", toCsv([
    ["theme", "prompts", "answers", "target_mentions", "target_rate", "ci_low", "ci_high", "target_avg_position"],
    ...metrics.themes.map((t) => [
      t.theme, t.prompts, t.responses, t.targetMentions, t.targetRate.toFixed(4),
      t.ciLow.toFixed(4), t.ciHigh.toFixed(4), t.targetAvgRank?.toFixed(2) ?? null,
    ]),
  ]));
  if (metrics.coded) {
    if (metrics.topPicks) {
      root.file("03_analysis/top_picks.csv", toCsv([
        ["brand", "type", "first_picks", "share_of_decided"],
        ...metrics.topPicks.map((t) => [
          t.brand,
          t.isTarget ? "target" : t.isCompetitor ? "competitor" : "emerged",
          t.picks,
          t.shareOfDecided.toFixed(4),
        ]),
      ]));
    }
    if (metrics.reasonLift) {
      root.file("03_analysis/reason_lift.csv", toCsv([
        ["reason_code", "answers_using", "share_all", "share_in_target_wins", "share_when_target_absent", "lift_points"],
        ...metrics.reasonLift.map((r) => [
          r.code, r.n, r.shareAll.toFixed(4), r.shareWins.toFixed(4),
          r.shareAbsent.toFixed(4), (r.lift * 100).toFixed(1),
        ]),
      ]));
    }
    if (metrics.promptGrid) {
      root.file("02_scorecard/prompt_grid_badges.csv", toCsv([
        ["prompt", "theme", "answers", "decided", "consensus_pick", "consensus_share", "target_named", "target_picks", "badge"],
        ...metrics.promptGrid.map((g) => [
          g.text, g.theme, g.answers, g.decided, g.modalPick,
          g.modalShare?.toFixed(2) ?? null, g.targetNamed, g.targetPicks, g.badge,
        ]),
      ]));
    }
    if (metrics.negatives && metrics.negatives.length > 0) {
      root.file("03_analysis/negatives.csv", toCsv([
        ["prompt", "verbatim_quote", "interpretation"],
        ...metrics.negatives.map((n) => [n.promptText, n.quote, n.interpretation]),
      ]));
    }
  }

  if (trend && trend.runs.length >= 2) {
    const trendRows: (string | number | null)[][] = [["run_date", "model", "answers", "brand", "mention_rate", "ci_low", "ci_high", "share_of_voice"]];
    trend.series.forEach((s) => {
      s.points.forEach((pt, i) => {
        trendRows.push([
          trend.runs[i].date, trend.runs[i].model, trend.runs[i].unbranded,
          s.brand, pt.rate.toFixed(4), pt.ciLow.toFixed(4), pt.ciHigh.toFixed(4), pt.shareOfVoice.toFixed(4),
        ]);
      });
    });
    root.file("03_analysis/trend.csv", toCsv(trendRows));
  }

  // ---------- 04: master coded dataset ----------
  const masterRows: (string | number | null)[][] = [[
    "response_id", "run_id", "run_date", "model", "finish_reason", "coder_model",
    "n_citations", "prompt_code", "theme", "prompt_text",
    "repeat_idx", "word_count", "target_present", "target_first_named", "target_position",
    "first_brand", "n_brands", "brands_in_order", "recommended_brands", "negative_brands",
    "top_pick_brand", "top_pick_canonical", "outcome", "reason_codes",
    "clarification_requested", "gives_recommendation", "includes_prices",
    "includes_specs", "total_recommendations", "focus_quote", "focus_interpretation",
    "dictionary_version",
  ]];
  for (const r of responses) {
    const p = promptById.get(r.prompt_id)!;
    const ms = mentionsByResponse.get(r.id) ?? [];
    const tm = ms.find((m) => m.brand_norm === targetNorm);
    masterRows.push([
      r.id, run.id, stamp, r.model || run.model, r.finish_reason,
      r.coder_model, r.citations?.length ?? 0, promptCode(p.idx), p.theme, p.text,
      r.repeat_idx, r.text.split(/\s+/).length,
      tm ? 1 : 0, ms[0]?.brand_norm === targetNorm ? 1 : 0, tm?.rank ?? null,
      ms[0]?.brand ?? null, ms.length, ms.map((m) => m.brand).join("|"),
      ms.filter((m) => m.framing === "recommended").map((m) => m.brand).join("|"),
      ms.filter((m) => m.framing === "negative").map((m) => m.brand).join("|"),
      r.top_pick_brand, r.top_pick_brand ? canon.canonical(r.top_pick_brand) : null,
      r.outcome, r.reason_codes,
      r.clarification_requested, r.gives_recommendation, r.includes_prices,
      r.includes_specs, r.total_recommendations, r.focus_quote,
      r.focus_interpretation, metrics.dictionaryVersion,
    ]);
  }
  root.file("04_master_dataset/responses.csv", toCsv(masterRows));
  root.file("04_master_dataset/mentions.csv", toCsv([
    ["response_id", "prompt_code", "theme", "repeat_idx", "brand_raw", "brand_canonical", "brand_type", "position", "framing"],
    ...responses.flatMap((r) => {
      const p = promptById.get(r.prompt_id)!;
      return (mentionsByResponse.get(r.id) ?? []).map((m) => [
        r.id, promptCode(p.idx), p.theme, r.repeat_idx, m.brand,
        canon.canonical(m.brand), brandType(canon.norm(m.brand)), m.rank, m.framing,
      ]);
    }),
  ]));
  // Citations: one row per (answer, source URL) from grounded engines —
  // the evidence layer behind the source-landscape analysis.
  if (responses.some((r) => r.citations && r.citations.length > 0)) {
    root.file("04_master_dataset/citations.csv", toCsv([
      ["response_id", "model", "prompt_code", "theme", "domain", "url"],
      ...responses.flatMap((r) => {
        if (!r.citations) return [];
        const p = promptById.get(r.prompt_id)!;
        return r.citations.flatMap((url) => {
          let domain: string;
          try {
            domain = new URL(url).hostname.replace(/^www\./, "");
          } catch {
            return [];
          }
          return [[r.id, r.model || run.model, promptCode(p.idx), p.theme, domain, url]];
        });
      }),
    ]));
  }
  if (metrics.sources && metrics.sources.domains.length > 0) {
    root.file("03_analysis/source_landscape.csv", toCsv([
      ["domain", "owned_by_brand", "citing_answers", "share_of_cited_answers"],
      ...metrics.sources.domains.map((d) => [
        d.domain, d.brand, d.answers, d.share.toFixed(4),
      ]),
    ]));
  }
  if (dictionary.length > 0) {
    root.file("04_master_dataset/dictionary.csv", toCsv([
      ["canonical", "aliases", "status", "entry_version"],
      ...dictionary.map((d) => [d.canonical, d.aliases.join("|"), d.status, d.version]),
    ]));
  }

  // ---------- 05: response library ----------
  for (const p of prompts) {
    const info = promptById.get(p.id)!;
    const dirName = `05_response_library/${promptCode(info.idx)} - ${p.text.replace(/[^a-zA-Z0-9 ]+/g, "").slice(0, 60).trim()}`;
    const rows = responses
      .filter((r) => r.prompt_id === p.id)
      .sort((a, b) => a.repeat_idx - b.repeat_idx);
    for (const r of rows) {
      const ms = mentionsByResponse.get(r.id) ?? [];
      const md = [
        `# ${promptCode(info.idx)} - repeat ${r.repeat_idx + 1}`,
        "",
        `**Prompt (${p.theme}):** ${p.text}`,
        `**Model:** ${r.model || run.model} | **Captured:** ${r.created_at} | **Response:** ${r.id}`,
        "",
        "## Brands named, in order",
        ms.length
          ? ms.map((m) => `${m.rank}. ${m.brand} (${brandType(m.brand_norm)}, ${m.framing})`).join("\n")
          : "_none_",
        "",
        "## Answer",
        "",
        r.text,
      ].join("\n");
      root.file(`${dirName}/repeat_${r.repeat_idx + 1}.md`, md);
    }
  }

  // ---------- live-formula workbooks (02 + 03) ----------
  let insights: InsightsBundle | null = null;
  if (apiKeyConfigured()) {
    try {
      insights = await buildRunInsights(run.id);
    } catch (err) {
      console.error("insights unavailable for workbooks:", err);
    }
  }
  try {
    const wbInputs = {
      project, run, metrics, prompts, responses, mentionsByResponse, canon,
      dictionary, insights,
      promptCode: (promptId: string) =>
        promptCode(promptById.get(promptId)!.idx),
    };
    const [scorecardWb, analysisWb] = await Promise.all([
      buildScorecardWorkbook(wbInputs),
      buildAnalysisWorkbook(wbInputs),
    ]);
    root.file("02_scorecard/scorecard_workbook.xlsx", scorecardWb);
    root.file("03_analysis/analysis_workbook.xlsx", analysisWb);
    const [deck, deckBeta] = await Promise.all([
      buildStudyDeck({ ...wbInputs, trend, variant: "standard" }),
      buildStudyDeck({ ...wbInputs, trend, variant: "ai_beta" }),
    ]);
    root.file("07_summary_deck/summary_deck.pptx", deck);
    root.file("07_summary_deck/summary_deck_ai_beta.pptx", deckBeta);
  } catch (err) {
    console.error("workbook/deck build failed — CSVs still ship:", err);
  }
  if (insights) {
    const insightsMd = [
      "# Insights and plays",
      "",
      header,
      "",
      ...insights.sections.flatMap((s) => [
        `## ${s.title}`,
        "",
        ...s.insights.map((t, i) => `${i + 1}. ${t}`),
        "",
      ]),
      "## Recommended plays",
      "",
      ...insights.plays.flatMap((p) => [
        `### ${p.title}`,
        "",
        `${p.gap}`,
        "",
        `**Play:** ${p.play}`,
        "",
        `**Measured by:** ${p.measuredBy} - today ${p.today}. Re-run the study and this play grades itself.`,
        "",
      ]),
      "---",
      "",
      `Every figure above was substituted from the study's verified fact registry (${insights.verification.figuresSupplied} facts) and gate-checked against the dataset before shipping.`,
    ].join("\n");
    root.file("01_executive_summary/insights_and_plays.md", insightsMd);
  }

  // ---------- 01: executive summary ----------
  const summary = await executiveSummary(project, run, metrics, {
    fnRate, fnCi, firstNamed: firstNamed.length, unbranded: unbranded.length,
    trendRuns: trend?.runs.length ?? 1,
  });
  root.file("01_executive_summary/executive_summary.md", `# Executive summary\n\n${header}\n\n${summary}\n`);

  // ---------- 06: methodology, verification, validation sample ----------
  root.file("06_methodology/methodology.md", methodologyDoc(project, run, metrics, prompts.length));

  const verification = verifyStudy({
    project, run, prompts, responses, mentions, metrics, canon,
  });
  if (!verification.allPassed) {
    console.error(
      "study verification FAILED:",
      verification.checks.filter((c) => !c.pass)
    );
  }
  root.file(
    "06_methodology/verification.md",
    verificationDoc(project, run, metrics, verification, insights)
  );

  // Human-validation sample: a reproducible draw of coded answers with blank
  // grading columns, so anyone can audit the coder by hand. Same run, same
  // sample — the draw is seeded by the run id.
  const codedPool = responses.filter((r) => r.outcome !== null);
  if (codedPool.length > 0) {
    const nSample = Math.min(codedPool.length, Math.max(12, Math.ceil(codedPool.length * 0.05)));
    const drawn = seededShuffle(codedPool, run.id).slice(0, nSample);
    root.file("06_methodology/validation_sample.csv", toCsv([
      [
        "response_id", "model", "prompt_code", "prompt_text", "repeat_idx",
        "coded_top_pick", "coded_outcome", "coded_brands_in_order", "answer_text",
        "human_top_pick", "human_outcome", "human_agrees_1_0", "notes",
      ],
      ...drawn.map((r) => {
        const p = promptById.get(r.prompt_id)!;
        const ms = mentionsByResponse.get(r.id) ?? [];
        return [
          r.id, r.model || run.model, promptCode(p.idx), p.text, r.repeat_idx,
          r.top_pick_brand, r.outcome, ms.map((m) => m.brand).join("|"),
          r.text, null, null, null, null,
        ];
      }),
    ]));
  }

  // ---------- 00: README & index ----------
  root.file("00_README.md", readmeDoc(project, run, metrics, {
    fnRate, fnCi, firstNamed: firstNamed.length, unbranded: unbranded.length,
    hasTrend: Boolean(trend && trend.runs.length >= 2), stamp,
  }));

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { filename: `${slug}_ai_visibility_study_${stamp}.zip`, buffer: buffer as Buffer };
}

async function executiveSummary(
  project: Project,
  run: Run,
  metrics: NonNullable<Awaited<ReturnType<typeof computeRunMetrics>>>,
  extra: { fnRate: number; fnCi: { low: number; high: number }; firstNamed: number; unbranded: number; trendRuns: number }
): Promise<string> {
  const cacheKey = `study_summary:v2:${run.id}`;
  const hit = await store.cacheGet(cacheKey, SUMMARY_CACHE_MS);
  if (hit) return hit;
  const fallback =
    `${project.brand} appears in ${pct(metrics.brands.find((b) => b.isTarget)!.mentionRate)} of unbranded answers ` +
    `and is the first brand named in ${pct(extra.fnRate)}. Full metrics in 02_scorecard.`;
  if (!apiKeyConfigured()) return fallback;
  try {
    // Pre-formatted strings only — the writer must never see raw decimals.
    const fmtBrand = (b: (typeof metrics.brands)[number]) => ({
      brand: b.brand,
      type: b.isTarget ? "target" : b.isCompetitor ? "competitor" : "emerged",
      mention_rate: `${pct(b.mentionRate)} (CI ${pct(b.ciLow)}-${pct(b.ciHigh)})`,
      avg_position: b.avgRank ? `#${b.avgRank.toFixed(1)}` : "never named",
      share_of_voice: pct(b.shareOfVoice),
      recommended_count: b.framing.recommended,
      negative_count: b.framing.negative,
    });
    const payload = {
      brand: project.brand, category: project.category, audience: project.audience,
      model_measured: run.model, repeats_per_prompt: run.repeats,
      unbranded_answers: metrics.unbrandedResponses,
      target: fmtBrand(metrics.brands.find((b) => b.isTarget)!),
      first_named: `${pct(extra.fnRate)} (CI ${pct(extra.fnCi.low)}-${pct(extra.fnCi.high)}) — first brand in the answer ${extra.firstNamed} of ${extra.unbranded} times`,
      top_brands: metrics.brands.slice(0, 8).map(fmtBrand),
      first_pick: metrics.firstPick
        ? `${pct(metrics.firstPick.rate)} (CI ${pct(metrics.firstPick.ciLow)}-${pct(metrics.firstPick.ciHigh)}) — an answer crowns ${project.brand} as THE pick ${metrics.firstPick.count} of ${metrics.firstPick.of} times`
        : "not coded in this run",
      who_wins_instead: metrics.topPicks
        ? metrics.topPicks.slice(0, 6).map((t) => `${t.brand}: ${t.picks} picks (${pct(t.shareOfDecided)})`)
        : null,
      arguments_lift: metrics.reasonLift
        ? {
            carrying_wins: metrics.reasonLift.slice(0, 4).map((r) => `${r.code} (+${(r.lift * 100).toFixed(0)} pts)`),
            keeping_out: metrics.reasonLift.slice(-3).map((r) => `${r.code} (${(r.lift * 100).toFixed(0)} pts)`),
          }
        : null,
      themes: metrics.themes.map((t) => ({
        theme: t.theme,
        prompts: t.prompts,
        target_rate: `${pct(t.targetRate)} (CI ${pct(t.ciLow)}-${pct(t.ciHigh)})`,
        target_avg_position: t.targetAvgRank ? `#${t.targetAvgRank.toFixed(1)}` : "never named",
      })),
      completed_runs_in_trend: extra.trendRuns,
    };
    const res = await openaiClient().chat.completions.create({
      model: SUMMARY_MODEL,
      messages: [
        {
          role: "system",
          content:
            "Write the executive summary for an AI brand-visibility study, in the " +
            "Resondex voice: decisive and action-oriented, plainspoken about " +
            "complexity, confident without hype, positive-framed (never 'not just " +
            "X' constructions), sentence case headings. Use hyphens, never em " +
            "dashes. Structure: 'The bottom line' (2-3 sentences leading with the " +
            "decisive finding), 'The numbers at a glance' (markdown table: metric, " +
            "result with CI where given, what it captures), 'Where the brand wins " +
            "and where it is absent' (read the theme table - name the strongest " +
            "and weakest themes and what that means for the buyer journey), 'The " +
            "competitive field' (2-3 sentences on who owns the conversation, " +
            "including brands the model volunteered), and 'What to do next' (three " +
            "concrete, prioritized recommendations grounded in the data). Every " +
            "number must come from the data provided - never invent one. Keep it " +
            "under 500 words.",
        },
        { role: "user", content: JSON.stringify(payload) },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim();
    if (!text) return fallback;
    await store.cacheSet(cacheKey, text);
    return text;
  } catch {
    return fallback;
  }
}

function methodologyDoc(
  project: Project,
  run: Run,
  metrics: NonNullable<Awaited<ReturnType<typeof computeRunMetrics>>>,
  nPrompts: number
): string {
  return `# Methodology

${project.brand} AI Visibility Study | Answerpoll by Resondex

## Design

This study measures how an AI assistant recommends ${project.category}, with
${project.brand} as the focus brand. Every measurement follows the same
design: a calibrated battery of ${nPrompts} prompts, each sampled
${run.repeats} times against ${run.models.length > 1 ? `each of ${run.models.length} assistants (${run.models.join(", ")})` : run.model} through its API, for
${metrics.totalResponses} coded answers in this run.

Sampling is the core of the method. LLM answers vary from ask to ask - a
single response is an anecdote. Repeats turn each rate into an estimate with
a 95% Wilson confidence interval, reported alongside every headline number.

## The prompt battery

Prompts are unbranded by design - they never name ${project.brand} or any
competitor, so mention rates measure genuine recall, the machine equivalent
of unaided brand awareness. Two branded probes are tracked separately and
excluded from headline rates.

The battery's style and composition are calibrated to real buyer behavior:
1,006 verified commercial prompts sampled from WildChat, the largest public
corpus of real AI conversations. Prompt length, register, and the mix of
question types (59% discovery, 27% recommendation, 8% comparison, 6%
use-case) match the measured distribution of real commercial asks. A
forced-choice test found judges rate these prompts more human than actual
user traffic, and a paired experiment confirmed that surface polish does not
change brand measurements. Full calibration research: the Answerpoll
research repository.

Every battery is reviewed by the study owner before it runs.

## Collection

Answers are collected through the assistant's API in fresh, stateless
sessions - no account history, no personalization, no memory. This isolates
the model's default recommendation behavior: the clean baseline every
signed-in user's personalized answer deviates from. Collection is fully
scripted and reproducible; the same battery can be re-run at any time for
trend measurement.

## Coding

Every answer is parsed by ONE fixed structured extraction model - the same
coder across every engine, recorded per answer in the coder_model column -
so differences between engines are differences in their answers, never in
the coding. The coder records each brand named, in order of first
appearance, with a framing code (recommended / mentioned / negative).
Emergent brands - competitors the model volunteers that the study didn't
name - are captured with the same treatment. Grounded engines' source URLs
are stored verbatim per answer (04_master_dataset/citations.csv). The full
coded dataset ships in 04_master_dataset; every number in this study can be
recomputed from it. See verification.md for the independent recount, the
per-engine run-health table, and the human validation sample.

## Metrics

- Representation: share of unbranded answers naming the focus brand at all.
- First-named: share where the focus brand is the first brand in the answer.
- Average position: mean rank of the brand's first appearance when named.
- Share of voice: the brand's mentions as a share of all brand mentions.
- All rates carry 95% Wilson confidence intervals.

## Limitations - stated openly

- Results describe the sampled engines specifically
  (${run.models.length > 0 ? run.models.join(", ") : run.model}); other
  assistants, and the same assistants inside consumer apps with
  personalization, may differ.
- API collection measures each model's default text answers; it does not
  capture platform-side ad units. Source citations are captured where the
  API returns them (grounded engines such as Perplexity); ungrounded models
  answer from training and have no sources to report.
- Confidence intervals reflect sampling variation at n=${run.repeats} per
  prompt; differences smaller than the interval widths should be read as
  parity.
`;
}

function verificationDoc(
  project: Project,
  run: Run,
  metrics: NonNullable<Awaited<ReturnType<typeof computeRunMetrics>>>,
  v: StudyVerification,
  insights: InsightsBundle | null
): string {
  const engines = run.models.length > 0 ? run.models : [run.model];
  const coders = [...new Set(v.engineHealth.flatMap((e) => e.coders))];
  const checkRows = v.checks
    .map((c) => `| ${c.name} | ${c.expected} | ${c.actual} | ${c.pass ? "pass" : "**FAIL**"} |`)
    .join("\n");
  const healthRows = v.engineHealth
    .map((e) =>
      `| ${e.engine} | ${e.stored} | ${e.naturalStops} | ${e.truncated} | ${e.unreported} | ${e.citedAnswers} |`
    )
    .join("\n");
  return `# Verification & data lock

${project.brand} AI Visibility Study | Answerpoll by Resondex

## Data lock

| | |
|---|---|
| Run | ${run.id} |
| Collected | ${run.started_at ?? run.created_at} to ${run.completed_at ?? "-"} |
| Engines sampled | ${engines.join(", ")} |
| Extraction coder | ${coders.length > 0 ? coders.join(", ") : "recorded per answer from 2026-08-09 onward"} - one fixed model codes every engine's answers, so engine differences are differences in the answers, never in the coder |
| Dictionary version | v${metrics.dictionaryVersion} |
| Answers in this study | ${metrics.totalResponses} |

Raw answers, the coded dataset, and the dictionary all ship in this package.
Every figure can be recomputed from 04_master_dataset alone.

## Independent recount

Before this package shipped, every headline figure was recounted from the
raw response and mention rows by a second code path that shares nothing
with the metrics engine except the frame definitions. The dashboard, the
workbooks, and the decks all render the same metrics object, so one
confirmed recount vouches for every surface at once.

| Figure | Reported | Recounted | Check |
|---|---|---|---|
${checkRows}

${v.allPassed ? "All checks passed." : "**One or more checks FAILED - treat the affected figures with caution and contact Resondex.**"}

## Run health - how every answer terminated

Expected answers per engine: ${v.expectedPerEngine} (active prompts x repeats).
${v.balanced ? "Every engine returned a full, balanced sample." : "**Engines returned unequal answer counts - per-engine comparisons may be affected.**"}

| Engine | Stored | Natural stops | Truncated | Unreported | With citations |
|---|---|---|---|---|---|
${healthRows}

'Truncated' answers hit a vendor length cap and may lose their final verdict;
'unreported' answers predate finish-reason capture (2026-08-09) or the vendor
omitted the field. Truncation counts are recorded facts here, never guesses.

${insights ? `## Written-insight verification

Narrative insights are written by a language model that may only cite
figures as placeholders; every number is substituted server-side from a
registry of ${insights.verification.figuresSupplied} pre-computed facts, and
any sentence carrying an unsourced number is deleted before you see it. The
prose cannot disagree with the workbooks.

` : ""}## Human validation sample

validation_sample.csv holds a reproducible random draw of coded answers
(seeded by the run id - the same run always nominates the same answers) with
the machine coding alongside blank human-grading columns. To audit the coder:
read each answer, fill human_top_pick / human_outcome, and mark
human_agrees_1_0. Disagreement above ~5% is worth a conversation with us.
`;
}

function readmeDoc(
  project: Project,
  run: Run,
  metrics: NonNullable<Awaited<ReturnType<typeof computeRunMetrics>>>,
  x: { fnRate: number; fnCi: { low: number; high: number }; firstNamed: number; unbranded: number; hasTrend: boolean; stamp: string }
): string {
  const target = metrics.brands.find((b) => b.isTarget)!;
  return `# ${project.brand} AI Visibility Study - README & index

${project.category} | Answerpoll by Resondex | ${x.stamp}

## What this is

A sampled measurement of how ${run.models.length > 1 ? `${run.models.length} AI assistants (${run.models.join(", ")}) recommend` : `${run.model} recommends`} ${project.category},
with ${project.brand} as the focus brand. ${metrics.totalResponses} answers
were collected and coded - every prompt asked ${run.repeats} times, so every
rate below carries a confidence interval instead of resting on a single
response.

## Headline findings

| Metric | Result | Reading |
|---|---|---|
| Representation | ${pct(target.mentionRate)} (CI ${pct(target.ciLow)}-${pct(target.ciHigh)}) | Named in ${target.mentionCount} of ${metrics.unbrandedResponses} unbranded answers |
| First-named | ${pct(x.fnRate)} (CI ${pct(x.fnCi.low)}-${pct(x.fnCi.high)}) | The first brand in the answer ${x.firstNamed} of ${x.unbranded} times |
| Average position | ${target.avgRank ? "#" + target.avgRank.toFixed(1) : "-"} | Where the brand sits when it appears |
| Share of voice | ${pct(target.shareOfVoice)} | Of all brand mentions across answers |

## How this study is organized

| Folder | Contents |
|---|---|
| 00_README.md | This document - the map of the package |
| 01_executive_summary | The findings, numbered insights, and plays with baselines |
| 02_scorecard | Live-formula workbook + CSVs: headline metrics and the per-prompt grid - every rate is a COUNTIFS you can click and trace |
| 03_analysis | Live-formula workbook + CSVs: leaderboard, top picks, argument lift, positions, parents${x.hasTrend ? ", trend across runs" : ""} |
| 04_master_dataset | Every coded answer and every brand mention - recompute anything |
| 05_response_library | The full text of every sampled answer, filed by prompt |
| 06_methodology | Design, collection, coding, limits - plus verification.md (independent recount + per-engine run health) and a human validation sample |

## Suggested reading order

1. 01_executive_summary for the narrative.
2. 02_scorecard for the at-a-glance numbers.
3. 03_analysis to go deeper - every table is analysis-ready CSV.
4. 05_response_library to read the actual answers.
5. 04_master_dataset to verify or re-slice anything; 06_methodology for how
   it was run.

## What makes this measurement different

Every number here is a sampled estimate with a stated interval - each prompt
was asked ${run.repeats} times, because a single AI answer is an anecdote
and a distribution is a measurement. The prompt battery is calibrated to
1,006 real buyer conversations, weighted to the question types buyers
actually ask. And the full raw data ships in this package - every claim can
be recomputed from the answers themselves.

*Generated by Answerpoll (answerpoll.vercel.app) - measurement by Resondex.*
`;
}
