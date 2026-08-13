import type { ExtractionResult } from "./types";

/**
 * Every response column that CODING owns, as opposed to collection (which
 * owns run/prompt/engine/text/citations/search_count).
 *
 * This exists so a response can be re-coded from its stored text without the
 * two write paths drifting apart. Both the store's insert and its re-code
 * build their SQL from the keys of this object rather than from hand-written
 * column lists, so adding a coding field here reaches every writer at once —
 * there is no second list to forget to update.
 */
export interface ResponseCodingColumns {
  coder_model: string | null;
  top_pick_brand: string | null;
  outcome: string | null;
  reason_codes: string | null;
  clarification_requested: number | null;
  gives_recommendation: number | null;
  includes_prices: number | null;
  includes_specs: number | null;
  total_recommendations: number | null;
  focus_quote: string | null;
  focus_interpretation: string | null;
}

/** The single translation from a coder's verdict to stored columns. */
export function codingColumns(
  coding: Omit<ExtractionResult, "mentions"> | null,
  coderModel: string | null
): ResponseCodingColumns {
  const c = coding;
  return {
    coder_model: coderModel,
    top_pick_brand: c?.top_pick_brand ?? null,
    outcome: c?.outcome ?? null,
    reason_codes: c ? c.reasons.join("|") : null,
    clarification_requested: c ? (c.clarification_requested ? 1 : 0) : null,
    gives_recommendation: c ? (c.gives_recommendation ? 1 : 0) : null,
    includes_prices: c ? (c.includes_prices ? 1 : 0) : null,
    includes_specs: c ? (c.includes_specs ? 1 : 0) : null,
    total_recommendations: c?.total_recommendations ?? null,
    focus_quote: c?.focus_quote ?? null,
    focus_interpretation: c?.focus_interpretation ?? null,
  };
}
