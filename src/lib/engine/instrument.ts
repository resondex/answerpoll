import { createHash } from "crypto";
import { openaiClient } from "./providers";
import { store } from "../store";

/**
 * The instrument designer: brand → classified category → composed stage
 * skeleton → situations → a grid of intents with one prompt each. This is
 * the alternative to the classic suggested battery (suggest.ts), not a
 * replacement — both paths produce ordinary prompts for the runner, and a
 * project records which instrument built it.
 *
 * Everything here is setup-time tooling: cache-first LLM calls on the same
 * client and model the classic path uses, plus one pure-code composer. No
 * new services, no new vendors.
 */

const MODEL = process.env.SUGGEST_MODEL ?? "gpt-5-mini";
const CACHE_TTL_MS = 183 * 24 * 3600 * 1000;
// Version the cache: composer-rule or prompt-style changes must not serve
// grids built under old rules.
const INSTRUMENT_VERSION = "g2";

function cacheKey(prefix: string, parts: (string | null)[]): string {
  const normalized = parts.map((p) => (p ?? "").trim().toLowerCase()).join("|");
  return `${prefix}:${INSTRUMENT_VERSION}:${createHash("sha256").update(normalized).digest("hex")}`;
}

/* ------------------------------ moderators ------------------------------ */

export interface Moderators {
  verifiability: "spec" | "taste" | "trust";
  involvement: "considered" | "habitual";
  think_feel: "think" | "feel";
  decision_unit: "solo" | "household" | "committee";
  rhythm: "one_shot" | "replenishment" | "subscription";
  risk: "performance" | "financial" | "social" | "physical";
  channel_retail: boolean;
  /** One sentence the setup banner shows under the classification chips. */
  rationale: string;
}

const MODERATOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verifiability: { type: "string", enum: ["spec", "taste", "trust"] },
    involvement: { type: "string", enum: ["considered", "habitual"] },
    think_feel: { type: "string", enum: ["think", "feel"] },
    decision_unit: { type: "string", enum: ["solo", "household", "committee"] },
    rhythm: { type: "string", enum: ["one_shot", "replenishment", "subscription"] },
    risk: { type: "string", enum: ["performance", "financial", "social", "physical"] },
    channel_retail: { type: "boolean" },
    rationale: { type: "string" },
  },
  required: [
    "verifiability", "involvement", "think_feel", "decision_unit",
    "rhythm", "risk", "channel_retail", "rationale",
  ],
} as const;

export async function classifyModerators(input: {
  category: string;
  audience: string | null;
}): Promise<Moderators> {
  const key = cacheKey("moderators", [input.category, input.audience]);
  const hit = await store.cacheGet(key, CACHE_TTL_MS);
  if (hit) return JSON.parse(hit) as Moderators;
  const res = await openaiClient().chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "Classify a purchase category on seven decision-structure " +
          "dimensions, for designing a research instrument over its buying " +
          "decision.\n" +
          "- verifiability: bought on checkable specs, on taste/experience, " +
          "or on trust (credence - quality unverifiable even after use).\n" +
          "- involvement: a considered purchase, or habitual/impulse.\n" +
          "- think_feel: decided mostly rationally, or by identity/emotion.\n" +
          "- decision_unit: one person, a household, or a committee/team.\n" +
          "- rhythm: one-shot purchase, replenishment, or subscription.\n" +
          "- risk: the buyer's dominant worry - performance, financial, " +
          "social (how it looks), or physical (safety).\n" +
          "- channel_retail: true when where-to-buy is a real question " +
          "(retail/DTC goods), false for direct/contracted purchases.\n" +
          "- rationale: ONE sentence justifying the overall read, in plain " +
          "buyer language.",
      },
      {
        role: "user",
        content: `Category: ${input.category}\nAudience: ${input.audience ?? "unknown"}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "moderators", strict: true, schema: MODERATOR_SCHEMA },
    },
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as Moderators;
  await store.cacheSet(key, JSON.stringify(parsed));
  return parsed;
}

/* ------------------------------- composer ------------------------------- */

export type Layer = "awareness" | "consideration" | "decision" | "retention" | "loyalty";

export interface ComposedStage {
  key: string;
  label: string;
  layer: Layer;
  /** Whether this stage's intents vary across buyer situations. */
  situational: boolean;
  /** none = generic; each = one cell per named rival; defensive_offensive =
   * one "alternatives to you" cell plus one per rival. */
  rivals: "none" | "each" | "defensive_offensive";
  /** Guidance handed to the cell generator for this stage. */
  hint: string;
}

export type LibraryStage = ComposedStage & {
  /** Whether the composer's rules pick this stage for the category. The
   * user sees the whole library and can keep a stage the rules skipped. */
  recommended: boolean;
};

/**
 * The master library, in journey order, with the composer's verdict on each
 * stage. Pure rules on purpose - auditable, consistent, and testable without
 * a model call. This is the part that makes the battery an instrument rather
 * than a suggestion.
 */
export function stageLibrary(m: Moderators): LibraryStage[] {
  const considered = m.involvement === "considered";
  return [
    {
      key: "problem_recognition", label: "Problem recognition", layer: "awareness",
      situational: true, rivals: "none", recommended: true,
      hint: "Pain-phrased and pre-category: the buyer describes the problem without knowing the category exists. Never name the category, a brand, or a product type.",
    },
    {
      key: "category_education", label: "Category education", layer: "awareness",
      situational: false, rivals: "none", recommended: m.think_feel === "think" && considered,
      hint: "The buyer asks what the category is or does ('what does a X actually do').",
    },
    {
      key: "discovery", label: "Discovery", layer: "awareness",
      situational: true, rivals: "none", recommended: true,
      hint: "Open category discovery: 'best X for ...' style asks, no brands named.",
    },
    {
      key: "shortlist", label: "Shortlist", layer: "consideration",
      situational: true, rivals: "none", recommended: true,
      hint: "The buyer asks for a small set of options to consider.",
    },
    {
      key: "criteria", label: "Criteria formation", layer: "consideration",
      situational: false, rivals: "none", recommended: true,
      hint: "The buyer asks what to look for / what matters when choosing.",
    },
    {
      key: "feature_screening", label: "Feature screening", layer: "consideration",
      situational: true, rivals: "none", recommended: m.verifiability === "spec",
      hint: "Attribute-first asks: which options have a specific capability.",
    },
    {
      key: "use_case", label: "Use-case fit", layer: "consideration",
      situational: true, rivals: "none", recommended: true,
      hint: "Situation-first asks describing a concrete need or workflow.",
    },
    {
      key: "social_validation", label: "Social validation", layer: "consideration",
      situational: false, rivals: "none", recommended: true,
      hint: m.think_feel === "feel"
        ? "What people love, compliment, or identify with - social proof in identity terms."
        : "What people actually use and rate well - reviews, communities, popularity.",
    },
    {
      key: "comparison",
      label: m.verifiability === "taste" ? "Dupes & alternatives" : "Comparison",
      layer: "decision", situational: true, rivals: "each", recommended: considered,
      hint: m.verifiability === "taste"
        ? "Head-to-head and 'similar to X but cheaper/different' asks naming the rival."
        : "Head-to-head asks naming the client brand against the rival.",
    },
    {
      key: "premium_worth", label: "Is premium worth it", layer: "decision",
      situational: false, rivals: "none", recommended: !considered,
      hint: "Whether the premium option genuinely beats the basic/store option.",
    },
    {
      key: "objections", label: "Objections / risk", layer: "decision",
      situational: true, rivals: "none", recommended: true,
      hint: `The buyer voices the category's dominant worry (${m.risk}) about the client brand by name.`,
    },
    {
      key: "pricing", label: "Pricing / value", layer: "decision",
      situational: true, rivals: "none", recommended: true,
      hint: "Cost and value-for-money asks; some generic to the category, some naming the client brand.",
    },
    {
      key: "business_case", label: "Business case", layer: "decision",
      situational: false, rivals: "none", recommended: m.decision_unit === "committee",
      hint: "The buyer asks for help justifying the client brand internally ('make the case to my CFO').",
    },
    {
      key: "churn_triggers", label: "Churn triggers", layer: "retention",
      situational: false, rivals: "none", recommended: true,
      hint: "An existing customer wonders whether the client brand is still the right choice.",
    },
    {
      key: "alternatives", label: "Alternatives", layer: "retention",
      situational: false, rivals: "defensive_offensive", recommended: true,
      hint: "'Alternatives to X' asks - one for the client brand (defensive) and one per rival (offensive).",
    },
    {
      key: "renewal", label: "Renewal", layer: "retention",
      situational: false, rivals: "none", recommended: m.rhythm === "subscription",
      hint: "At renewal: is the client brand worth keeping, are there cheaper options.",
    },
    {
      key: "problem_resolution", label: "Problem resolution", layer: "retention",
      situational: false, rivals: "none", recommended: true,
      hint: "A support-style ask: something about the client brand is broken or messy, how to fix it.",
    },
    {
      key: "expansion", label: "Expansion", layer: "loyalty",
      situational: false, rivals: "none", recommended: true,
      hint: "A happy customer considers using the client brand for more ('roll it out further', 'use it for Y too').",
    },
    {
      key: "ecosystem", label: "Ecosystem", layer: "loyalty",
      situational: false, rivals: "none", recommended: true,
      hint: "What works well WITH the client brand - add-ons, companions, integrations.",
    },
    {
      key: "advocacy", label: "Advocacy", layer: "loyalty",
      situational: false, rivals: "none", recommended: true,
      hint: "A customer asks how to defend or recommend the client brand to someone else.",
    },
    {
      key: "repertoire", label: "Repertoire", layer: "loyalty",
      situational: false, rivals: "none", recommended: m.rhythm === "replenishment",
      hint: "Deepening the habit: more from the same brand, or is it worth switching from the usual.",
    },
  ];
}

/** A library entry without the verdict - what the cell planner consumes. */
export function stripVerdict(s: LibraryStage): ComposedStage {
  const { key, label, layer, situational, rivals, hint } = s;
  return { key, label, layer, situational, rivals, hint };
}

/** The composed skeleton: the library's recommended stages, in order. */
export function composeStages(m: Moderators): ComposedStage[] {
  return stageLibrary(m).filter((s) => s.recommended).map(stripVerdict);
}

/* ------------------------------ situations ------------------------------ */

export interface Situation {
  label: string;
  description: string;
}

const SITUATIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    situations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          description: { type: "string" },
        },
        required: ["label", "description"],
      },
    },
  },
  required: ["situations"],
} as const;

const SITUATION_TEMPLATE: Record<Moderators["decision_unit"], string> = {
  committee:
    "buyer circumstances for an organizational purchase: scale (team/org size), composition (who has to use it), and constraint (budget tier). ",
  household:
    "buyer circumstances for a consumer purchase: occasions, recipients (buying for self vs someone else), and constraints (budget, sensitivities). ",
  solo:
    "buyer circumstances for an individual considered purchase: use-cases, budget tiers, and ecosystem/compatibility constraints. ",
};

export async function generateSituations(input: {
  category: string;
  audience: string | null;
  decisionUnit: Moderators["decision_unit"];
}): Promise<Situation[]> {
  const key = cacheKey("situations", [input.category, input.audience, input.decisionUnit]);
  const hit = await store.cacheGet(key, CACHE_TTL_MS);
  if (hit) return JSON.parse(hit) as Situation[];
  const res = await openaiClient().chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "Propose 3 or 4 buyer situations for a research instrument. A " +
          "situation earns its place ONLY if it changes what a competent " +
          "advisor would recommend - facts about the decision, never facts " +
          "about the speaker. Use " + SITUATION_TEMPLATE[input.decisionUnit] +
          "Labels are 2-4 plain words ('small team', 'gift for spouse'); " +
          "descriptions one short sentence.",
      },
      {
        role: "user",
        content: `Category: ${input.category}\nAudience: ${input.audience ?? "unknown"}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "situations", strict: true, schema: SITUATIONS_SCHEMA },
    },
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as {
    situations: Situation[];
  };
  const situations = (parsed.situations ?? []).slice(0, 4);
  await store.cacheSet(key, JSON.stringify(situations));
  return situations;
}

/**
 * One more scenario for the same category, distinct from the ones already
 * on the table (whether the user kept them or not). Same admission test as
 * the initial set. Cached by what it was asked to avoid, so the next user
 * in the same category with the same list gets the same suggestion.
 */
export async function suggestScenario(input: {
  category: string;
  audience: string | null;
  decisionUnit: Moderators["decision_unit"];
  exclude: Situation[];
}): Promise<Situation | null> {
  const avoid = input.exclude.map((s) => s.label.trim().toLowerCase()).filter(Boolean).sort();
  const key = cacheKey("scenario_more", [
    input.category, input.audience, input.decisionUnit, avoid.join("|"),
  ]);
  const hit = await store.cacheGet(key, CACHE_TTL_MS);
  if (hit) return JSON.parse(hit) as Situation;
  const res = await openaiClient().chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "Propose exactly ONE additional buyer situation for a research " +
          "instrument. A situation earns its place ONLY if it changes what a " +
          "competent advisor would recommend - facts about the decision, never " +
          "facts about the speaker. It must be genuinely different from every " +
          "situation already listed (a different axis of circumstance, not a " +
          "variant of one). Use " + SITUATION_TEMPLATE[input.decisionUnit] +
          "Label 2-4 plain words; description one short sentence.",
      },
      {
        role: "user",
        content:
          `Category: ${input.category}\nAudience: ${input.audience ?? "unknown"}\n` +
          `Already listed:\n${input.exclude.map((s) => `- ${s.label}: ${s.description}`).join("\n") || "- (none)"}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "situations", strict: true, schema: SITUATIONS_SCHEMA },
    },
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as {
    situations: Situation[];
  };
  const fresh = (parsed.situations ?? []).find(
    (s) => s.label.trim() && !avoid.includes(s.label.trim().toLowerCase())
  );
  if (!fresh) return null;
  await store.cacheSet(key, JSON.stringify(fresh));
  return fresh;
}

/* -------------------------------- cells --------------------------------- */

export interface GridCell {
  stage: string;
  layer: Layer;
  /** Situation label, or null for situation-invariant stages. */
  situation: string | null;
  /** "generic", "defensive", or the rival's name. */
  angle: string;
  /** The prompt as a user would type it. */
  text: string;
}

const CELLS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    cells: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          stage: { type: "string" },
          situation: { type: ["string", "null"] },
          angle: { type: "string" },
          text: { type: "string" },
        },
        required: ["stage", "situation", "angle", "text"],
      },
    },
  },
  required: ["cells"],
} as const;

/**
 * Fill the grid: one prompt per cell. The cell plan is computed in code
 * (which cells exist is a design rule, not a model choice); the model only
 * writes the prompt texts. Bulk generation is fine here - this is tooling,
 * not measurement.
 */
export async function generateGrid(input: {
  brand: string;
  category: string;
  competitors: string[];
  audience: string | null;
  moderators: Moderators;
  stages: ComposedStage[];
  situations: Situation[];
}): Promise<GridCell[]> {
  const rivals = input.competitors.slice(0, 4);
  // The cell plan: generic stages get one cell per situation (situational)
  // or a single cell; rival stages cross with each rival plus defensive.
  const plan: { stage: ComposedStage; situation: string | null; angle: string }[] = [];
  for (const st of input.stages) {
    if (st.rivals === "each") {
      const sits = st.situational
        ? input.situations.map((s) => s.label)
        : [null as string | null];
      rivals.forEach((r, i) => {
        plan.push({ stage: st, situation: sits[i % sits.length] ?? null, angle: r });
      });
    } else if (st.rivals === "defensive_offensive") {
      plan.push({ stage: st, situation: null, angle: "defensive" });
      rivals.forEach((r) => plan.push({ stage: st, situation: null, angle: r }));
    } else if (st.situational) {
      for (const s of input.situations) {
        plan.push({ stage: st, situation: s.label, angle: "generic" });
      }
    } else {
      plan.push({ stage: st, situation: null, angle: "generic" });
    }
  }

  const key = cacheKey("grid", [
    input.brand, input.category, rivals.join(","), input.audience,
    JSON.stringify(input.moderators), input.stages.map((s) => s.key).join(","),
    input.situations.map((s) => s.label).join(","),
  ]);
  const hit = await store.cacheGet(key, CACHE_TTL_MS);
  if (hit) return JSON.parse(hit) as GridCell[];

  const planText = plan
    .map(
      (p, i) =>
        `${i + 1}. stage=${p.stage.key} situation=${p.situation ?? "-"} angle=${p.angle}\n   guidance: ${p.stage.hint}`
    )
    .join("\n");
  const res = await openaiClient().chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You write the prompts for a research instrument that measures a " +
          "brand's standing in AI assistant answers. For EACH cell in the " +
          "plan, write exactly one prompt as a real person would type it " +
          "into a chat assistant - varied length and register, some lowercase " +
          "and terse, some with backstory; never survey-speak, never a " +
          "requirements list.\n" +
          "Rules:\n" +
          "- angle=generic: NEVER name the client brand or any competitor. " +
          "Blind prompts are the measurement.\n" +
          "- angle=<rival name>: for comparison-type stages, name the client " +
          "brand AND that rival; for alternatives-type stages, ask for " +
          "alternatives to that rival (client brand NOT named).\n" +
          "- angle=defensive: ask for alternatives to the client brand by name.\n" +
          "- Retention and loyalty stages speak as an existing customer and " +
          "name the client brand where the guidance says so.\n" +
          "- situation: weave the circumstance in naturally; do not label it.\n" +
          "Return one cell object per plan line, same stage/situation/angle " +
          "values, in order.",
      },
      {
        role: "user",
        content:
          `Client brand: ${input.brand}\nCategory: ${input.category}\n` +
          `Rivals: ${rivals.join(", ")}\nAudience: ${input.audience ?? "unknown"}\n\n` +
          `Cell plan:\n${planText}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "grid_cells", strict: true, schema: CELLS_SCHEMA },
    },
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as {
    cells: { stage: string; situation: string | null; angle: string; text: string }[];
  };
  const byKey = new Map(input.stages.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const cells: GridCell[] = [];
  for (const c of parsed.cells ?? []) {
    const st = byKey.get(c.stage);
    if (!st || !c.text?.trim()) continue;
    const norm = c.text.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(norm)) continue; // cheap dedupe; no embeddings needed at this scale
    seen.add(norm);
    // The plan writes "-" for situation-invariant cells; models echo it back
    // as a string rather than null.
    const situation =
      c.situation && c.situation.trim() && c.situation.trim() !== "-"
        ? c.situation.trim()
        : null;
    cells.push({
      stage: st.key,
      layer: st.layer,
      situation,
      angle: c.angle,
      text: c.text.trim(),
    });
  }
  await store.cacheSet(key, JSON.stringify(cells));
  return cells;
}

/* ------------------------------ phrasings ------------------------------- */

/** The brands (client + rivals) a text names, lowercased and sorted - the
 * blind/branded signature a paraphrase must preserve from its seed. */
export function brandSignature(
  text: string,
  brand: string,
  competitors: string[]
): string {
  const t = text.toLowerCase();
  return [brand, ...competitors]
    .map((b) => b.trim().toLowerCase())
    .filter((b) => b && t.includes(b))
    .sort()
    .join("|");
}

const PHRASINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    cells: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          phrasings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string" },
                asker: { type: "string" },
              },
              required: ["text", "asker"],
            },
          },
        },
        required: ["index", "phrasings"],
      },
    },
  },
  required: ["cells"],
} as const;

export interface Phrasing {
  text: string;
  asker: string;
}

// Bump when the paraphrase prompt or filters change: cached sets written
// under old instructions must not be served as if they were new.
const PHRASINGS_VERSION = "p2";
// Over-generate so the overlap filter can be strict and still fill the set.
const PHRASINGS_EXTRA = 3;

/**
 * Paraphrase sets: for each (confirmed) cell, write the other wordings real
 * buyers would use for the same designed question. Variation comes from
 * wording, register, length, and who is asking - never from changing what
 * is asked. Called per layer so no single request runs long.
 *
 * Constraints are enforced in code, not trusted to the model: a paraphrase
 * must name exactly the brands its seed names (blind cells stay blind,
 * branded cells keep their rival), and near-duplicates are dropped.
 */
export async function generatePhrasings(input: {
  brand: string;
  category: string;
  competitors: string[];
  audience: string | null;
  moderators: Moderators;
  cells: { stage: string; situation: string | null; angle: string; text: string }[];
  /** Total phrasings wanted per cell including the seed. */
  count: number;
  /** Skip the cache read: the user asked for a fresh set. */
  force?: boolean;
  /** Diagnostic hook: receives the raw parsed model output. */
  onRaw?: (raw: unknown) => void;
}): Promise<Phrasing[][]> {
  const want = Math.max(0, input.count - 1);
  if (want === 0 || input.cells.length === 0) return input.cells.map(() => []);
  const rivals = input.competitors.slice(0, 4);
  const key = cacheKey("phrasings", [
    PHRASINGS_VERSION, input.brand, rivals.join(","), input.audience, String(input.count),
    input.cells.map((c) => c.text).join("\n"),
  ]);
  const hit = input.force ? null : await store.cacheGet(key, CACHE_TTL_MS);
  if (hit) return JSON.parse(hit) as Phrasing[][];

  const rivalsList = rivals;
  /** One model pass over a subset of cells; returns kept phrasings per
   * subset position. Filtering happens here so a retry sees real gaps. */
  async function pass(subset: typeof input.cells): Promise<Phrasing[][]> {
    const cellText = subset
      .map(
        (c, i) =>
          `${i}. [stage=${c.stage} situation=${c.situation ?? "-"} angle=${c.angle}] ${c.text}`
      )
      .join("\n");
    const res = await openaiClient().chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You write paraphrase sets for a research instrument that measures " +
            "a brand's standing in AI assistant answers. Each seed prompt below " +
            "is one designed question. For EACH seed, write exactly " +
            `${want + PHRASINGS_EXTRA} additional DISTINCT ways a real buyer would ask the SAME ` +
            "question - same circumstance, same intent, same brands named - in " +
            "the wordings people actually type into a chat assistant.\n" +
            "Each paraphrase is a DIFFERENT PERSON in the same circumstance " +
            "describing it their own way - NOT a rewording of the seed. Do not " +
            "copy the seed's specific details (its numbers, its examples, its " +
            "list of symptoms); invent plausible ones of your own that fit the " +
            "scenario, or leave details out entirely. Some askers give " +
            "backstory, some just ask.\n" +
            "Vary, across the set: who is asking (pick realistic roles for the " +
            "audience - e.g. founder, engineering manager, IT director, " +
            "procurement, a parent, a gift buyer - and tag each with `asker`), " +
            "register (casual forum post to formal RFP language), length (a " +
            "terse 8-word ask to a two-sentence backstory), and question form.\n" +
            "Rules:\n" +
            "- If the seed names NO brand, name NO brand or product in any " +
            "paraphrase. Blind prompts are the measurement.\n" +
            "- If the seed names brands, every paraphrase names exactly those " +
            "same brands and no others.\n" +
            "- Never change the circumstance or the decision being made; never " +
            "add a new constraint the seed does not have.\n" +
            "- No verbatim repeats, no trivial reorderings; each paraphrase " +
            "should be something a different person would plausibly type.\n" +
            `Decision unit: ${input.moderators.decision_unit}. ` +
            "Return one object per seed with its index and its paraphrases, in order.",
        },
        {
          role: "user",
          content:
            `Client brand: ${input.brand}\nCategory: ${input.category}\n` +
            `Rivals: ${rivalsList.join(", ")}\nAudience: ${input.audience ?? "unknown"}\n\n` +
            `Seeds:\n${cellText}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "phrasings", strict: true, schema: PHRASINGS_SCHEMA },
      },
    });
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as {
      cells: { index: number; phrasings: Phrasing[] }[];
    };
    input.onRaw?.(parsed);
    const result: Phrasing[][] = subset.map(() => []);
    for (const c of parsed.cells ?? []) {
      const seed = subset[c.index];
      if (!seed) continue;
      const sig = brandSignature(seed.text, input.brand, rivalsList);
      const seen = new Set<string>([norm(seed.text)]);
      const keptWords: Set<string>[] = [wordSet(seed.text)];
      const kept: Phrasing[] = [];
      for (const p of c.phrasings ?? []) {
        const text = humanize((p.text ?? "").trim());
        if (!text) continue;
        // The signature check is the blind/branded discipline: a paraphrase of
        // a blind seed that names a brand is not a paraphrase, it is a leak.
        if (brandSignature(text, input.brand, rivalsList) !== sig) continue;
        const n = norm(text);
        if (seen.has(n)) continue;
        // A paraphrase that shares most of its words with the seed or a sibling
        // is a thesaurus pass, not another person asking; drop it.
        const ws = wordSet(text);
        if (keptWords.some((k) => jaccard(k, ws) > MAX_OVERLAP)) continue;
        seen.add(n);
        keptWords.push(ws);
        kept.push({ text, asker: (p.asker ?? "").trim() });
        if (kept.length >= want) break;
      }
      result[c.index] = kept;
    }
    return result;
  }

  const out = await pass(input.cells);
  // Reasoning models occasionally return a degenerate, near-empty set for a
  // whole batch. One retry on the cells that came up short (under half the
  // target) fills the gap without re-running what already worked.
  const deficient = out.map((k, i) => (k.length < want / 2 ? i : -1)).filter((i) => i >= 0);
  if (deficient.length > 0) {
    const again = await pass(deficient.map((i) => input.cells[i]));
    deficient.forEach((i, k) => {
      if (again[k].length > out[i].length) out[i] = again[k];
    });
  }
  // Never cache an all-empty result: that would make a transient failure sticky.
  if (out.some((k) => k.length > 0)) {
    await store.cacheSet(key, JSON.stringify(out));
  }
  return out;
}

function norm(t: string): string {
  return t.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ");
}

const MAX_OVERLAP = 0.5;
const STOP = new Set(
  "a an the and or of to for in on with we our us is are it this that how what which do does can should would i my me be as at by from have has need want".split(" ")
);

function wordSet(t: string): Set<string> {
  return new Set(norm(t).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Real people type hyphens and straight quotes; model output leans on em
 * dashes and curly quotes, which reads as machine-written to the engines. */
function humanize(t: string): string {
  return t
    .replace(/\s*[\u2014\u2013]\s*/g, " - ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...");
}

/* ------------------------------ orchestrator ---------------------------- */

/** Gate 1 of setup: the category read, the composed stages, and the
 * scenarios - everything the user confirms before any prompt is written. */
export async function composeInstrument(input: {
  category: string;
  audience: string | null;
}): Promise<{ moderators: Moderators; stages: ComposedStage[]; situations: Situation[] }> {
  const moderators = await classifyModerators(input);
  const stages = composeStages(moderators);
  const situations = await generateSituations({
    category: input.category,
    audience: input.audience,
    decisionUnit: moderators.decision_unit,
  });
  return { moderators, stages, situations };
}


export interface Instrument {
  moderators: Moderators;
  stages: ComposedStage[];
  situations: Situation[];
  cells: GridCell[];
}

export async function buildInstrument(input: {
  brand: string;
  category: string;
  competitors: string[];
  audience: string | null;
}): Promise<Instrument> {
  const moderators = await classifyModerators({
    category: input.category,
    audience: input.audience,
  });
  const stages = composeStages(moderators);
  const situations = await generateSituations({
    category: input.category,
    audience: input.audience,
    decisionUnit: moderators.decision_unit,
  });
  const cells = await generateGrid({ ...input, moderators, stages, situations });
  return { moderators, stages, situations, cells };
}

/** True when a prompt names the brand or any competitor - such prompts are
 * stored with theme "branded" so the unbranded funnel stays blind. */
export function namesAnyBrand(
  text: string,
  brand: string,
  competitors: string[]
): boolean {
  const t = text.toLowerCase();
  return [brand, ...competitors]
    .filter(Boolean)
    .some((b) => t.includes(b.trim().toLowerCase()));
}
