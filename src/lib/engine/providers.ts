import OpenAI from "openai";
import type { ExtractedMention, ExtractionResult } from "../types";
import { matchKey } from "../brand_key";

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
    ctx: ExtractionContext,
    /** Override the coder for evaluation; production uses EXTRACT_MODEL. */
    model?: string,
    /** Consensus runs the focus read once for both coders. */
    skipFocus?: boolean
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

/** One instruction set, whichever vendor codes — so a coder swap changes
 * the model and nothing else. */
function codingInstructions(ctx: ExtractionContext): string {
  return (
    "You are coding one AI assistant answer for a brand study. Be " +
    "literal: code only what the text says.\n\n" +
    "mentions — every company, brand, product, or service named, in " +
    "order of first appearance, including ones named only as " +
    "integrations or adjacent tools. Completeness matters; relevance " +
    "is decided later. ONLY proper-noun names: a generic descriptor " +
    "('a self-hosted server', 'open-source tools', 'spreadsheets') is " +
    "never a mention. A phrase naming several brands is one mention " +
    "PER brand. Name the PRODUCT, not its parts: a feature, module, " +
    "view, add-on, edition, or pricing tier of a product is coded as " +
    "that product itself, so a product, its board view, and its " +
    "enterprise edition are all the SAME one name, recorded once. A " +
    "bare feature fragment with no brand attached is omitted.\n" +
    "framing per mention — 'recommended' only when the answer " +
    "endorses it for the reader's situation (a pick, a 'best for " +
    "you', a clear favourable ranking). 'negative' when criticized, " +
    "warned about, or advised against — including a caveat like " +
    "'powerful but too heavy for a small team'. 'mentioned' when it " +
    "is merely listed, compared factually, or named as an " +
    "integration. Being included in a list is NOT an endorsement.\n" +
    "outcome — exactly one of four. Decide by what the answer DECIDES, " +
    "never by whether it asks a question at the end.\n" +
    "  THE TEST — apply it literally, do not weigh emphasis or tone: " +
    "could a reader who saw ONLY this answer act on it right now and buy " +
    "ONE named product, WITHOUT first having to decide something about " +
    "their own situation (their size, budget, stack, or scale)?\n" +
    "  YES, one product is named as what to do → 'pick'. This holds even " +
    "when the answer then lists alternatives, adds caveats, or asks a " +
    "follow-up question. A stated default with exceptions after it is a " +
    "pick, and the default is the top_pick.\n" +
    "  NO, the reader must first classify themselves before the answer " +
    "tells them what to buy → 'conditional'. Branches with no stated " +
    "default ('X for enterprises, Y for startups'), or two finalists " +
    "presented as equals, are conditional.\n" +
    "  NO, and the answer names no way forward at all until the reader " +
    "supplies details → 'clarification'. Nothing ranked, no shortlist.\n" +
    "  NO, and it lays out options while recommending none and routing " +
    "to none → 'no_pick'.\n" +
    "  A long or enthusiastic write-up is not by itself a pick: if the " +
    "answer never says what to do, the test fails.\n" +
    "top_pick_brand — the ONE brand that leads. MUST be null unless " +
    "outcome is 'pick', and MUST be a single brand name written exactly " +
    "as the answer writes it — never two names joined by 'or', '+', '/' " +
    "or a parenthetical. If the answer genuinely leads with two, that " +
    "is 'conditional', not a pick.\n" +
    "reasons — which allowed argument codes the answer uses.\n" +
    "clarification_requested — independent of outcome: true whenever " +
    "the answer asks the reader any question, including when it has " +
    "already recommended something.\n" +
    "gives_recommendation — does it recommend at least one option?\n" +
    "includes_prices — true ONLY if an actual figure appears (a " +
    "number with a currency or a per-seat/per-month rate). 'Pricing " +
    "varies' or 'it is expensive' is false.\n" +
    "includes_specs — true ONLY if concrete numeric limits or " +
    "quantities appear (storage, seats, API limits, versions). " +
    "Feature names without numbers are false.\n" +
    "total_recommendations — how many distinct options it actually " +
    "recommends (0 when it recommends none).\n" +
    `Known brands (extract others too): ${ctx.knownBrands.join(", ")}.`
  );
}

/** Claude as the extraction coder: a forced tool call is Anthropic's
 * equivalent of structured outputs. */
async function codeWithClaude(
  responseText: string,
  ctx: ExtractionContext,
  model: string,
  skipFocus?: boolean
): Promise<ExtractionResult> {
  const a = await anthropicClient();
  const schema = extractSchema(ctx.reasonCodes);
  const res = await a.messages.create({
    model,
    max_tokens: 2000,
    // The instructions are identical for every answer in a run, so cache
    // them: first call writes (1.25x input), the other ~419 read at 0.1x.
    // Covers the tools + system prefix. No-op below Anthropic's minimum
    // cacheable length (1,024 tokens on Sonnet), so it can never hurt.
    system: [
      {
        type: "text",
        text: codingInstructions(ctx),
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: "emit_coding",
        description: "Return the coding for this answer.",
        input_schema: schema as unknown as { type: "object" },
      },
    ],
    tool_choice: { type: "tool", name: "emit_coding" },
    messages: [{ role: "user", content: responseText }],
  });
  const block = res.content.find((b) => b.type === "tool_use");
  const parsed = (block && "input" in block ? block.input : {}) as ExtractionResult;
  const pick =
    parsed.top_pick_brand &&
    !/^(null|none|n\/a|no pick|no_pick)$/i.test(parsed.top_pick_brand.trim())
      ? parsed.top_pick_brand
      : null;
  // The focus read stays a separate, later call here too.
  let focusQuote: string | null = null;
  let focusInterpretation: string | null = null;
  try {
    if (skipFocus) throw new Error("skip");
    const f = await a.messages.create({
      model,
      max_tokens: 400,
      system:
        `Read this AI assistant answer and report how it treats "${ctx.targetBrand}".`,
      tools: [
        {
          name: "emit_focus",
          description: "Return the focus read.",
          input_schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              focus_quote: { type: ["string", "null"] },
              focus_interpretation: { type: ["string", "null"] },
            },
            required: ["focus_quote", "focus_interpretation"],
          } as unknown as { type: "object" },
        },
      ],
      tool_choice: { type: "tool", name: "emit_focus" },
      messages: [{ role: "user", content: responseText }],
    });
    const fb = f.content.find((b) => b.type === "tool_use");
    const fp = (fb && "input" in fb ? fb.input : {}) as {
      focus_quote?: string | null;
      focus_interpretation?: string | null;
    };
    focusQuote = fp.focus_quote ?? null;
    focusInterpretation = fp.focus_interpretation ?? null;
  } catch {
    // Quotes are optional; the coding is not.
  }
  return {
    ...parsed,
    top_pick_brand: parsed.outcome === "pick" ? pick : null,
    mentions: dedupeMentions(parsed.mentions ?? []),
    reasons: [...new Set(parsed.reasons ?? [])],
    focus_quote: focusQuote,
    focus_interpretation: focusInterpretation,
  };
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

  async extractCoding(responseText, ctx, model, skipFocus) {
    const coder = model ?? EXTRACT_MODEL;
    if (coder.startsWith("claude")) {
      return codeWithClaude(responseText, ctx, coder, skipFocus);
    }
    return withRetry(async () => {
      const res = await client().chat.completions.create({
        model: coder,
        messages: [
          {
            role: "system",
            content:
              // Deliberately blind: naming the study's focus brand here made
              // the coder crown it — measured at 28% of picks moving when the
              // focus changed. This pass never learns whose study it is.
codingInstructions(ctx),
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
        if (skipFocus) throw new Error("skip");
        const f = await client().chat.completions.create({
          model: coder,
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

/**
 * Consensus coding: two independent coders, then adjudication where they
 * disagree.
 *
 * No single cheap model codes these answers correctly every time — measured
 * field accuracy sat in the 70-90% range for both candidates, with different
 * strengths (Claude reads outcome and mentions better; GPT reads the crown
 * and numeric flags better). Running both and escalating disagreements to a
 * stronger judge turns two imperfect coders into a pipeline whose residual
 * error is both smaller and *visible*: every adjudication is recorded, so
 * the study can report how often its coders disagreed instead of pretending
 * they never do.
 */
export const CODER_A = process.env.EXTRACT_MODEL ?? "gpt-4o-mini";
export const CODER_B = process.env.EXTRACT_MODEL_B ?? "claude-haiku-4-5-20251001";
const ADJUDICATOR = process.env.EXTRACT_JUDGE ?? "claude-sonnet-5";

export interface ConsensusResult extends ExtractionResult {
  /** Provenance for the honesty table: who coded, and who settled ties. */
  coderProvenance: string;
  /** Judgement fields the two coders disagreed on, before adjudication. */
  disagreements: string[];
}

/**
 * A crown must name ONE brand. Coders occasionally emit a compound —
 * "GitHub Issues + Projects (or Linear)" — which matches no dictionary entry
 * and so vanishes from every brand metric instead of failing loudly.
 *
 * A name that the answer's own mentions (or the known brand list) contain is
 * kept whole, so legitimately parenthesised names like "GitHub Projects (v2)"
 * survive. Otherwise the compound is split and the first fragment naming a
 * real brand wins — that is the leading brand the answer actually crowned.
 */
function singleBrand(
  raw: string | null,
  mentions: ExtractedMention[],
  known: string[]
): string | null {
  const clean = raw?.trim();
  if (!clean) return null;
  const pool = [...mentions.map((m) => m.brand), ...known];
  // A trailing qualifier is part of one name ("Acme Projects (v2)"), not a
  // join, so drop it before deciding whether two names are being welded
  // together.
  const base = clean.replace(/\s*\([^)]*\)\s*$/, "").trim() || clean;
  const JOIN = /\s*(?:\+|\/|,|\bor\b)\s*/i;
  if (!JOIN.test(base)) {
    return pool.find((p) => matchKey(p) === matchKey(base)) ?? base;
  }
  // Compound. The whole-string match is NOT an escape hatch here: once a
  // compound name is itself extracted as a mention, matching against mentions
  // would wave it straight through, which is how "GitHub Issues + Projects"
  // survived the first version of this guard.
  const parts = base.split(JOIN).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const hit = pool.find((p) => matchKey(p) === matchKey(part));
    if (hit) return hit;
  }
  // No fragment names a brand the answer actually discussed, so this is not a
  // crown at all ("PR/task-list-first"). Better no winner than a fake one.
  return null;
}

/**
 * A coder that fails on one answer is noise; a coder that fails on most of
 * them is an outage, and quietly degrading to solo coding across a whole run
 * silently halves the methodology. Track the rate and stop the run once it is
 * unambiguous, so the failure is loud instead of buried in a provenance
 * string.
 */
export class CoderUnavailableError extends Error {}
const secondCoder = { attempts: 0, failures: 0, lastError: "" };
const OUTAGE_MIN_ATTEMPTS = 20;
const OUTAGE_FAILURE_RATE = 0.5;

function noteSecondCoder(ok: boolean, err?: unknown): void {
  secondCoder.attempts++;
  if (ok) {
    // A success proves the vendor is reachable; forget earlier blips so a
    // long healthy run cannot accumulate its way into a false alarm.
    secondCoder.failures = 0;
    return;
  }
  secondCoder.failures++;
  secondCoder.lastError = err instanceof Error ? err.message : String(err);
  console.error(
    `second coder (${CODER_B}) failed — ${secondCoder.failures} consecutive:`,
    secondCoder.lastError
  );
}

function assertSecondCoderHealthy(): void {
  if (
    secondCoder.attempts >= OUTAGE_MIN_ATTEMPTS &&
    secondCoder.failures / secondCoder.attempts > OUTAGE_FAILURE_RATE
  ) {
    throw new CoderUnavailableError(
      `consensus coding is degraded: ${CODER_B} failed on ` +
        `${secondCoder.failures} of ${secondCoder.attempts} answers. ` +
        `Last error: ${secondCoder.lastError}`
    );
  }
}

/**
 * When EXTRACT_SOLO names a model, that one model codes each answer alone
 * instead of the two-coder-plus-adjudicator consensus. Production runs solo
 * claude-sonnet-5 as of 2026-08-13 (Tyler's call, pending the framing
 * hand-labels); unset the variable to return to consensus. The focus read
 * stays a SEPARATE call regardless — folding it in would name the brand
 * under study in the same prompt that decides the crown, which is the exact
 * contamination the blind judgement pass exists to prevent.
 */
const SOLO_CODER = process.env.EXTRACT_SOLO ?? "";

/**
 * Coding provenance derived from the data itself, for exports. Reading the
 * per-answer coder_model column means the description can never disagree
 * with what actually coded the run — switching EXTRACT_SOLO changes future
 * runs' provenance and this summary follows automatically.
 */
export function summarizeCoderProvenance(
  coderModels: (string | null)[]
): string {
  const counts = new Map<string, number>();
  for (const m of coderModels) {
    const key = m ?? "unrecorded";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (parts.length === 0) return "no coded answers";
  if (parts.length === 1) {
    return `${parts[0][0]} — all ${parts[0][1]} answers`;
  }
  return parts
    .map(([m, n]) => `${m} (${n} answer${n === 1 ? "" : "s"})`)
    .join("; ");
}

export async function extractCodingConsensus(
  responseText: string,
  ctx: ExtractionContext
): Promise<ConsensusResult> {
  const provider = getProvider();
  if (SOLO_CODER) {
    const [only, focus] = await Promise.all([
      provider.extractCoding(responseText, ctx, SOLO_CODER, true),
      readFocus(responseText, ctx).catch(() => ({
        focus_quote: null,
        focus_interpretation: null,
      })),
    ]);
    return {
      ...only,
      top_pick_brand: singleBrand(
        only.outcome === "pick" ? only.top_pick_brand : null,
        only.mentions,
        ctx.knownBrands
      ),
      focus_quote: focus.focus_quote,
      focus_interpretation: focus.focus_interpretation,
      coderProvenance: `${SOLO_CODER} (solo)`,
      disagreements: [],
    };
  }
  // Three calls in flight at once rather than four in sequence: each coder
  // used to make its own focus read, so the same quote was extracted twice
  // and every answer paid for two serial round trips it did not need.
  const [a, b, focus] = await Promise.all([
    provider.extractCoding(responseText, ctx, CODER_A, true),
    provider
      .extractCoding(responseText, ctx, CODER_B, true)
      .then((r) => {
        noteSecondCoder(true);
        return r;
      })
      .catch((err) => {
        noteSecondCoder(false, err);
        return null;
      }),
    readFocus(responseText, ctx).catch(() => ({
      focus_quote: null,
      focus_interpretation: null,
    })),
  ]);
  if (!b) {
    // Throws once the failures stop looking like bad luck.
    assertSecondCoderHealthy();
    return {
      ...a,
      focus_quote: focus.focus_quote,
      focus_interpretation: focus.focus_interpretation,
      coderProvenance: `${CODER_A} (solo)`,
      disagreements: [],
    };
  }
  const sameBrand = (x: string | null, y: string | null) =>
    (x ?? "").trim().toLowerCase() === (y ?? "").trim().toLowerCase();
  const disagreements: string[] = [];
  if (a.outcome !== b.outcome) disagreements.push("outcome");
  if (!sameBrand(a.top_pick_brand, b.top_pick_brand)) disagreements.push("top_pick_brand");

  // Union the mentions: a brand either coder saw is a brand the answer named,
  // and recall was the weaker side of both coders. Framing ties break toward
  // the stronger reading (negative > recommended > mentioned) only when the
  // same brand is framed differently — a criticism seen by one coder and
  // missed by the other is still a criticism.
  const rank: Record<string, number> = { negative: 3, recommended: 2, mentioned: 1 };
  const merged = new Map<string, ExtractedMention>();
  for (const m of [...a.mentions, ...b.mentions]) {
    const key = m.brand.trim().toLowerCase();
    const prev = merged.get(key);
    if (!prev || rank[m.framing] > rank[prev.framing]) merged.set(key, m);
  }

  let outcome = a.outcome;
  let topPick = a.top_pick_brand;
  let provenance = `${CODER_A}+${CODER_B} (agreed)`;
  if (disagreements.length > 0) {
    const verdict = await adjudicate(responseText, a, b).catch(() => null);
    if (verdict) {
      outcome = verdict.outcome;
      topPick = verdict.outcome === "pick" ? verdict.top_pick_brand : null;
      provenance = `${CODER_A}+${CODER_B} → ${ADJUDICATOR}`;
    } else {
      // Judge unreachable: keep the more conservative reading rather than
      // inventing a winner.
      outcome = a.outcome === "pick" && b.outcome === "pick" ? "pick" : "conditional";
      topPick = outcome === "pick" ? a.top_pick_brand : null;
      provenance = `${CODER_A}+${CODER_B} (unresolved)`;
    }
  }
  const mentions = [...merged.values()];
  return {
    ...a,
    outcome,
    top_pick_brand: singleBrand(topPick, mentions, ctx.knownBrands),
    mentions,
    // Numeric flags: agree, or take the affirmative only when both saw it.
    includes_prices: a.includes_prices && b.includes_prices,
    includes_specs: a.includes_specs && b.includes_specs,
    total_recommendations: Math.round(
      (a.total_recommendations + b.total_recommendations) / 2
    ),
    reasons: [...new Set([...(a.reasons ?? []), ...(b.reasons ?? [])])],
    focus_quote: focus.focus_quote,
    focus_interpretation: focus.focus_interpretation,
    coderProvenance: provenance,
    disagreements,
  };
}

/**
 * One focus read per answer, shared by both coders.
 *
 * Runs on Anthropic rather than the OpenAI coder: this is quotation, not
 * judgement — it never touches outcome, crown, mentions, or framing — and
 * OpenAI's tokens-per-minute bucket is the run's binding constraint, while
 * Anthropic's is thirty times larger.
 */
const FOCUS_MODEL = process.env.EXTRACT_FOCUS_MODEL ?? CODER_B;

async function readFocus(
  responseText: string,
  ctx: ExtractionContext
): Promise<{ focus_quote: string | null; focus_interpretation: string | null }> {
  if (FOCUS_MODEL.startsWith("claude")) {
    const a = await anthropicClient();
    const res = await a.messages.create({
      model: FOCUS_MODEL,
      max_tokens: 400,
      system:
        `Read this AI assistant answer and report how it treats ` +
        `"${ctx.targetBrand}". Quote exactly; invent nothing.`,
      tools: [
        {
          name: "emit_focus",
          description: "Return the focus read.",
          input_schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              focus_quote: {
                type: ["string", "null"],
                description:
                  "One verbatim sentence (max 200 chars) about the brand, or null if it never appears.",
              },
              focus_interpretation: {
                type: ["string", "null"],
                description:
                  "One plain sentence on how the answer positions the brand, or null if absent.",
              },
            },
            required: ["focus_quote", "focus_interpretation"],
          } as unknown as { type: "object" },
        },
      ],
      tool_choice: { type: "tool", name: "emit_focus" },
      messages: [{ role: "user", content: responseText }],
    });
    const block = res.content.find((b) => b.type === "tool_use");
    const fp = (block && "input" in block ? block.input : {}) as {
      focus_quote?: string | null;
      focus_interpretation?: string | null;
    };
    return {
      focus_quote: fp.focus_quote ?? null,
      focus_interpretation: fp.focus_interpretation ?? null,
    };
  }
  const res = await client().chat.completions.create({
    model: FOCUS_MODEL,
    messages: [
      {
        role: "system",
        content:
          `Read this AI assistant answer and report how it treats ` +
          `"${ctx.targetBrand}". focus_quote: one verbatim sentence (max 200 ` +
          `chars) about that brand, or null if it never appears. ` +
          `focus_interpretation: one plain sentence on how the answer ` +
          `positions it, or null if absent. Quote exactly.`,
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
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  return {
    focus_quote: parsed.focus_quote ?? null,
    focus_interpretation: parsed.focus_interpretation ?? null,
  };
}

async function adjudicate(
  responseText: string,
  a: ExtractionResult,
  b: ExtractionResult
): Promise<{ outcome: ExtractionResult["outcome"]; top_pick_brand: string | null }> {
  const anthropic = await anthropicClient();
  const res = await anthropic.messages.create({
    model: ADJUDICATOR,
    max_tokens: 500,
    system:
      "Two coders disagree about one AI answer. Decide from the text alone. " +
      "outcome — apply this test literally, do not weigh emphasis or " +
      "tone: could a reader who saw ONLY this answer act on it right now " +
      "and buy ONE named product, without first having to decide " +
      "something about their own size, budget, stack, or scale? YES, one " +
      "product is named as what to do → 'pick', even if alternatives, " +
      "caveats, or a follow-up question follow it; a stated default with " +
      "exceptions after it is a pick. NO, the reader must classify " +
      "themselves first → 'conditional'. NO, and no way forward is named " +
      "at all until they supply details → 'clarification'. NO, and it " +
      "recommends none and routes to none → 'no_pick'. A long or " +
      "enthusiastic write-up is not by itself a pick. top_pick_brand is " +
      "null unless outcome is 'pick', and must be ONE brand name — never " +
      "two joined by 'or', '+', '/' or a parenthetical.",
    tools: [
      {
        name: "settle",
        description: "Settle the disagreement.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            outcome: {
              type: "string",
              enum: ["pick", "conditional", "no_pick", "clarification"],
            },
            top_pick_brand: { type: ["string", "null"] },
          },
          required: ["outcome", "top_pick_brand"],
        } as unknown as { type: "object" },
      },
    ],
    tool_choice: { type: "tool", name: "settle" },
    messages: [
      {
        role: "user",
        content:
          `ANSWER:\n${responseText.slice(0, 8000)}\n\n` +
          `CODER A said: outcome=${a.outcome}, top_pick=${a.top_pick_brand}\n` +
          `CODER B said: outcome=${b.outcome}, top_pick=${b.top_pick_brand}`,
      },
    ],
  });
  const block = res.content.find((x) => x.type === "tool_use");
  return (block && "input" in block ? block.input : {}) as {
    outcome: ExtractionResult["outcome"];
    top_pick_brand: string | null;
  };
}

function dedupeMentions(mentions: ExtractedMention[]): ExtractedMention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const key = m.brand.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
