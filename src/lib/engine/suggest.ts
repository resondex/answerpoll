import { openaiClient } from "./providers";
import { generatePromptBattery, type PromptSpec } from "./prompts";

const SUGGEST_MODEL = process.env.SUGGEST_MODEL ?? "gpt-5-mini";

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
          "- category: the competitive category as a plural noun phrase, worded " +
          "the way a buyer would say it to an AI assistant. Be SPECIFIC — " +
          "'project management tools for software teams', never a broad word " +
          "like 'software' or 'companies'.\n" +
          "- competitors: 3 to 6 direct competitors buyers actually compare it against.\n" +
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

/**
 * Generate the unbranded battery with the model (falling back to templates),
 * then append the two formulaic branded probes. Unbranded prompts must never
 * name the target or competitors — that's the measurement's blindness.
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
            "You write prompt batteries for measuring brand visibility in AI " +
            "answers. Produce exactly 12 prompts a real buyer would ask an AI " +
            "assistant when shopping in the given category: 3 with theme " +
            "'discovery' (best/top/leading questions), 4 'recommendation' " +
            "(personal advice questions), 3 'comparison' (compare/pros-cons/" +
            "alternatives), 2 'use_case' (budget, trust, or situation-specific). " +
            "Rules: natural buyer language; vary the phrasing; mention the " +
            "audience where it fits; NEVER name any brand — not the target, " +
            "not the competitors. The competitor list is context for what the " +
            "category means, nothing more.",
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
