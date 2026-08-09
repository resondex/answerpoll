import type {
  MentionRow,
  Project,
  Prompt,
  ResponseRow,
  Run,
  RunMetrics,
} from "../types";
import type { buildCanonicalizer } from "./metrics";

/**
 * Study verification — Answerpoll grading its own homework.
 *
 * Every headline figure is recounted here from the raw response and mention
 * rows, through code that shares nothing with computeRunMetrics but the
 * frame DEFINITIONS (core panel, unbranded, coded). If the two paths
 * disagree, the study ships with the failure stated in verification.md —
 * never silently. The same metrics object feeds the dashboard, workbooks,
 * and decks, so one confirmed recount vouches for every surface at once.
 */

export interface VerifyCheck {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface EngineHealth {
  engine: string;
  stored: number;
  naturalStops: number;
  truncated: number;
  unreported: number;
  citedAnswers: number;
  coders: string[];
}

export interface StudyVerification {
  checks: VerifyCheck[];
  allPassed: boolean;
  engineHealth: EngineHealth[];
  /** Task balance: every engine should hold the same answer count. */
  balanced: boolean;
  expectedPerEngine: number;
}

const NATURAL = new Set(["stop", "end_turn", "stop_sequence"]);
const TRUNCATED = new Set(["length", "max_tokens"]);

export function verifyStudy(args: {
  project: Project;
  run: Run;
  prompts: Prompt[];
  responses: ResponseRow[];
  mentions: MentionRow[];
  metrics: RunMetrics;
  canon: ReturnType<typeof buildCanonicalizer>;
}): StudyVerification {
  const { project, run, prompts, responses, mentions, metrics, canon } = args;
  const checks: VerifyCheck[] = [];
  const add = (name: string, expected: number | string, actual: number | string) =>
    checks.push({
      name,
      expected: String(expected),
      actual: String(actual),
      pass: String(expected) === String(actual),
    });

  // --- rebuild the frames from raw rows ---
  const brandedIds = new Set(
    prompts.filter((p) => p.theme === "branded").map((p) => p.id)
  );
  const sampled = [...new Set(responses.map((r) => r.model).filter(Boolean))];
  const core =
    project.engine_set.length > 0
      ? project.engine_set.filter((m) => sampled.includes(m) || sampled.length === 0)
      : sampled;
  const coreSet = new Set(core.length > 0 ? core : sampled);
  const unbranded = responses.filter(
    (r) =>
      !brandedIds.has(r.prompt_id) &&
      (!r.model || coreSet.size === 0 || coreSet.has(r.model))
  );
  const unbrandedIds = new Set(unbranded.map((r) => r.id));
  const targetNorm = canon.norm(project.brand);

  // --- recounts vs the metrics object ---
  add("Unbranded core answers", metrics.unbrandedResponses, unbranded.length);

  const namingTarget = new Set(
    mentions
      .filter(
        (m) => unbrandedIds.has(m.response_id) && canon.norm(m.brand) === targetNorm
      )
      .map((m) => m.response_id)
  );
  const target = metrics.brands.find((b) => b.isTarget);
  if (target) {
    add(`Answers naming ${project.brand}`, target.mentionCount, namingTarget.size);
  }

  const codedRows = unbranded.filter((r) => r.outcome !== null);
  if (metrics.firstPick) {
    const wins = codedRows.filter(
      (r) => r.top_pick_brand !== null && canon.norm(r.top_pick_brand) === targetNorm
    );
    add(`${project.brand} first picks`, metrics.firstPick.count, wins.length);
    add("Coded answers (first-pick base)", metrics.firstPick.of, codedRows.length);
  }
  if (metrics.outcomes) {
    add(
      "Outcome counts sum to coded answers",
      codedRows.length,
      metrics.outcomes.pick + metrics.outcomes.no_pick + metrics.outcomes.clarification
    );
  }
  if (metrics.sources) {
    const cited = unbranded.filter((r) => r.citations && r.citations.length > 0);
    add("Citation-bearing answers", metrics.sources.citedAnswers, cited.length);
  }
  add("Dictionary version at read time", project.dictionary_version, metrics.dictionaryVersion);

  // --- per-engine honesty table ---
  const engines = run.models.length > 0 ? run.models : [run.model];
  const engineHealth: EngineHealth[] = engines.map((engine) => {
    const rows = responses.filter((r) => (r.model || run.model) === engine);
    return {
      engine,
      stored: rows.length,
      naturalStops: rows.filter((r) => r.finish_reason && NATURAL.has(r.finish_reason)).length,
      truncated: rows.filter((r) => r.finish_reason && TRUNCATED.has(r.finish_reason)).length,
      unreported: rows.filter((r) => !r.finish_reason || (!NATURAL.has(r.finish_reason) && !TRUNCATED.has(r.finish_reason))).length,
      citedAnswers: rows.filter((r) => r.citations && r.citations.length > 0).length,
      coders: [...new Set(rows.map((r) => r.coder_model).filter((c): c is string => Boolean(c)))],
    };
  });
  const activePrompts = prompts.filter((p) => !p.retired).length;
  const expectedPerEngine = activePrompts * run.repeats;
  const counts = new Set(engineHealth.map((e) => e.stored));
  const balanced = counts.size <= 1;

  return {
    checks,
    allPassed: checks.every((c) => c.pass),
    engineHealth,
    balanced,
    expectedPerEngine,
  };
}

/** Deterministic PRNG seeded from the run id, so the validation sample is
 * reproducible: the same run always nominates the same answers. */
export function seededShuffle<T>(items: T[], seedText: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  const rand = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
