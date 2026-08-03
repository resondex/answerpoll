import OpenAI from "openai";
import type { ExtractedMention, Framing } from "../types";

export interface CompletionProvider {
  /** Answer a buyer-intent prompt the way a consumer assistant would. */
  complete(prompt: string, model: string): Promise<string>;
  /** Extract every brand/company mentioned in a response, in order of appearance. */
  extractMentions(
    responseText: string,
    knownBrands: string[]
  ): Promise<ExtractedMention[]>;
}

export function mockModeActive(): boolean {
  return process.env.MOCK_LLM === "1" || !process.env.OPENAI_API_KEY;
}

export function getProvider(): CompletionProvider {
  return mockModeActive() ? mockProvider : openaiProvider;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) _client = new OpenAI();
  return _client;
}

const EXTRACT_MODEL = process.env.EXTRACT_MODEL ?? "gpt-4o-mini";

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    mentions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          brand: { type: "string" },
          framing: {
            type: "string",
            enum: ["recommended", "mentioned", "negative"],
          },
        },
        required: ["brand", "framing"],
      },
    },
  },
  required: ["mentions"],
} as const;

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

const openaiProvider: CompletionProvider = {
  async complete(prompt, model) {
    return withRetry(async () => {
      const res = await client().chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
      });
      return res.choices[0]?.message?.content ?? "";
    });
  },

  async extractMentions(responseText, knownBrands) {
    return withRetry(async () => {
      const res = await client().chat.completions.create({
        model: EXTRACT_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You extract brand mentions from an AI assistant's answer. " +
              "List every company, brand, product, or provider name mentioned, " +
              "in order of first appearance. For each, classify the framing: " +
              "'recommended' if the answer endorses or ranks it favorably, " +
              "'negative' if it is criticized or advised against, otherwise 'mentioned'. " +
              `Names to watch for (extract others too): ${knownBrands.join(", ")}.`,
          },
          { role: "user", content: responseText },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "brand_mentions",
            strict: true,
            schema: EXTRACT_SCHEMA,
          },
        },
      });
      const raw = res.choices[0]?.message?.content ?? '{"mentions":[]}';
      const parsed = JSON.parse(raw) as { mentions: ExtractedMention[] };
      return dedupeMentions(parsed.mentions);
    });
  },
};

// ---------------------------------------------------------------------------
// Mock provider — lets the full pipeline run with zero API spend.
// Synthesizes plausible ranked answers from the project's brand pool.
// ---------------------------------------------------------------------------

const FILLER_BRANDS = [
  "Northstar",
  "Beaconview",
  "Silverline",
  "Cartwright & Co",
  "Bluefield",
  "Meridian Group",
];

const BLURBS = [
  "a strong all-around choice with consistently good reviews",
  "well regarded for value and customer support",
  "a premium option that leads on features",
  "popular with newcomers thanks to its simplicity",
  "a long-established name with a loyal following",
  "an up-and-coming option worth watching",
];

const MOCK_DELAY_MS = 120;

function mockPool(knownBrands: string[]): { brand: string; p: number }[] {
  // Target brand is passed first by the runner; give it a modest appearance
  // probability so mock dashboards look realistically mid-pack.
  return [
    ...knownBrands.map((brand, i) => ({
      brand,
      p: i === 0 ? 0.45 : Math.max(0.25, 0.85 - i * 0.15),
    })),
    ...FILLER_BRANDS.map((brand, i) => ({ brand, p: 0.3 - i * 0.03 })),
  ];
}

const mockProvider: CompletionProvider = {
  async complete(prompt, _model) {
    await new Promise((r) => setTimeout(r, MOCK_DELAY_MS));
    // knownBrands aren't available at completion time for the mock, so embed
    // them via the prompt marker the runner appends in mock mode.
    const marker = prompt.match(/\[\[brands:(.*?)\]\]/);
    const brands = marker ? marker[1].split("|") : FILLER_BRANDS.slice(0, 3);
    const picked = mockPool(brands)
      .filter(({ p }) => Math.random() < p)
      .map(({ brand }) => brand)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3 + Math.floor(Math.random() * 3));
    if (picked.length === 0) picked.push(brands[brands.length - 1]);
    const lines = picked.map(
      (b, i) => `${i + 1}. **${b}** — ${BLURBS[(i + b.length) % BLURBS.length]}.`
    );
    return [
      "Here are the options I'd suggest looking into:",
      ...lines,
      "The right pick depends on your budget and priorities.",
    ].join("\n");
  },

  async extractMentions(responseText, knownBrands) {
    const pool = [...knownBrands, ...FILLER_BRANDS];
    const found: { brand: string; idx: number }[] = [];
    for (const brand of pool) {
      const idx = responseText.toLowerCase().indexOf(brand.toLowerCase());
      if (idx >= 0) found.push({ brand, idx });
    }
    found.sort((a, b) => a.idx - b.idx);
    return dedupeMentions(
      found.map(({ brand }, i) => ({
        brand,
        framing: (i < 2 ? "recommended" : "mentioned") as Framing,
      }))
    );
  },
};

function dedupeMentions(mentions: ExtractedMention[]): ExtractedMention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const key = m.brand.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
