import type { CodingMetric } from "@/lib/types";

/**
 * The one place a human-facing coding question is worded — the evidence
 * drawer and the human coding module both read from here, so a human
 * adjudicating a cell and a coder working an assignment answer the exact
 * same question in the exact same words.
 */
export const METRIC_DEFINITION: Record<CodingMetric, string> = {
  mentioned: "Answers that mention this brand at all.",
  recommended:
    "Answers that endorse this brand for the reader's situation. A crowned brand always counts as recommended.",
  chosen: "Answers that crown this brand as the single pick.",
  negative: "Answers that criticize this brand or warn the reader off it.",
};

export const METRIC_QUESTION: Record<CodingMetric, string> = {
  mentioned: "Is this brand mentioned?",
  recommended: "Is this an endorsement?",
  chosen: "Is this brand crowned as the single pick?",
  negative: "Does this answer criticize the brand?",
};
