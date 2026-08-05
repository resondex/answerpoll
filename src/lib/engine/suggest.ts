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

// v4: style targets + theme quotas calibrated to n=1,006 verified commercial
// prompts harvested from WildChat-4.8M — see style_profile.json.
const BATTERY_STYLE_VERSION = "v4";

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
            "competitor list only tells you what market this is.\n\n" +
            "Register examples from a DIFFERENT category (match this feel, not the topic):\n" +
            "- 'best project management tool for a small construction company'\n" +
            "- 'my team keeps missing deadlines, what app should we use to track jobs?'\n" +
            "- 'whats a good free alternative to the big project management apps'\n" +
            "- 'We're a 12-person remodeling company and everything lives in text " +
            "threads right now. I need something the field guys will actually use — " +
            "what would you recommend and why?'\n\n" +
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
