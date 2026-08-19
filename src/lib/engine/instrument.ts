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

/**
 * The deterministic composer: moderators in, stage list out. Pure rules on
 * purpose - auditable, consistent, and testable without a model call. This
 * is the part that makes the battery an instrument rather than a suggestion.
 */
export function composeStages(m: Moderators): ComposedStage[] {
  const stages: (ComposedStage | null)[] = [
    {
      key: "problem_recognition", label: "Problem recognition", layer: "awareness",
      situational: true, rivals: "none",
      hint: "Pain-phrased and pre-category: the buyer describes the problem without knowing the category exists. Never name the category, a brand, or a product type.",
    },
    m.think_feel === "think" && m.involvement === "considered"
      ? {
          key: "category_education", label: "Category education", layer: "awareness",
          situational: false, rivals: "none",
          hint: "The buyer asks what the category is or does ('what does a X actually do').",
        }
      : null,
    {
      key: "discovery", label: "Discovery", layer: "awareness",
      situational: true, rivals: "none",
      hint: "Open category discovery: 'best X for ...' style asks, no brands named.",
    },
    {
      key: "shortlist", label: "Shortlist", layer: "consideration",
      situational: true, rivals: "none",
      hint: "The buyer asks for a small set of options to consider.",
    },
    {
      key: "criteria", label: "Criteria formation", layer: "consideration",
      situational: false, rivals: "none",
      hint: "The buyer asks what to look for / what matters when choosing.",
    },
    m.verifiability === "spec"
      ? {
          key: "feature_screening", label: "Feature screening", layer: "consideration",
          situational: true, rivals: "none",
          hint: "Attribute-first asks: which options have a specific capability.",
        }
      : null,
    {
      key: "use_case", label: "Use-case fit", layer: "consideration",
      situational: true, rivals: "none",
      hint: "Situation-first asks describing a concrete need or workflow.",
    },
    {
      key: "social_validation", label: "Social validation", layer: "consideration",
      situational: false, rivals: "none",
      hint: m.think_feel === "feel"
        ? "What people love, compliment, or identify with - social proof in identity terms."
        : "What people actually use and rate well - reviews, communities, popularity.",
    },
    m.involvement === "considered"
      ? {
          key: "comparison",
          label: m.verifiability === "taste" ? "Dupes & alternatives" : "Comparison",
          layer: "decision", situational: true, rivals: "each",
          hint: m.verifiability === "taste"
            ? "Head-to-head and 'similar to X but cheaper/different' asks naming the rival."
            : "Head-to-head asks naming the client brand against the rival.",
        }
      : {
          key: "premium_worth", label: "Is premium worth it", layer: "decision",
          situational: false, rivals: "none",
          hint: "Whether the premium option genuinely beats the basic/store option.",
        },
    {
      key: "objections", label: "Objections / risk", layer: "decision",
      situational: true, rivals: "none",
      hint: `The buyer voices the category's dominant worry (${m.risk}) about the client brand by name.`,
    },
    {
      key: "pricing", label: "Pricing / value", layer: "decision",
      situational: true, rivals: "none",
      hint: "Cost and value-for-money asks; some generic to the category, some naming the client brand.",
    },
    m.decision_unit === "committee"
      ? {
          key: "business_case", label: "Business case", layer: "decision",
          situational: false, rivals: "none",
          hint: "The buyer asks for help justifying the client brand internally ('make the case to my CFO').",
        }
      : null,
    {
      key: "churn_triggers", label: "Churn triggers", layer: "retention",
      situational: false, rivals: "none",
      hint: "An existing customer wonders whether the client brand is still the right choice.",
    },
    {
      key: "alternatives", label: "Alternatives", layer: "retention",
      situational: false, rivals: "defensive_offensive",
      hint: "'Alternatives to X' asks - one for the client brand (defensive) and one per rival (offensive).",
    },
    m.rhythm === "subscription"
      ? {
          key: "renewal", label: "Renewal", layer: "retention",
          situational: false, rivals: "none",
          hint: "At renewal: is the client brand worth keeping, are there cheaper options.",
        }
      : null,
    {
      key: "problem_resolution", label: "Problem resolution", layer: "retention",
      situational: false, rivals: "none",
      hint: "A support-style ask: something about the client brand is broken or messy, how to fix it.",
    },
    {
      key: "expansion", label: "Expansion", layer: "loyalty",
      situational: false, rivals: "none",
      hint: "A happy customer considers using the client brand for more ('roll it out further', 'use it for Y too').",
    },
    {
      key: "ecosystem", label: "Ecosystem", layer: "loyalty",
      situational: false, rivals: "none",
      hint: "What works well WITH the client brand - add-ons, companions, integrations.",
    },
    {
      key: "advocacy", label: "Advocacy", layer: "loyalty",
      situational: false, rivals: "none",
      hint: "A customer asks how to defend or recommend the client brand to someone else.",
    },
    m.rhythm === "replenishment"
      ? {
          key: "repertoire", label: "Repertoire", layer: "loyalty",
          situational: false, rivals: "none",
          hint: "Deepening the habit: more from the same brand, or is it worth switching from the usual.",
        }
      : null,
  ];
  return stages.filter((s): s is ComposedStage => s !== null);
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

/* ------------------------------ orchestrator ---------------------------- */

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
