import OpenAI from "openai";
import type { ExtractedMention, ExtractionResult } from "../types";

export interface ExtractionContext {
  targetBrand: string;
  knownBrands: string[];
  reasonCodes: string[];
}

export interface CompletionProvider {
  /** Answer a buyer-intent prompt the way a consumer assistant would. */
  complete(prompt: string, model: string): Promise<string>;
  /** Full per-answer coding: mentions, top pick, outcome, reasons, focus quote. */
  extractCoding(
    responseText: string,
    ctx: ExtractionContext
  ): Promise<ExtractionResult>;
}

export function apiKeyConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function getProvider(): CompletionProvider {
  return openaiProvider;
}

let _client: OpenAI | null = null;
export function openaiClient(): OpenAI {
  if (!_client) _client = new OpenAI();
  return _client;
}
const client = openaiClient;

const EXTRACT_MODEL = process.env.EXTRACT_MODEL ?? "gpt-4o-mini";

function extractSchema(reasonCodes: string[]) {
  return {
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
      top_pick_brand: { type: ["string", "null"] },
      outcome: { type: "string", enum: ["pick", "no_pick", "clarification"] },
      reasons:
        reasonCodes.length > 0
          ? { type: "array", items: { type: "string", enum: reasonCodes } }
          : { type: "array", items: { type: "string" } },
      clarification_requested: { type: "boolean" },
      gives_recommendation: { type: "boolean" },
      includes_prices: { type: "boolean" },
      includes_specs: { type: "boolean" },
      total_recommendations: { type: "integer" },
      focus_quote: { type: ["string", "null"] },
      focus_interpretation: { type: ["string", "null"] },
    },
    required: [
      "mentions",
      "top_pick_brand",
      "outcome",
      "reasons",
      "clarification_requested",
      "gives_recommendation",
      "includes_prices",
      "includes_specs",
      "total_recommendations",
      "focus_quote",
      "focus_interpretation",
    ],
  } as const;
}

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

  async extractCoding(responseText, ctx) {
    return withRetry(async () => {
      const res = await client().chat.completions.create({
        model: EXTRACT_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You code an AI assistant's answer for a brand-visibility study. " +
              `The focus brand is "${ctx.targetBrand}". Return:\n` +
              "- mentions: every company, brand, product, or provider named, in " +
              "order of first appearance. framing: 'recommended' if endorsed or " +
              "ranked favorably, 'negative' if criticized or advised against, " +
              "else 'mentioned'.\n" +
              "- top_pick_brand: the ONE brand the answer explicitly crowns as " +
              "its choice ('my pick', 'best overall', the one it would get). " +
              "This is about endorsement, not order — it may differ from the " +
              "first brand mentioned. null if the answer commits to none.\n" +
              "- outcome: 'pick' when a top pick exists; 'clarification' when " +
              "the answer mainly asks a question instead of answering; " +
              "'no_pick' when it explains options without committing.\n" +
              "- reasons: which of the allowed argument codes the answer uses " +
              "to justify or compare options. Only codes from the list.\n" +
              "- clarification_requested: does it ask the user anything?\n" +
              "- gives_recommendation: does it recommend at least one option?\n" +
              "- includes_prices: any price, fee, or cost figure quoted?\n" +
              "- includes_specs: any concrete spec/feature figures quoted?\n" +
              "- total_recommendations: how many distinct options it recommends.\n" +
              `- focus_quote: a verbatim sentence (max 200 chars) about ` +
              `"${ctx.targetBrand}" from the answer; null if the brand is absent.\n` +
              `- focus_interpretation: one plain sentence on how the answer ` +
              `positions "${ctx.targetBrand}"; null if absent.\n` +
              `Known brands (extract others too): ${ctx.knownBrands.join(", ")}.`,
          },
          { role: "user", content: responseText },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "answer_coding",
            strict: true,
            schema: extractSchema(ctx.reasonCodes),
          },
        },
      });
      const raw = res.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw) as ExtractionResult;
      return {
        ...parsed,
        mentions: dedupeMentions(parsed.mentions ?? []),
        reasons: [...new Set(parsed.reasons ?? [])],
      };
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
