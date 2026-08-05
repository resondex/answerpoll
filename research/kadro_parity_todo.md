# Kadro CC Audit parity - the full to-do list

Source: complete digest of the competitor deliverable at
`~/Downloads/Kadro CC Audit/` (4 documents, 62-slide deck, 11 workbooks
read sheet by sheet, master dataset schema, response library anatomy).
Our current study export covers the folder *skeleton*; this list is what
closing the real gap requires. Ordered by leverage within each tier.

Their structural weaknesses stay our edge and are not on this list to
copy: n=1 per cell with no intervals, manual collection that cannot
re-run cheaply, no trend capability. Everything below is about matching
what they genuinely do better.

---

## Tier 1 - coding depth (the biggest real gap)

Their 40-column coded dataset vs our 17. The missing codes power most of
their analyses.

1. **First-pick vs first-named distinction.** They code `top_pick` (the
   card the answer explicitly crowns) separately from `first_product`
   (first in the list). We only have order-of-appearance. Add top-pick
   extraction: which brand does the answer actually RECOMMEND as its
   choice, including "(no pick)" and "(clarification)" outcomes.
2. **Reason codes.** Their 23-code closed taxonomy, coded per response,
   powers the entire "arguments that decide it" layer (+ lift analysis:
   which arguments over-index in wins). Add reason-code extraction with a
   versioned, category-appropriate taxonomy - generated per category at
   setup, frozen per tracker, drift-reviewed.
3. **Response-level codes**: clarification_requested, gives_recommendation,
   includes_prices, includes_specs, word_count (have), total_recommendations,
   negative framing with verbatim quote + interpretation (their Negatives
   sheet). Extend the extraction schema.
4. **Focus-brand quote + interpretation.** Every one of their responses
   carries a verbatim quote about the focus brand and a one-line analyst
   interpretation. High perceived value, cheap to add to extraction.
5. **Product-level (three-layer) coding.** They track network / issuer /
   product as layers with a versioned dictionary (94 products, 34 brands,
   drift review queue). Our brand extraction is one flat layer with alias
   problems ("Euromonitor" vs "Euromonitor International"). Build the
   versioned brand dictionary with alias normalization + human
   approve/alias/reject queue; parent-brand rollups where categories have
   product families.

## Tier 2 - analyses we can compute once Tier 1 codes exist

6. **Prompt grid with picks + badges.** Their scorecard's best artifact:
   rows = prompts, cells = what each view picked, badges WINS / CONTESTED /
   ABSENT. Ours lists rates only. Add modal-pick per prompt (across
   repeats - we can do consensus WITH a stability rate, which beats their
   single-shot cells) and the three-way badge.
7. **Who-wins-instead ranking.** Full first-pick leaderboard (their Top
   Picks sheet): which brand/product wins each prompt, share of all picks.
   We have the data; it needs the top-pick code.
8. **Reason-code lift table.** Argument share in focus-brand wins vs
   overall vs absent - their single most strategic table.
9. **Consensus + stability.** Their consensus = modal pick across 8 views
   (3+ threshold). Ours = modal pick across repeats, with the repeat-share
   as a stability metric. Also powers "contested" detection.
10. **Negatives sheet.** Responses where the focus brand is framed
    negatively, verbatim quote + interpretation.
11. **Position distribution.** Their AmexPosition sheet: #1 / #2 / #3 /
    4+ / mentioned-unranked distribution. We report mean position only;
    add the distribution.

## Tier 3 - collection capabilities (bigger builds)

12. **Multi-assistant coverage.** Their 4 assistants × 2 tiers is the
    center of their pitch. Our provider interface is ready: add Anthropic,
    Gemini, and (via API) a second OpenAI model as distinct "views";
    cross-view consensus analysis follows. API-based = our repeats +
    their breadth. (Tiers are a consumer-UI concept - API models map to
    it imperfectly; we'd offer model-version views instead and say so.)
13. **Grounded provider + source landscape.** Their source analysis
    (domains cited, media-class classification, owned-media lift,
    influence map, archived cited pages) requires citations we don't
    have. Perplexity or OpenAI web-search provider unlocks: source_domains
    per response, domain classification, owned-vs-earned split, own-site
    citation lift. This is their most differentiated analysis - and
    theirs is correlational at n=1; ours would carry intervals.
14. **Google AI Overviews sweep.** Same prompts through a SERP API
    (SerpAPI et al.), AIO presence + brand-in-AIO + consensus-vs-AIO
    comparison. Separate surface, separate run cadence.
15. **Ads capture is NOT replicable via API** (consumer-surface ad
    blocks). Note in methodology as a scope difference, not a to-do.

## Tier 4 - deliverable surface

16. **Summary deck.** Their 62-slide pptx is the executive artifact. Ours
    ships none. Generate a deck (pptx or styled HTML-to-pdf): cover,
    objective, method, exec summary, scorecard, prompt heatmap,
    who-wins-instead, arguments, per-prompt detail pages (grouped
    wins/contested/absent, verbatim quote per view, verdict/tier/lever
    insights), plays with baselines, conclusion.
17. **Excel workbooks with live formulas over embedded data.** Their
    killer trust feature: every aggregate is a COUNTIFS over the embedded
    Data sheet - click a number, trace it. Ours are static CSVs. Build
    xlsx scorecard + analysis workbook (openpyxl/exceljs) with formulas
    over an embedded data sheet, ReadMe sheet per workbook (what it
    answers / why it matters / scope / method), numbered Insights sheets.
18. **Response library upgrades**: YAML front matter (have partially),
    per-response links/sources sections (needs grounded provider),
    "filed three ways" cross-indexing (by prompt / by theme / by model
    once multi-model exists).
19. **Insights tabs everywhere.** Every workbook ends with numbered
    insights; the exec summary reproduces them verbatim "for
    traceability". Generate per-analysis insights (LLM, grounded in the
    computed numbers) and thread them consistently through scorecard,
    workbooks, exec summary, deck.
20. **Four plays / recommendations with baselines.** Their "So what"
    slide format: each recommendation names the measured gap, the play,
    and "Measured by: <metric>, today <value>" so re-measurement scores
    the work. Adopt this exact pattern in our exec summary (we already
    generate recommendations; add the measured-by discipline).

## Tier 5 - methodology & verification rigor to match

21. **Verification gates.** They recompute workbook totals independently,
    assert 668 deck figures against workbook cells, and hash-check
    response texts against a data lock. Add a study-export self-check:
    every number in the exec summary asserted against the dataset before
    the bundle ships.
22. **Data lock + versioning.** Frozen export with dictionary version,
    capture IDs, coding status per response, documented recaptures. Ours:
    stamp study bundles with run IDs + extraction model + battery
    version (partially there), add per-response coding provenance.
23. **Per-column honesty tables.** Their methodology discloses
    verification coverage per platform column (clean-room verified /
    no-signal / flagged). Ours should disclose per-run: extraction
    model, failure counts, any resumed chunks.
24. **Human validation sample.** They line-validated 13.6% of responses.
    Offer a per-study validation report: n responses hand-checked against
    extraction (could be us or the client); publish agreement rate.

## Sequencing recommendation

Phase A (unlocks the most, no new collection): items 1-11 - richer
extraction schema + dictionary + the analyses and grid they power.
Phase B (deliverable surface): 16-17, 19-20 - deck + live-formula
workbooks + threaded insights.
Phase C (new surfaces): 12-14 - multi-assistant, grounded citations, AIO.
Phase D (rigor): 21-24 alongside everything.
