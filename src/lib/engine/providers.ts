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

/**
 * The measurement engines — the assistants whose answers we sample. Every
 * one is a distinct "view" of the category; adding an engine adds rows to
 * the analyses, never new analysis code. Extraction deliberately stays on
 * ONE fixed coder across all engines (see EXTRACT_MODEL): if the coder
 * varied by engine, coder drift would masquerade as engine differences.
 */
export interface Engine {
  id: string;
  label: string;
  vendor: string;
  keyEnv: string;
  /** OpenAI-compatible endpoint; absent means the vendor's own SDK. */
  baseURL?: string;
  sdk?: "anthropic";
}

export const ENGINES: Engine[] = [
  { id: "gpt-5-mini", label: "ChatGPT (default tier)", vendor: "OpenAI", keyEnv: "OPENAI_API_KEY" },
  { id: "gpt-5", label: "ChatGPT (premium tier)", vendor: "OpenAI", keyEnv: "OPENAI_API_KEY" },
  { id: "claude-sonnet-5", label: "Claude (Sonnet)", vendor: "Anthropic", keyEnv: "ANTHROPIC_API_KEY", sdk: "anthropic" },
  { id: "claude-haiku-4-5-20251001", label: "Claude (Haiku)", vendor: "Anthropic", keyEnv: "ANTHROPIC_API_KEY", sdk: "anthropic" },
  {
    id: "gemini-pro-latest",
    label: "Gemini (Pro)",
    vendor: "Google",
    keyEnv: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  },
  {
    id: "gemini-flash-latest",
    label: "Gemini (Flash)",
    vendor: "Google",
    keyEnv: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  },
  { id: "grok-4", label: "Grok", vendor: "xAI", keyEnv: "XAI_API_KEY", baseURL: "https://api.x.ai/v1" },
  {
    id: "sonar",
    label: "Perplexity (grounded)",
    vendor: "Perplexity",
    keyEnv: "PERPLEXITY_API_KEY",
    baseURL: "https://api.perplexity.ai",
  },
];

export function getEngine(id: string): Engine | undefined {
  return ENGINES.find((e) => e.id === id);
}

/** Engines whose vendor key is present in this environment. */
export function availableEngines(): Engine[] {
  return ENGINES.filter((e) => Boolean(process.env[e.keyEnv]));
}

export function engineAvailable(id: string): boolean {
  const e = getEngine(id);
  return Boolean(e && process.env[e.keyEnv]);
}

/** Answering + coding both need OpenAI: it is the fixed extraction coder. */
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

const _compat = new Map<string, OpenAI>();
function compatClient(engine: Engine): OpenAI {
  const key = engine.baseURL ?? "default";
  let c = _compat.get(key);
  if (!c) {
    c = new OpenAI({
      apiKey: process.env[engine.keyEnv],
      baseURL: engine.baseURL,
    });
    _compat.set(key, c);
  }
  return c;
}

let _anthropic: import("@anthropic-ai/sdk").default | null = null;
export async function anthropicClient() {
  if (!_anthropic) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    _anthropic = new Anthropic();
  }
  return _anthropic;
}

/** Sample one answer from a named engine, the way a consumer assistant
 * would answer it: single turn, no system prompt, fresh session. The finish
 * reason is recorded so truncation is a stored fact, not a guess. */
export async function completeWithEngine(
  engineId: string,
  prompt: string
): Promise<{
  text: string;
  finishReason: string | null;
  /** Source URLs for grounded engines (Perplexity); null when ungrounded. */
  citations: string[] | null;
}> {
  const engine = getEngine(engineId);
  if (!engine) throw new Error(`unknown engine: ${engineId}`);
  if (!process.env[engine.keyEnv]) {
    throw new Error(`${engine.keyEnv} is not configured for ${engine.label}`);
  }
  return withRetry(async () => {
    if (engine.sdk === "anthropic") {
      const a = await anthropicClient();
      const res = await a.messages.create({
        model: engine.id,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });
      return {
        text: res.content
          .filter((b): b is { type: "text"; text: string; citations: never } =>
            b.type === "text"
          )
          .map((b) => b.text)
          .join("\n"),
        finishReason: res.stop_reason ?? null,
        citations: null,
      };
    }
    const c = engine.baseURL ? compatClient(engine) : client();
    const res = await c.chat.completions.create({
      model: engine.id,
      messages: [{ role: "user", content: prompt }],
    });
    // Perplexity attaches the grounded source list as non-standard fields.
    const extra = res as unknown as {
      citations?: string[];
      search_results?: { url?: string }[];
    };
    const citations =
      extra.citations ??
      extra.search_results
        ?.map((r) => r.url)
        .filter((u): u is string => Boolean(u)) ??
      null;
    return {
      text: res.choices[0]?.message?.content ?? "",
      finishReason: res.choices[0]?.finish_reason ?? null,
      citations: citations && citations.length > 0 ? citations : null,
    };
  });
}

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
              "order of first appearance. ONLY proper-noun names — a generic " +
              "descriptor ('a self-hosted server', 'open-source tools', " +
              "'spreadsheets', 'a custom build') is NEVER a mention, even when " +
              "the answer recommends it as an alternative. A phrase naming " +
              "several brands at once ('Trello / Asana', 'Jira or Linear') is " +
              "listed as one mention PER brand, never as a compound. A feature " +
              "fragment without its brand ('Issue Boards') is attributed to " +
              "the full product name when the answer makes it clear, otherwise " +
              "omitted. framing: " +
              "'recommended' if endorsed or ranked favorably, 'negative' if " +
              "criticized or advised against, else 'mentioned'.\n" +
              "- top_pick_brand: the ONE brand the answer explicitly crowns as " +
              "its choice ('my pick', 'best overall', the one it would get). " +
              "This is about endorsement, not order — it may differ from the " +
              "first brand mentioned. Must be a proper-noun brand/product; if " +
              "the answer's choice is a generic approach rather than a named " +
              "product, top_pick_brand is null. null too if the answer commits " +
              "to none.\n" +
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
      // Structured outputs guarantee the TYPE, not the semantics: the model
      // occasionally writes the string "null" where it means no pick.
      const pick =
        parsed.top_pick_brand &&
        !/^(null|none|n\/a|no pick|no_pick)$/i.test(parsed.top_pick_brand.trim())
          ? parsed.top_pick_brand
          : null;
      return {
        ...parsed,
        top_pick_brand: pick,
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
