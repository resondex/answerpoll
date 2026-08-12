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
export type EngineMode = "instinct" | "search";

export interface Engine {
  id: string;
  label: string;
  vendor: string;
  keyEnv: string;
  /** OpenAI-compatible endpoint; absent means the vendor's own SDK. */
  baseURL?: string;
  sdk?: "anthropic";
  /**
   * Instinct = the model answers from its trained knowledge, no retrieval —
   * the stable baseline. Search = the assistant may search the web
   * mid-answer, the way the consumer apps behave; answers carry citations
   * and a per-answer search count. Same underlying model, two instruments.
   */
  mode: EngineMode;
  /** Model id sent to the vendor when it differs from our registry id
   * (search variants share the base model). */
  apiModel?: string;
}

export const ENGINES: Engine[] = [
  { id: "gpt-5-mini", label: "ChatGPT (default tier)", vendor: "OpenAI", keyEnv: "OPENAI_API_KEY", mode: "instinct" },
  { id: "gpt-5-mini-search", label: "ChatGPT (default tier) + search", vendor: "OpenAI", keyEnv: "OPENAI_API_KEY", mode: "search", apiModel: "gpt-5-mini" },
  { id: "gpt-5", label: "ChatGPT (premium tier)", vendor: "OpenAI", keyEnv: "OPENAI_API_KEY", mode: "instinct" },
  { id: "gpt-5-search", label: "ChatGPT (premium tier) + search", vendor: "OpenAI", keyEnv: "OPENAI_API_KEY", mode: "search", apiModel: "gpt-5" },
  { id: "claude-sonnet-5", label: "Claude (Sonnet)", vendor: "Anthropic", keyEnv: "ANTHROPIC_API_KEY", sdk: "anthropic", mode: "instinct" },
  { id: "claude-sonnet-5-search", label: "Claude (Sonnet) + search", vendor: "Anthropic", keyEnv: "ANTHROPIC_API_KEY", sdk: "anthropic", mode: "search", apiModel: "claude-sonnet-5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude (Haiku)", vendor: "Anthropic", keyEnv: "ANTHROPIC_API_KEY", sdk: "anthropic", mode: "instinct" },
  {
    id: "gemini-pro-latest",
    label: "Gemini (Pro)",
    vendor: "Google",
    keyEnv: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    mode: "instinct",
  },
  {
    id: "gemini-flash-latest",
    label: "Gemini (Flash)",
    vendor: "Google",
    keyEnv: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    mode: "instinct",
  },
  { id: "grok-4", label: "Grok", vendor: "xAI", keyEnv: "XAI_API_KEY", baseURL: "https://api.x.ai/v1", mode: "instinct" },
  {
    // Perplexity has no instinct mode — retrieval IS the product.
    id: "sonar",
    label: "Perplexity (grounded)",
    vendor: "Perplexity",
    keyEnv: "PERPLEXITY_API_KEY",
    baseURL: "https://api.perplexity.ai",
    mode: "search",
  },
];

/** Which mode an engine id measures; unknown ids read as instinct. */
export function engineMode(id: string): EngineMode {
  return getEngine(id)?.mode ?? "instinct";
}

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
 * reason is recorded so truncation is a stored fact, not a guess. Search
 * engines may retrieve mid-answer; how often they chose to is recorded as
 * searchCount (null = the vendor doesn't report it). */
export async function completeWithEngine(
  engineId: string,
  prompt: string
): Promise<{
  text: string;
  finishReason: string | null;
  /** Source URLs for grounded/search answers; null when ungrounded. */
  citations: string[] | null;
  /** Web searches the model chose to run for this answer; 0 = had the tool
   * but answered from weights; null = not reported (instinct engines, and
   * always-grounded vendors like Perplexity). */
  searchCount: number | null;
}> {
  const engine = getEngine(engineId);
  if (!engine) throw new Error(`unknown engine: ${engineId}`);
  if (!process.env[engine.keyEnv]) {
    throw new Error(`${engine.keyEnv} is not configured for ${engine.label}`);
  }
  const model = engine.apiModel ?? engine.id;
  return withRetry(async () => {
    if (engine.sdk === "anthropic") {
      const a = await anthropicClient();
      const res = await a.messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        ...(engine.mode === "search"
          ? {
              tools: [
                // Server-side web search — the model decides per answer
                // whether to use it, mirroring claude.ai's default.
                { type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 3 },
              ],
            }
          : {}),
      });
      const urls = new Set<string>();
      for (const b of res.content) {
        if (b.type !== "text") continue;
        const cites = (b as { citations?: { url?: string }[] }).citations;
        for (const c of cites ?? []) if (c.url) urls.add(c.url);
      }
      const usage = res.usage as unknown as {
        server_tool_use?: { web_search_requests?: number };
      };
      return {
        text: res.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
        finishReason: res.stop_reason ?? null,
        citations: urls.size > 0 ? [...urls] : null,
        searchCount:
          engine.mode === "search"
            ? usage.server_tool_use?.web_search_requests ?? 0
            : null,
      };
    }
    if (engine.mode === "search" && !engine.baseURL) {
      // OpenAI search variants go through the Responses API — web search is
      // a first-class tool there, with each search recorded in the output.
      const res = await client().responses.create({
        model,
        input: prompt,
        tools: [{ type: "web_search" }],
      } as Parameters<ReturnType<typeof client>["responses"]["create"]>[0]);
      const output = (res as unknown as { output?: { type: string; content?: { type: string; annotations?: { type: string; url?: string }[] }[] }[] }).output ?? [];
      const searches = output.filter((i) => i.type === "web_search_call").length;
      const urls = new Set<string>();
      for (const item of output) {
        for (const part of item.content ?? []) {
          for (const ann of part.annotations ?? []) {
            if (ann.type === "url_citation" && ann.url) urls.add(ann.url);
          }
        }
      }
      const r = res as unknown as {
        output_text?: string;
        status?: string;
        incomplete_details?: { reason?: string };
      };
      return {
        text: r.output_text ?? "",
        finishReason:
          r.incomplete_details?.reason ?? (r.status === "completed" ? "stop" : r.status ?? null),
        citations: urls.size > 0 ? [...urls] : null,
        searchCount: searches,
      };
    }
    const c = engine.baseURL ? compatClient(engine) : client();
    const res = await c.chat.completions.create({
      model,
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
      searchCount: null,
    };
  });
}

const EXTRACT_MODEL = process.env.EXTRACT_MODEL ?? "gpt-4o-mini";

/** The fixed coder's id — recorded on every response as provenance. */
export function extractModelId(): string {
  return EXTRACT_MODEL;
}

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
      outcome: {
        type: "string",
        enum: ["pick", "conditional", "no_pick", "clarification"],
      },
      reasons:
        reasonCodes.length > 0
          ? { type: "array", items: { type: "string", enum: reasonCodes } }
          : { type: "array", items: { type: "string" } },
      clarification_requested: { type: "boolean" },
      gives_recommendation: { type: "boolean" },
      includes_prices: { type: "boolean" },
      includes_specs: { type: "boolean" },
      total_recommendations: { type: "integer" },
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
              // Deliberately blind: naming the study's focus brand here made
              // the coder crown it — measured at 28% of picks moving when the
              // focus changed. This pass never learns whose study it is.
              "You are coding one AI assistant answer for a brand study. Be " +
              "literal: code only what the text says.\n\n" +
              "mentions — every company, brand, product, or service named, in " +
              "order of first appearance, including ones named only as " +
              "integrations or adjacent tools. Completeness matters; relevance " +
              "is decided later. ONLY proper-noun names: a generic descriptor " +
              "('a self-hosted server', 'open-source tools', 'spreadsheets') is " +
              "never a mention. A phrase naming several brands ('Trello / " +
              "Asana') is one mention PER brand. A feature fragment without its " +
              "brand ('Issue Boards') is attributed to the full product when " +
              "the answer makes it clear, otherwise omitted.\n" +
              "framing per mention — 'recommended' only when the answer " +
              "endorses it for the reader's situation (a pick, a 'best for " +
              "you', a clear favourable ranking). 'negative' when criticized, " +
              "warned about, or advised against — including a caveat like " +
              "'powerful but too heavy for a small team'. 'mentioned' when it " +
              "is merely listed, compared factually, or named as an " +
              "integration. Being included in a list is NOT an endorsement.\n" +
              "outcome — 'pick' ONLY when the answer commits to ONE option " +
              "overall, for everyone. 'conditional' when it recommends " +
              "different options for different situations or says the choice " +
              "depends ('X for enterprises, Y for startups', 'there is no " +
              "single best'), even if it names a favourite in passing. " +
              "'no_pick' when it explains options without recommending. " +
              "'clarification' when it mainly asks the user a question.\n" +
              "top_pick_brand — the ONE brand crowned as THE choice for " +
              "everyone. MUST be null unless outcome is 'pick'. A conditional " +
              "answer has no top pick, however prominent a brand is.\n" +
              "reasons — which allowed argument codes the answer uses.\n" +
              "clarification_requested — does it ask the user anything?\n" +
              "gives_recommendation — does it recommend at least one option?\n" +
              "includes_prices — true ONLY if an actual figure appears (a " +
              "number with a currency or a per-seat/per-month rate). 'Pricing " +
              "varies' or 'it is expensive' is false.\n" +
              "includes_specs — true ONLY if concrete numeric limits or " +
              "quantities appear (storage, seats, API limits, versions). " +
              "Feature names without numbers are false.\n" +
              "total_recommendations — how many distinct options it actually " +
              "recommends (0 when it recommends none).\n" +
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
      // The focus brand is needed only for the quote fields, so it is asked
      // for in its own call — after the judgement calls are already made.
      let focusQuote: string | null = null;
      let focusInterpretation: string | null = null;
      try {
        const f = await client().chat.completions.create({
          model: EXTRACT_MODEL,
          messages: [
            {
              role: "system",
              content:
                `Read this AI assistant answer and report how it treats ` +
                `"${ctx.targetBrand}". focus_quote: one verbatim sentence ` +
                `(max 200 chars) about that brand, or null if it never ` +
                `appears. focus_interpretation: one plain sentence on how the ` +
                `answer positions it, or null if absent. Quote exactly.`,
            },
            { role: "user", content: responseText },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "focus_read",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  focus_quote: { type: ["string", "null"] },
                  focus_interpretation: { type: ["string", "null"] },
                },
                required: ["focus_quote", "focus_interpretation"],
              },
            },
          },
        });
        const fp = JSON.parse(f.choices[0]?.message?.content ?? "{}");
        focusQuote = fp.focus_quote ?? null;
        focusInterpretation = fp.focus_interpretation ?? null;
      } catch {
        // A failed focus read costs quotes, never the coding itself.
      }
      // Structured outputs guarantee the TYPE, not the semantics: the model
      // occasionally writes the string "null" where it means no pick.
      const pick =
        parsed.top_pick_brand &&
        !/^(null|none|n\/a|no pick|no_pick)$/i.test(parsed.top_pick_brand.trim())
          ? parsed.top_pick_brand
          : null;
      return {
        ...parsed,
        // A conditional or undecided answer crowns nobody, whatever the
        // model volunteered.
        top_pick_brand: parsed.outcome === "pick" ? pick : null,
        mentions: dedupeMentions(parsed.mentions ?? []),
        reasons: [...new Set(parsed.reasons ?? [])],
        focus_quote: focusQuote,
        focus_interpretation: focusInterpretation,
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
