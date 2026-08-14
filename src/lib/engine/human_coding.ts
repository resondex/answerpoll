import { store } from "@/lib/store";
import { buildCanonicalizer } from "@/lib/engine/metrics";
import type {
  CodingAssignment,
  CodingMetric,
  HumanCode,
  Project,
  Run,
} from "@/lib/types";

/**
 * Human coding assignments: a frozen sample of (answer, brand) pairs that
 * people code by hand — in the first instance as validation data for the
 * LLM coder, later as a service owners can send to their own reviewers.
 *
 * The sample is drawn once, seeded by the assignment token, and stored on
 * the assignment row. Nothing about a later recode, dictionary edit, or
 * coder swap can change what the humans were asked — which is exactly what
 * makes their verdicts usable as ground truth across coder experiments.
 */

export interface AssignmentItem {
  response_id: string;
  brand: string;
  brand_norm: string;
}

/** Deterministic PRNG so the sample is reproducible from the token. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededSample<T>(pool: T[], n: number, seedStr: string): T[] {
  const rand = mulberry32(hashSeed(seedStr));
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/**
 * Draw the frozen sample for a new assignment.
 *
 * mentioned — every unbranded answer paired with the focus brand, mention
 * or not: validating extraction needs both presences and absences.
 * recommended / negative / chosen — pairs where the brand actually appears
 * in the answer, since the question is meaningless otherwise; scope 'focus'
 * restricts to the focus brand, 'any' samples across every mentioned brand.
 */
export async function sampleItems(
  project: Project,
  run: Run,
  metric: CodingMetric,
  sampleSize: number,
  brandScope: "focus" | "any",
  token: string
): Promise<AssignmentItem[]> {
  const [responses, mentions, prompts, dictionary] = await Promise.all([
    store.listResponses(run.id),
    store.listMentionsForRun(run.id),
    store.listPrompts(project.id),
    store.getDictionary(project.id),
  ]);
  const canon = buildCanonicalizer(dictionary);
  const brandedPromptIds = new Set(
    prompts.filter((p) => p.theme === "branded").map((p) => p.id)
  );
  const unbranded = responses.filter((r) => !brandedPromptIds.has(r.prompt_id));
  const focusNorm = canon.norm(project.brand);

  let pool: AssignmentItem[];
  if (metric === "mentioned") {
    pool = unbranded.map((r) => ({
      response_id: r.id,
      brand: project.brand,
      brand_norm: focusNorm,
    }));
  } else {
    const unbrandedIds = new Set(unbranded.map((r) => r.id));
    const seen = new Set<string>();
    pool = [];
    for (const m of mentions) {
      if (!unbrandedIds.has(m.response_id)) continue;
      if (brandScope === "focus" && m.brand_norm !== focusNorm) continue;
      const key = `${m.response_id}|${m.brand_norm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push({
        response_id: m.response_id,
        brand: m.brand,
        brand_norm: m.brand_norm,
      });
    }
  }
  return seededSample(pool, Math.min(sampleSize, pool.length), token);
}

/** What the LLM coder said about each item — the comparison baseline. */
export async function llmVerdicts(
  project: Project,
  runId: string,
  metric: CodingMetric,
  items: AssignmentItem[]
): Promise<Map<string, boolean>> {
  const [responses, mentions, dictionary] = await Promise.all([
    store.listResponses(runId),
    store.listMentionsForRun(runId),
    store.getDictionary(project.id),
  ]);
  const canon = buildCanonicalizer(dictionary);
  const byResponse = new Map<string, { framings: Map<string, string> }>();
  for (const m of mentions) {
    let e = byResponse.get(m.response_id);
    if (!e) {
      e = { framings: new Map() };
      byResponse.set(m.response_id, e);
    }
    e.framings.set(m.brand_norm, m.framing);
  }
  const pickNorm = new Map<string, string | null>();
  for (const r of responses) {
    pickNorm.set(r.id, r.top_pick_brand ? canon.norm(r.top_pick_brand) : null);
  }

  const out = new Map<string, boolean>();
  for (const it of items) {
    const framing = byResponse.get(it.response_id)?.framings.get(it.brand_norm);
    const crowned = pickNorm.get(it.response_id) === it.brand_norm;
    let v: boolean;
    switch (metric) {
      case "mentioned":
        v = framing !== undefined;
        break;
      case "recommended":
        // Mirrors the drawer's definition: a crowned brand always counts.
        v = framing === "recommended" || crowned;
        break;
      case "chosen":
        v = crowned;
        break;
      case "negative":
        v = framing === "negative";
        break;
    }
    out.set(`${it.response_id}|${it.brand_norm}`, v);
  }
  return out;
}

export interface CoderStats {
  coder: string;
  coded: number;
  /** Share of this coder's items where they agree with the LLM coder. */
  llmAgreement: number | null;
}

export interface AssignmentStats {
  total: number;
  codedItems: number;
  coders: CoderStats[];
  /** Majority human verdict vs LLM, over items with at least one code. */
  llmAgreement: number | null;
  /** Raw agreement between coders on items two or more of them coded. */
  interRater: number | null;
  interRaterItems: number;
}

export function assignmentStats(
  assignment: CodingAssignment,
  codes: HumanCode[],
  llm: Map<string, boolean>
): AssignmentStats {
  const items = JSON.parse(assignment.items) as AssignmentItem[];
  const itemKey = (c: { response_id: string; brand_norm: string }) =>
    `${c.response_id}|${c.brand_norm}`;
  const validKeys = new Set(items.map(itemKey));

  const byCoder = new Map<string, HumanCode[]>();
  const byItem = new Map<string, HumanCode[]>();
  for (const c of codes) {
    const k = itemKey(c);
    if (!validKeys.has(k)) continue;
    const cc = byCoder.get(c.coder);
    if (cc) cc.push(c);
    else byCoder.set(c.coder, [c]);
    const ci = byItem.get(k);
    if (ci) ci.push(c);
    else byItem.set(k, [c]);
  }

  const coders: CoderStats[] = [...byCoder.entries()].map(([coder, cs]) => {
    const judged = cs.filter((c) => llm.has(itemKey(c)));
    const agree = judged.filter(
      (c) => (c.verdict === 1) === llm.get(itemKey(c))
    ).length;
    return {
      coder,
      coded: cs.length,
      llmAgreement: judged.length > 0 ? agree / judged.length : null,
    };
  });

  let majAgree = 0;
  let majTotal = 0;
  let irAgree = 0;
  let irPairs = 0;
  let irItems = 0;
  for (const [k, cs] of byItem) {
    const yes = cs.filter((c) => c.verdict === 1).length;
    const no = cs.length - yes;
    if (yes !== no && llm.has(k)) {
      majTotal += 1;
      if (yes > no === llm.get(k)) majAgree += 1;
    }
    if (cs.length >= 2) {
      irItems += 1;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          irPairs += 1;
          if (cs[i].verdict === cs[j].verdict) irAgree += 1;
        }
      }
    }
  }

  return {
    total: items.length,
    codedItems: byItem.size,
    coders: coders.sort((a, b) => b.coded - a.coded),
    llmAgreement: majTotal > 0 ? majAgree / majTotal : null,
    interRater: irPairs > 0 ? irAgree / irPairs : null,
    interRaterItems: irItems,
  };
}
