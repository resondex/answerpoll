import { anthropicClient, openaiClient } from "./providers";
import { store } from "../store";
import { computeRunMetrics } from "./metrics";
import { computeProjectTrend } from "./trend";
import type { RunMetrics } from "../types";

const SUGGEST_MODEL = process.env.SUGGEST_MODEL ?? "gpt-5-mini";
/**
 * The narrative writer. Claude Sonnet 5 when an Anthropic key is present —
 * client-facing prose is the product here, and it holds the placeholder
 * discipline best — falling back to the OpenAI model otherwise. Either way
 * the gate is what makes the output safe, not the model.
 */
const WRITER_MODEL = process.env.INSIGHTS_MODEL ?? "claude-sonnet-5";
const writerIsClaude = () =>
  Boolean(process.env.ANTHROPIC_API_KEY) && WRITER_MODEL.startsWith("claude");
// Bump when the fact set, prompt, or verification rules change.
const INSIGHTS_VERSION = "v3";
const CACHE_TTL_MS = 183 * 24 * 3600 * 1000;

const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface InsightsBundle {
  /** Numbered insights per analysis — the same sentences thread verbatim
   * through the exec summary, workbooks, and deck. */
  sections: { key: string; title: string; insights: string[] }[];
  /** Recommendations with the re-measurement contract built in. */
  plays: {
    title: string;
    gap: string;
    play: string;
    measuredBy: string;
    today: string;
  }[];
  /** The fact registry every figure was drawn from — the traceability spine. */
  facts: { id: string; label: string; value: string }[];
  /** Self-check gate results: every numeral in every sentence was asserted
   * against the fact registry before this bundle shipped. */
  verification: {
    figuresSupplied: number;
    placeholdersSubstituted: number;
    droppedInsights: number;
    droppedPlays: number;
  };
  runId: string;
  dictionaryVersion: number;
}

interface Fact {
  id: string;
  label: string;
  value: string;
}

/**
 * Build the fact registry: every number the insight writer is allowed to
 * use, pre-formatted. The LLM references facts as {F#} placeholders and we
 * substitute server-side — a hallucinated figure has nowhere to come from.
 */
function buildFacts(
  metrics: RunMetrics,
  brandName: string,
  trendDelta: string | null
): Fact[] {
  const facts: Fact[] = [];
  let n = 0;
  const add = (label: string, value: string) => {
    n += 1;
    facts.push({ id: `F${n}`, label, value });
  };
  const target = metrics.brands.find((b) => b.isTarget)!;

  add("answers sampled (unbranded)", String(metrics.unbrandedResponses));
  add(
    `${brandName} mention rate`,
    `${pct(target.mentionRate)} (95% CI ${pct(target.ciLow)}–${pct(target.ciHigh)})`
  );
  if (metrics.firstPick) {
    add(
      `${brandName} first-pick rate`,
      `${pct(metrics.firstPick.rate)} (95% CI ${pct(metrics.firstPick.ciLow)}–${pct(metrics.firstPick.ciHigh)}; ${metrics.firstPick.count} of ${metrics.firstPick.of} decided answers)`
    );
  }
  add(
    `${brandName} average position when named`,
    target.avgRank ? `#${target.avgRank.toFixed(1)}` : "never named"
  );
  if (metrics.positionDist) {
    add(
      `${brandName} position distribution`,
      `#1 in ${metrics.positionDist.r1} answers, #2 in ${metrics.positionDist.r2}, #3 in ${metrics.positionDist.r3}, 4th-or-lower in ${metrics.positionDist.r4plus}`
    );
  }
  add(`${brandName} share of voice`, pct(target.shareOfVoice));
  if (metrics.outcomes) {
    add(
      "answer outcomes",
      `${metrics.outcomes.pick} committed to a pick, ${metrics.outcomes.no_pick} explained without picking, ${metrics.outcomes.clarification} asked a question instead`
    );
  }
  for (const b of metrics.brands.slice(0, 5)) {
    if (b.isTarget) continue;
    add(
      `${b.brand} mention rate`,
      `${pct(b.mentionRate)} (95% CI ${pct(b.ciLow)}–${pct(b.ciHigh)})`
    );
  }
  if (metrics.topPicks) {
    for (const t of metrics.topPicks.slice(0, 4)) {
      add(
        `${t.brand} first picks`,
        `${t.picks} picks (${pct(t.shareOfDecided)} of decided answers)`
      );
    }
  }
  if (metrics.reasonLift) {
    const sorted = [...metrics.reasonLift].sort((a, b) => b.lift - a.lift);
    for (const r of [...sorted.slice(0, 2), ...sorted.slice(-2)]) {
      add(
        `share of answers using the argument "${r.code}" — in ${brandName} wins vs overall`,
        `${pct(r.shareWins)} of wins vs ${pct(r.shareAll)} of all answers (${r.lift >= 0 ? "+" : ""}${Math.round(r.lift * 100)} pts)`
      );
    }
  }
  if (metrics.promptGrid) {
    const wins = metrics.promptGrid.filter((g) => g.badge === "win").length;
    const contested = metrics.promptGrid.filter(
      (g) => g.badge === "contested"
    ).length;
    const absent = metrics.promptGrid.filter(
      (g) => g.badge === "absent"
    ).length;
    add(
      "prompt battery outcomes",
      `${wins} prompts WON, ${contested} CONTESTED, ${absent} ABSENT`
    );
    const worst = metrics.promptGrid.find((g) => g.badge === "absent");
    if (worst) add("an ABSENT prompt (verbatim)", `"${worst.text}"`);
  }
  if (metrics.negatives) {
    add(
      `answers framing ${brandName} negatively`,
      String(metrics.negatives.length)
    );
  }
  if (metrics.parentRollup) {
    for (const p of metrics.parentRollup.slice(0, 3)) {
      add(
        `parent company "${p.parent}" (any of its brands) named in`,
        `${pct(p.mentionRate)} of answers (95% CI ${pct(p.ciLow)}–${pct(p.ciHigh)}), with ${pct(p.shareOfVoice)} share of voice`
      );
    }
  }
  if (trendDelta) add(`${brandName} trend vs previous run`, trendDelta);
  return facts;
}

const INSIGHTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          insights: { type: "array", items: { type: "string" } },
        },
        required: ["key", "title", "insights"],
      },
    },
    plays: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          gap: { type: "string" },
          play: { type: "string" },
          measured_by: { type: "string" },
          today: { type: "string" },
        },
        required: ["title", "gap", "play", "measured_by", "today"],
      },
    },
  },
  required: ["sections", "plays"],
} as const;

/** Substitute {F#} placeholders; count how many resolved. */
function substitute(
  text: string,
  factById: Map<string, Fact>,
  counter: { n: number }
): string {
  return text.replace(/\{(F\d+)\}/g, (_, id: string) => {
    const f = factById.get(id);
    if (!f) return `[unknown figure ${id}]`;
    counter.n += 1;
    return f.value;
  });
}

/** Numeric tokens present in a string. */
function numerals(s: string): string[] {
  return s.match(/\d+(?:\.\d+)?/g) ?? [];
}

/**
 * The self-check gate: after substitution, every numeral in a sentence must
 * exist somewhere in the fact registry. A sentence carrying an unsourced
 * number is dropped rather than shipped.
 */
function passesGate(text: string, allowed: Set<string>): boolean {
  return numerals(text).every((t) => allowed.has(t));
}

export async function buildRunInsights(
  runId: string
): Promise<InsightsBundle | null> {
  const run = await store.getRun(runId);
  if (!run) return null;
  const [metrics, project] = await Promise.all([
    computeRunMetrics(runId),
    store.getRun(runId).then((r) => store.getProject(r!.project_id)),
  ]);
  if (!metrics || !project) return null;

  const key = `insights:${INSIGHTS_VERSION}:${runId}:${metrics.dictionaryVersion}`;
  const hit = await store.cacheGet(key, CACHE_TTL_MS);
  if (hit) return JSON.parse(hit) as InsightsBundle;

  // Trend delta when a previous completed run exists.
  let trendDelta: string | null = null;
  try {
    const runs = await store.listRuns(project.id);
    if (runs.filter((r) => r.status === "complete").length >= 2) {
      const trend = await computeProjectTrend(project.id);
      const series = trend?.series.find((s) => s.isTarget);
      if (series && series.points.length >= 2) {
        const idx = trend!.runs.findIndex((r) => r.runId === runId);
        const prev = idx > 0 ? series.points[idx - 1] : null;
        const cur = idx >= 0 ? series.points[idx] : null;
        if (prev && cur) {
          const delta = Math.round((cur.rate - prev.rate) * 100);
          trendDelta = `${pct(cur.rate)} this run vs ${pct(prev.rate)} previous (${delta >= 0 ? "+" : ""}${delta} pts)`;
        }
      }
    }
  } catch {
    // trend is optional garnish — never block insights on it
  }

  const facts = buildFacts(metrics, project.brand, trendDelta);
  const factById = new Map(facts.map((f) => [f.id, f]));
  const allowed = new Set<string>(
    facts.flatMap((f) => [...numerals(f.value), ...numerals(f.label)])
  );

  const systemPrompt =
          "You write the numbered insights and recommended plays for an AI-" +
          "visibility study report. Voice: plain, confident, specific — a " +
          "senior researcher speaking to a CMO. No hype words.\n\n" +
          "HARD RULE — figures: you may ONLY cite numbers by referencing the " +
          "provided facts as placeholders like {F3}. Never write digits " +
          "yourself; every sentence with a number must get it from a " +
          "placeholder. Sentences violating this are deleted by an automated " +
          "gate, so a beautiful insight with a hand-typed number is a wasted " +
          "insight.\n\n" +
          "GRAMMAR — each placeholder expands to exactly its fact's value (a " +
          "figure phrase; the label tells you what it measures but is NOT " +
          "inserted). Write the sentence so the expanded phrase reads as " +
          "natural prose: 'Reporting travels with wins — {F14}.' expands " +
          "cleanly; 'appearing at the rate indicated by {F14}' does not. " +
          "Read your sentence back with the value dropped in before " +
          "committing to it. Do NOT number your insights ('One.', '1.') — " +
          "numbering is applied by the renderer.\n\n" +
          "Produce:\n" +
          "- sections: one per analysis with 2-4 numbered insights each. Keys " +
          "and titles, in order: scorecard 'Headline'; leaderboard 'Brand " +
          "landscape'; top_picks 'Who wins instead'; arguments 'The arguments " +
          "that decide it'; prompts 'Prompt battery'; negatives 'Negative " +
          "framings' (only if negatives exist); parents 'Parent companies' " +
          "(only if parent facts exist); trend 'Trend' (only if a trend fact " +
          "exists).\n" +
          "- plays: 3 to 5 recommendations. Each names the measured gap " +
          "(gap), the action (play), the exact metric that will grade it " +
          "(measured_by), and today's baseline (today — a single {F#} " +
          "placeholder, nothing else). measured_by must describe THE SAME " +
          "metric the today placeholder carries — if the baseline fact is " +
          "the overall first-pick rate, measured_by says 'overall first-pick " +
          "rate', not a subset we did not measure.\n" +
          "An insight is a claim someone could act on, not a restatement of " +
          "a table row; never write methodological filler ('these results " +
          "derive from a sample of…').";
  const userPayload = JSON.stringify({
    brand: project.brand,
    category: project.category,
    audience: project.audience,
    facts,
  });

  // Claude returns the structure through a forced tool call; OpenAI through
  // a json_schema response format. Same contract either way.
  let raw = '{"sections":[],"plays":[]}';
  if (writerIsClaude()) {
    const a = await anthropicClient();
    const res = await a.messages.create({
      model: WRITER_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools: [
        {
          name: "emit_insights",
          description: "Return the numbered insights and recommended plays.",
          input_schema: INSIGHTS_SCHEMA as unknown as {
            type: "object";
            properties: Record<string, unknown>;
          },
        },
      ],
      tool_choice: { type: "tool", name: "emit_insights" },
      messages: [{ role: "user", content: userPayload }],
    });
    const block = res.content.find((b) => b.type === "tool_use");
    if (block && block.type === "tool_use") raw = JSON.stringify(block.input);
  } else {
    const res = await openaiClient().chat.completions.create({
      model: SUGGEST_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPayload },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "insights", strict: true, schema: INSIGHTS_SCHEMA },
      },
    });
    raw = res.choices[0]?.message?.content ?? raw;
  }
  const parsed = JSON.parse(raw) as {
    sections: { key: string; title: string; insights: string[] }[];
    plays: {
      title: string;
      gap: string;
      play: string;
      measured_by: string;
      today: string;
    }[];
  };

  const counter = { n: 0 };
  let droppedInsights = 0;
  let droppedPlays = 0;
  const sections = parsed.sections
    .map((s) => ({
      key: s.key,
      title: s.title,
      insights: s.insights
        .map((t) => substitute(t, factById, counter))
        .filter((t) => {
          const ok = passesGate(t, allowed) && !t.includes("[unknown figure");
          if (!ok) droppedInsights += 1;
          return ok;
        }),
    }))
    .filter((s) => s.insights.length > 0);
  const plays = parsed.plays
    .map((p) => ({
      title: p.title,
      gap: substitute(p.gap, factById, counter),
      play: substitute(p.play, factById, counter),
      measuredBy: substitute(p.measured_by, factById, counter),
      today: substitute(p.today, factById, counter),
    }))
    .filter((p) => {
      const ok =
        [p.gap, p.play, p.measuredBy, p.today].every(
          (t) => passesGate(t, allowed) && !t.includes("[unknown figure")
        ) && p.today.trim().length > 0;
      if (!ok) droppedPlays += 1;
      return ok;
    });

  const bundle: InsightsBundle = {
    sections,
    plays,
    facts,
    verification: {
      figuresSupplied: facts.length,
      placeholdersSubstituted: counter.n,
      droppedInsights,
      droppedPlays,
    },
    runId,
    dictionaryVersion: metrics.dictionaryVersion,
  };
  await store.cacheSet(key, JSON.stringify(bundle));
  return bundle;
}
