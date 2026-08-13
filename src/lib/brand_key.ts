/**
 * The key two spellings must share to be the same brand. Case, punctuation,
 * spacing, accents, and symbols are noise an assistant varies freely — "Jira",
 * "jira.", "Click-Up", "ClickUp" and "Café" / "Cafe" are one brand each, and
 * matching on the raw lowercase string fragmented them into several.
 *
 * NFD (not NFKD) on purpose: NFKD expands "™" to the letters "TM", which would
 * fuse into the key instead of being dropped as a symbol.
 *
 * Deliberately conservative — it never strips words, so "Jira" and "Jira
 * Software" stay distinct. Merging those is a judgement call that belongs to
 * the dictionary's aliases, not to normalization.
 *
 * Lives in its own module because both the coder (providers) and the read-time
 * canonicalizer (metrics) need it, and metrics already imports from providers.
 */
export function matchKey(raw: string): string {
  const key = raw
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  // A name made entirely of symbols would collapse to nothing and merge with
  // every other such name; keep it distinguishable instead.
  return key || raw.trim().toLowerCase();
}
