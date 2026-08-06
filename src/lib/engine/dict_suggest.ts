import { createHash } from "crypto";
import { openaiClient } from "./providers";
import { store } from "../store";

const SUGGEST_MODEL = process.env.SUGGEST_MODEL ?? "gpt-5-mini";
const CACHE_TTL_MS = 183 * 24 * 3600 * 1000; // ~6 months
// v3: grain rule (feature surfaces/tiers merge into the buyer-level
// offering) + plainest-name anchoring. In the cache key so prompt changes
// bypass stale suggestions.
const SUGGEST_RULES_VERSION = "v3";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          action: { type: "string", enum: ["merge", "approve", "ignore"] },
          merge_into: { type: ["string", "null"] },
          rationale: { type: "string" },
        },
        required: ["name", "action", "merge_into", "rationale"],
      },
    },
  },
  required: ["suggestions"],
} as const;

export interface DictSuggestion {
  entryId: string;
  name: string;
  action: "merge" | "approve" | "ignore";
  mergeIntoId: string | null;
  mergeIntoName: string | null;
  rationale: string;
}

/**
 * AI pre-review of the pending dictionary queue, cache-first. The cache key
 * hashes the exact pending + active sets, so the expensive call runs once
 * per queue state — warmed at run completion, instant when the user opens
 * the Identify view.
 */
export async function getDictionarySuggestions(
  projectId: string,
  category: string
): Promise<DictSuggestion[]> {
  const entries = await store.getDictionary(projectId);
  const pending = entries.filter((e) => e.status === "pending");
  const active = entries.filter((e) => e.status === "active");
  if (pending.length === 0) return [];

  const stateHash = createHash("sha256")
    .update(
      JSON.stringify({
        v: SUGGEST_RULES_VERSION,
        p: pending.map((e) => e.canonical.trim().toLowerCase()).sort(),
        a: active.map((e) => e.canonical.trim().toLowerCase()).sort(),
      })
    )
    .digest("hex");
  const key = `dict_suggest:${projectId}:${stateHash}`;
  const hit = await store.cacheGet(key, CACHE_TTL_MS);
  if (hit) return JSON.parse(hit) as DictSuggestion[];

  const res = await openaiClient().chat.completions.create({
    model: SUGGEST_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You review a brand-dictionary queue for a study of AI answers in " +
          `the category "${category}". For each pending name, propose:\n` +
          "- merge: the name is the SAME offering as one of the active brands " +
          "(alternate name, spelling, sub-surface of the same product). Set " +
          "merge_into to that active brand's canonical name exactly.\n" +
          "- approve: a genuinely distinct brand/product competing in or " +
          "relevant to the category, worth its own row.\n" +
          "- ignore: not a brand in this category (generic terms, one-off " +
          "tangents, tools from unrelated categories).\n" +
          "GRAIN RULE — the analyzable unit is the offering a buyer would " +
          "choose in this category. Feature surfaces, sub-modules, tiers, and " +
          "compound phrasings of the same offering ('X Issues', 'X Boards', " +
          "'X Issues & Boards', 'X CE/EE', 'X Ultimate') all merge into that " +
          "offering. Distinct purchasable products a buyer weighs separately " +
          "(even from the same company) stay separate — Jira and Trello are " +
          "different offerings; GitLab Issues and GitLab Boards are the same " +
          "one. Every suggestion needs a one-line rationale.\n" +
          `Active brands: ${active.map((a) => a.canonical).join(", ")}.\n` +
          "Also treat pending names as potential merge targets for OTHER " +
          "pending names by proposing approve for the best-named variant and " +
          "merge for the rest, with merge_into set to the approved variant. " +
          "The approved variant must be the plainest buyer-facing brand name " +
          "('GitLab', not 'GitLab Issues & Boards'; 'Notion', not 'Notion " +
          "Projects') — feature-phrased variants are always the ones merged.",
      },
      {
        role: "user",
        content: JSON.stringify(pending.map((p) => p.canonical)),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "dispositions", strict: true, schema: SCHEMA },
    },
  });
  const parsed = JSON.parse(
    res.choices[0]?.message?.content ?? '{"suggestions":[]}'
  ) as {
    suggestions: {
      name: string;
      action: "merge" | "approve" | "ignore";
      merge_into: string | null;
      rationale: string;
    }[];
  };

  // Attach entry ids; resolve merge targets to entry ids where possible.
  const byName = new Map(
    entries.map((e) => [e.canonical.trim().toLowerCase(), e])
  );
  const suggestions = parsed.suggestions
    .map((s) => {
      const entry = byName.get(s.name.trim().toLowerCase());
      if (!entry || entry.status !== "pending") return null;
      const target = s.merge_into
        ? byName.get(s.merge_into.trim().toLowerCase())
        : null;
      return {
        entryId: entry.id,
        name: entry.canonical,
        action: s.action,
        mergeIntoId: target?.id ?? null,
        mergeIntoName: target?.canonical ?? s.merge_into,
        rationale: s.rationale,
      };
    })
    .filter((s): s is DictSuggestion => s !== null);
  await store.cacheSet(key, JSON.stringify(suggestions));
  return suggestions;
}
