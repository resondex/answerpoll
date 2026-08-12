/**
 * The metric dictionary — one definition per measure, read by every surface.
 *
 * Labels and denominators used to be written by hand at each call site, which
 * is how the same measure ended up called three things and how two columns
 * came to sit side by side over different bases. Anything user-facing that
 * names a metric should read it from here.
 */

export interface MetricDef {
  /** Short label for columns, chips, and tiles. */
  label: string;
  /** One sentence, plain language — used for hovers. */
  definition: string;
  /** What the rate divides by, named the way a reader would say it. */
  denominator?: string;
}

export const METRICS = {
  mentioned: {
    label: "Mentioned",
    definition:
      "Answers that name the brand at all, in any framing — the machine equivalent of unaided awareness.",
    denominator: "unbranded answers",
  },
  mentionedRate: {
    label: "Mentioned rate",
    definition:
      "Share of unbranded answers that name the brand at all, in any framing.",
    denominator: "unbranded answers",
  },
  recommended: {
    label: "Recommended",
    definition:
      "Answers that endorse the brand or rank it favorably. An answer can recommend several brands; the one it crowns always counts as recommended.",
    denominator: "unbranded answers",
  },
  chosen: {
    label: "Chosen",
    definition:
      "Answers that crown the brand as THE pick — one winner per answer, about endorsement rather than order.",
    denominator: "unbranded answers",
  },
  picks: {
    label: "Picks",
    definition: "The number of answers that crowned this brand.",
  },
  shareOfDecided: {
    label: "Share of decided",
    definition:
      "Of the answers that committed to a pick, the share that crowned this brand.",
    denominator: "answers that committed to a pick",
  },
  firstNamed: {
    label: "First-named",
    definition:
      "Share of answers where this brand is the first one named — order, not endorsement.",
    denominator: "unbranded answers",
  },
  avgPosition: {
    label: "Avg position",
    definition:
      "Average place in the order brands are named, counted only where the brand appears. Only meaningful when the engine ranks rather than lists — see Style.",
  },
  shareOfVoice: {
    label: "Share of voice",
    definition:
      "Of every brand mention across unbranded answers, the share that is this brand's. Within one run it tracks the mentioned rate exactly; its value is comparing crowding across runs and categories.",
    denominator: "all brand mentions",
  },
  brandsPerAnswer: {
    label: "Brands named",
    definition:
      "Average number of distinct brands an answer names — the category's crowding, and the reason share of voice falls even when presence holds.",
  },
  negative: {
    label: "Negative",
    definition:
      "Answers that criticize the brand or advise against it, as a share of the answers that name it.",
    denominator: "answers naming the brand",
  },
  neutral: {
    label: "Neutral",
    definition:
      "Answers that name the brand without endorsing or criticizing it — listed among options, compared factually, or mentioned in passing.",
    denominator: "answers naming the brand",
  },
  searchRate: {
    label: "Searched",
    definition:
      "Share of a search-enabled engine's answers where it actually chose to retrieve before answering.",
    denominator: "that engine's answers",
  },
  answers: {
    label: "Answers",
    definition:
      "Answers to prompts that never name a brand, from the engines in scope — the base every rate above divides by.",
  },
} satisfies Record<string, MetricDef>;

export type MetricId = keyof typeof METRICS;

/** Label plus denominator, ready for a hover. */
export function metricTip(id: MetricId): string {
  const m: MetricDef = METRICS[id];
  return m.denominator ? `${m.definition} (÷ ${m.denominator})` : m.definition;
}

/** The dictionary's label for a metric. */
export function metricLabel(id: MetricId): string {
  return METRICS[id].label;
}
