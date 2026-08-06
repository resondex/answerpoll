import { createHash } from "crypto";
import { openaiClient } from "./providers";
import { store } from "../store";
import { generatePromptBattery, type PromptSpec } from "./prompts";

const SUGGEST_MODEL = process.env.SUGGEST_MODEL ?? "gpt-5-mini";
const CACHE_TTL_MS = 183 * 24 * 3600 * 1000; // ~6 months

function cacheKey(prefix: string, parts: (string | null)[]): string {
  const normalized = parts.map((p) => (p ?? "").trim().toLowerCase()).join("|");
  return `${prefix}:${createHash("sha256").update(normalized).digest("hex")}`;
}

export interface BrandProfile {
  category: string;
  competitors: string[];
  audience: string;
}

const PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: { type: "string" },
    competitors: { type: "array", items: { type: "string" } },
    audience: { type: "string" },
  },
  required: ["category", "competitors", "audience"],
} as const;

/** Cache-first profile estimation — one live call per brand per ~6 months. */
export async function getBrandProfile(brand: string): Promise<BrandProfile> {
  const key = cacheKey("analyze", [brand]);
  const hit = await store.cacheGet(key, CACHE_TTL_MS);
  if (hit) return JSON.parse(hit) as BrandProfile;
  const profile = await suggestBrandProfile(brand);
  await store.cacheSet(key, JSON.stringify(profile));
  return profile;
}

/** Cache-first battery generation; force=true skips the read (still writes). */
export async function getBattery(
  input: {
    brand: string;
    category: string;
    competitors: string[];
    audience: string | null;
  },
  force = false
): Promise<PromptSpec[]> {
  // Version in the key: prompt-writing changes must bypass old cached batteries.
  const key = cacheKey("battery", [
    BATTERY_STYLE_VERSION,
    input.brand,
    input.category,
    [...input.competitors].sort().join(","),
    input.audience,
  ]);
  if (!force) {
    const hit = await store.cacheGet(key, CACHE_TTL_MS);
    if (hit) return JSON.parse(hit) as PromptSpec[];
  }
  const battery = await generateBatteryAi(input);
  await store.cacheSet(key, JSON.stringify(battery));
  return battery;
}

const TAXONOMY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { codes: { type: "array", items: { type: "string" } } },
  required: ["codes"],
} as const;

/**
 * Closed reason-code taxonomy for a category — the arguments assistants use
 * to justify recommendations. Generated once per category (cache-first) and
 * frozen on the project at creation.
 */
export async function getReasonTaxonomy(input: {
  category: string;
  competitors: string[];
}): Promise<string[]> {
  const key = cacheKey("taxonomy", [
    input.category,
    [...input.competitors].sort().join(","),
  ]);
  const hit = await store.cacheGet(key, CACHE_TTL_MS);
  if (hit) return JSON.parse(hit) as string[];
  const res = await openaiClient().chat.completions.create({
    model: SUGGEST_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Produce a closed taxonomy of 18 to 22 reason codes: the arguments " +
          "an AI assistant uses to justify or compare recommendations in the " +
          "given category (the credit-card equivalents are 'annual fee', " +
          "'lounge access', 'cash back'). Rules: short lowercase noun phrases " +
          "(1-3 words), mutually distinct, spanning price/cost, quality, " +
          "features, ease of use, trust/reputation, fit-for-situation, and any " +
          "category-specific dimensions. No brand names.",
      },
      {
        role: "user",
        content: JSON.stringify({
          category: input.category,
          competitor_context: input.competitors,
        }),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "taxonomy", strict: true, schema: TAXONOMY_SCHEMA },
    },
  });
  const codes = [
    ...new Set(
      (JSON.parse(res.choices[0]?.message?.content ?? '{"codes":[]}')
        .codes as string[])
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean)
    ),
  ].slice(0, 24);
  await store.cacheSet(key, JSON.stringify(codes));
  return codes;
}

const ALIAS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          canonical: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
        },
        required: ["canonical", "aliases"],
      },
    },
  },
  required: ["entries"],
} as const;

/** Seed the project dictionary: known aliases for target + competitors. */
export async function seedDictionary(
  projectId: string,
  brands: string[]
): Promise<void> {
  let entries: { canonical: string; aliases: string[] }[] = brands.map(
    (b) => ({ canonical: b, aliases: [] })
  );
  try {
    const key = cacheKey("aliases", [[...brands].sort().join(",")]);
    const hit = await store.cacheGet(key, CACHE_TTL_MS);
    if (hit) {
      entries = JSON.parse(hit);
    } else {
      const res = await openaiClient().chat.completions.create({
        model: SUGGEST_MODEL,
        messages: [
          {
            role: "system",
            content:
              "For each brand, list the alternate names, abbreviations, and " +
              "spellings an AI answer might use for the SAME brand (e.g. " +
              "'American Express' → ['amex', 'americanexpress']). Lowercase " +
              "aliases. Only genuinely equivalent names — never other brands.",
          },
          { role: "user", content: JSON.stringify(brands) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "aliases", strict: true, schema: ALIAS_SCHEMA },
        },
      });
      entries = JSON.parse(
        res.choices[0]?.message?.content ?? '{"entries":[]}'
      ).entries;
      await store.cacheSet(key, JSON.stringify(entries));
    }
  } catch (err) {
    console.error("alias seeding fell back to bare entries:", err);
  }
  await store.insertDictionaryEntries(
    projectId,
    entries.map((e) => ({
      canonical: e.canonical,
      aliases: e.aliases.map((a) => a.trim().toLowerCase()).filter(Boolean),
    }))
  );
}

const LINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          anchored: { type: "boolean" },
          inferred_category: { type: "string" },
          spec_sheet: { type: "boolean" },
        },
        required: ["anchored", "inferred_category", "spec_sheet"],
      },
    },
  },
  required: ["results"],
} as const;

const REPAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rewritten: { type: "array", items: { type: "string" } },
  },
  required: ["rewritten"],
} as const;

/**
 * Battery lint: each prompt is read cold by a classifier that checks two
 * failure modes — anchoring (the inferred category doesn't match the study
 * category) and spec-sheet texture (a long prompt written as a requirements
 * list instead of how people actually type). Failing prompts get one repair
 * round scoped to their specific issues; unrepairable ones survive as-is and
 * are caught later by the post-first-run health check.
 */
async function lintAndRepair(
  prompts: PromptSpec[],
  category: string
): Promise<PromptSpec[]> {
  try {
    const lintRes = await openaiClient().chat.completions.create({
      model: SUGGEST_MODEL,
      messages: [
        {
          role: "system",
          content:
            "For each prompt, imagine an AI assistant reading ONLY that prompt " +
            "with no other context. Report:\n" +
            "- inferred_category: what product/service category the assistant " +
            "would understand the prompt to be about.\n" +
            "- anchored: whether that clearly matches the study category " +
            `"${category}". A prompt about 'a tool' or 'our tooling' with no ` +
            "category signal is NOT anchored.\n" +
            "- spec_sheet: whether the prompt reads like a requirements list " +
            "or RFP rather than something a person typed into a chat box — " +
            "four or more requirements chained in parallel clauses, or precise " +
            "round constraints like an exact annual budget or an exact " +
            "adoption timeline. Real typed prompts carry at most 2-3 explicit " +
            "needs and vague constraints ('cheap', 'easy to pick up'); long " +
            "ones are long because of backstory, not feature lists.\n" +
            "Return one result per prompt, in order.",
        },
        { role: "user", content: JSON.stringify(prompts.map((p) => p.text)) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "lint", strict: true, schema: LINT_SCHEMA },
      },
    });
    const results = (
      JSON.parse(lintRes.choices[0]?.message?.content ?? '{"results":[]}') as {
        results: {
          anchored: boolean;
          inferred_category: string;
          spec_sheet: boolean;
        }[];
      }
    ).results;
    const bad = prompts
      .map((p, i) => ({
        p,
        i,
        issues: [
          ...(results[i] && !results[i].anchored ? ["anchoring"] : []),
          ...(results[i]?.spec_sheet ? ["spec_sheet"] : []),
        ],
      }))
      .filter((x) => x.issues.length > 0);
    if (bad.length === 0) return prompts;
    console.log(
      `battery lint: repairing ${bad.length} prompt(s):`,
      bad.map((b) => ({ text: b.p.text, issues: b.issues }))
    );
    const repairRes = await openaiClient().chat.completions.create({
      model: SUGGEST_MODEL,
      messages: [
        {
          role: "system",
          content:
            "Rewrite each prompt to fix ONLY its listed issues, preserving " +
            "the intent and the casual register. Never add brand names.\n" +
            "- 'anchoring': make the prompt unambiguously about " +
            `"${category}" when read with zero context — work the category ` +
            "(or an unmistakable everyday synonym) into it. Preserve the " +
            "specific details and the length.\n" +
            "- 'spec_sheet': keep roughly the length, but convert the " +
            "requirements list into how a person actually types — backstory, " +
            "what's going wrong, the ask sometimes buried mid-thought. Keep " +
            "the 2 or 3 needs that matter most and DROP the rest. Replace " +
            "precise round constraints with vague ones ('cheap', 'not too " +
            "complicated', 'something the team will actually use').\n" +
            "Return the rewrites in order.",
        },
        {
          role: "user",
          content: JSON.stringify(
            bad.map((b) => ({ text: b.p.text, issues: b.issues }))
          ),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "repair", strict: true, schema: REPAIR_SCHEMA },
      },
    });
    const rewritten = (
      JSON.parse(
        repairRes.choices[0]?.message?.content ?? '{"rewritten":[]}'
      ) as { rewritten: string[] }
    ).rewritten;
    const out = [...prompts];
    bad.forEach((b, j) => {
      const text = rewritten[j]?.trim();
      if (text) out[b.i] = { ...b.p, text };
    });
    return out;
  } catch (err) {
    console.error("battery lint failed, battery unmodified:", err);
    return prompts;
  }
}

/** Estimate a brand's competitive category, rivals, and buyer audience. */
export async function suggestBrandProfile(
  brand: string
): Promise<BrandProfile> {
  const res = await openaiClient().chat.completions.create({
    model: SUGGEST_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You help set up brand-visibility tracking for AI answer engines. " +
          "Given a brand, identify:\n" +
          "- category: the competitive category as a short plural noun phrase, " +
          "worded the way a buyer would actually type it — 'project management " +
          "tools', 'CRM software', 'assisted living communities'. At most ONE " +
          "qualifier, and only when the market truly needs it; never stack " +
          "qualifiers, and never use a lone broad word like 'software' or " +
          "'companies'.\n" +
          "- competitors: the 4 to 6 brands buyers most often weigh against it. " +
          "Lead with the mainstream market leaders in the category, not niche " +
          "or same-subculture alternatives.\n" +
          "- audience: the primary buyer audience in a short phrase.\n" +
          "If the brand is ambiguous or unknown, pick the most likely commercial " +
          "interpretation and answer anyway.",
      },
      { role: "user", content: brand },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "brand_profile",
        strict: true,
        schema: PROFILE_SCHEMA,
      },
    },
  });
  const raw = res.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as BrandProfile;
  return {
    category: parsed.category?.trim() ?? "",
    competitors: (parsed.competitors ?? [])
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, 6),
    audience: parsed.audience?.trim() ?? "",
  };
}

const BATTERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          theme: {
            type: "string",
            enum: ["discovery", "recommendation", "comparison", "use_case"],
          },
        },
        required: ["text", "theme"],
      },
    },
  },
  required: ["prompts"],
} as const;

// v6: v5 anchoring + long-prompt texture rule (long = backstory, never a
// requirements list; no precise round constraints) with spec-sheet lint.
const BATTERY_STYLE_VERSION = "v6";

/**
 * Generate the unbranded battery with the model (falling back to templates),
 * then append the two formulaic branded probes. Unbranded prompts must never
 * name the target or competitors — that's the measurement's blindness — and
 * must read like real typed prompts, not survey questions.
 */
export async function generateBatteryAi(input: {
  brand: string;
  category: string;
  competitors: string[];
  audience: string | null;
}): Promise<PromptSpec[]> {
  let unbranded: PromptSpec[] = [];
  try {
    const res = await openaiClient().chat.completions.create({
      model: SUGGEST_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You write prompt batteries for measuring brand visibility in AI answers. " +
            "Each prompt must read like something a REAL person actually typed into " +
            "ChatGPT. Imagine 12 different people, each in a concrete situation that " +
            "puts them in the market for this category, and write exactly what each " +
            "one would type.\n\n" +
            "Length calibration — these targets are measured from 1,006 verified " +
            "commercial prompts in the WildChat corpus of real ChatGPT " +
            "conversations; your set of 12 must match them:\n" +
            "- median length ~17 words; about 3 prompts under 10 words; about 7 " +
            "under 20 words; 3 or 4 over 40 words\n" +
            "- up to 3 prompts with multiple sentences (real buyers do dump " +
            "context sometimes) — the rest are a single sentence or fragment\n" +
            "- about 5 prompts start lowercase; roughly 8 have NO ending " +
            "punctuation; only ~2 end with a question mark\n" +
            "- about half use first person; 'please' at most once\n\n" +
            "Style rules — follow every one:\n" +
            "- Everyday words. When a prompt does carry detail, make it concrete " +
            "(team size, budget, what's going wrong) — but most prompts are short " +
            "asks without backstory.\n" +
            "- BANNED vocabulary: 'solutions', 'platforms', 'leading', 'top options', " +
            "'best-in-class', 'robust', 'streamline', 'leverage', and any phrasing " +
            "that sounds like a survey question or analyst report. People say 'apps', " +
            "'tools', 'companies', 'places', or the plain category word.\n" +
            "- Never describe the asker with the audience label. Nobody calls " +
            "themselves an 'IT leader' or a 'knowledge worker' — they say 'I run IT " +
            "at a mid-size company' or 'my team of 8'. Use the audience to pick " +
            "realistic situations, never as words in the prompt.\n" +
            "- Sentence case or lowercase; punctuation optional on short fragments. " +
            "Imperfect grammar is fine. No typos.\n" +
            "- NEVER name any brand — not the target, not the competitors. The " +
            "competitor list only tells you what market this is.\n" +
            "- CATEGORY ANCHOR (hard rule): each prompt is read cold, with no " +
            "conversation context. Every prompt must unambiguously be about the " +
            "given category on its face — a reader seeing only the prompt must " +
            "know what kind of product is being asked about. Never write 'a " +
            "tool', 'something', or 'our tooling' without the category (or an " +
            "unmistakable synonym of it) in the prompt.\n" +
            "- LONG PROMPT TEXTURE (hard rule): when a prompt runs long, it is " +
            "long because of STORY — backstory, what's going wrong, half-formed " +
            "thoughts — never because of a requirements list. At most 2 or 3 " +
            "explicit needs per prompt. NEVER chain four or more features in " +
            "parallel clauses ('handle X, Y, Z, and support A, B, and C') — " +
            "that reads like an RFP, and nobody types RFPs into a chat box. " +
            "Constraints stay vague the way people talk ('cheap', 'not too " +
            "complicated', 'something the team will actually use'), never " +
            "precise round figures ('$5,000 annually', 'learn in under two " +
            "weeks').\n\n" +
            "Register examples from a DIFFERENT category (match this feel, not the topic):\n" +
            "- 'best project management tool for a small construction company'\n" +
            "- 'my team keeps missing deadlines, what app should we use to track jobs?'\n" +
            "- 'whats a good free alternative to the big project management apps'\n" +
            "- 'so we've been scheduling crews in spreadsheets for like 2 years " +
            "and it's honestly a mess, jobs get double booked, nobody knows whos " +
            "on what site, and my boss now wants some kind of calendar the " +
            "office and the field can both see. we're maybe 15 people. is real " +
            "scheduling software worth it for us or is there something simpler'\n\n" +
            "Produce exactly 12, with theme counts matching the measured " +
            "distribution of real commercial asks (59% discovery / 27% " +
            "recommendation / 8% comparison / 6% use_case): 7 'discovery' " +
            "(what's out there / best-of asks), 3 'recommendation' (advice for " +
            "their specific situation), 1 'comparison' (weighing types, tradeoffs, " +
            "or alternatives), 1 'use_case' (budget, trust, or a situational " +
            "constraint).",
        },
        {
          role: "user",
          content: JSON.stringify({
            category: input.category,
            audience: input.audience,
            competitor_context: input.competitors,
          }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "prompt_battery",
          strict: true,
          schema: BATTERY_SCHEMA,
        },
      },
    });
    const raw = res.choices[0]?.message?.content ?? '{"prompts":[]}';
    const parsed = JSON.parse(raw) as { prompts: PromptSpec[] };
    unbranded = parsed.prompts
      .map((p) => ({ text: p.text.trim(), theme: p.theme }))
      .filter((p) => p.text.length > 0);
  } catch (err) {
    console.error("battery generation failed, using templates:", err);
  }
  if (unbranded.length < 8) {
    unbranded = generatePromptBattery({
      brand: input.brand,
      category: input.category,
      audience: input.audience,
    }).filter((p) => p.theme !== "branded");
  } else {
    unbranded = await lintAndRepair(unbranded, input.category);
  }
  return [
    ...unbranded,
    {
      text: `Is ${input.brand} a good option? What do people say about it?`,
      theme: "branded",
    },
    {
      text: `How does ${input.brand} compare to other ${input.category}?`,
      theme: "branded",
    },
  ];
}
