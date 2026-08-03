import OpenAI from "openai";
import type { ExtractedMention } from "../types";

export interface CompletionProvider {
  /** Answer a buyer-intent prompt the way a consumer assistant would. */
  complete(prompt: string, model: string): Promise<string>;
  /** Extract every brand/company mentioned in a response, in order of appearance. */
  extractMentions(
    responseText: string,
    knownBrands: string[]
  ): Promise<ExtractedMention[]>;
}

export function apiKeyConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function getProvider(): CompletionProvider {
  return openaiProvider;
}

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

function dedupeMentions(mentions: ExtractedMention[]): ExtractedMention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const key = m.brand.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
