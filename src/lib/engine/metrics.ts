import { store } from "../store";
import { matchKey } from "../brand_key";
import { engineMode } from "./providers";
import type {
  AnswerLabel,
  BrandStats,
  DictionaryEntry,
  Framing,
  LabelMetric,
  MentionRow,
  Project,
  Prompt,
  PromptBadge,
  PromptStats,
  PromptTheme,
  ResponseRow,
  Run,
  RunMetrics,
  ThemeStats,
} from "../types";

const THEME_ORDER: PromptTheme[] = [
  "discovery",
  "recommendation",
  "comparison",
  "use_case",
  "branded",
];

function rate(rows: ResponseRow[], test: (r: ResponseRow) => boolean): number {
  return rows.length > 0 ? rows.filter(test).length / rows.length : 0;
}

/** Wilson 95% score interval for a binomial proportion. */
export function wilson(k: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * Read-time canonicalizer built from the project dictionary: raw extracted
 * names collapse onto canonical brands (aliases merged), so dictionary edits
 * retroactively clean every run without re-coding.
 */
/**
 * Brand roles from the dictionary — the single source of truth for who is a
 * tracked competitor. Explicit entry roles win; entries that predate the
 * role column fall back to the setup-time competitor list, so nothing
 * changes until the user says so. Returns a lookup by fossilized norm.
 */
export function dictionaryRoles(
  entries: DictionaryEntry[],
  project: Project,
  canon: ReturnType<typeof buildCanonicalizer>
): (raw: string) => "target" | "competitor" | "emerged" {
  const targetNorm = canon.norm(project.brand);
  const legacy = new Set(project.competitors.map((c) => canon.norm(c)));
  const byNorm = new Map<string, "competitor" | "emerged">();
  for (const e of entries) {
    if (e.status !== "active" || !e.role) continue;
    // Key through the canonicalizer so these agree with the lookup below —
    // raw lowercase and the fossilized identity are different key spaces.
    byNorm.set(canon.norm(e.canonical), e.role);
  }
  return (raw: string) => {
    const norm = canon.norm(raw);
    if (norm === targetNorm) return "target";
    return byNorm.get(norm) ?? (legacy.has(norm) ? "competitor" : "emerged");
  };
}

export { matchKey };

export function buildCanonicalizer(entries: DictionaryEntry[]) {
  // Match strings (canonical + aliases) are fossilized and drive identity;
  // display_name is a renameable label that never affects matching, so
  // scheduled runs stay comparable across renames.
  const aliasMap = new Map<string, { canonical: string; display: string }>();
  const rejectedSet = new Set<string>();
  for (const e of entries) {
    if (e.status === "active") {
      const value = {
        canonical: e.canonical,
        display: e.display_name ?? e.canonical,
      };
      aliasMap.set(matchKey(e.canonical), value);
      for (const a of e.aliases) aliasMap.set(matchKey(a), value);
    } else if (e.status === "rejected") {
      rejectedSet.add(matchKey(e.canonical));
      for (const a of e.aliases) rejectedSet.add(matchKey(a));
    }
  }
  return {
    /** User-facing label for a raw extracted name. */
    canonical(raw: string): string {
      return aliasMap.get(matchKey(raw))?.display ?? raw.trim();
    },
    /** Stable identity key — from the fossilized canonical, never the label. */
    norm(raw: string): string {
      const hit = aliasMap.get(matchKey(raw));
      return matchKey(hit?.canonical ?? raw);
    },
    /**
     * Rejected = reviewed and ruled out of the category. Suppressed from
     * displayed metrics and analysis tables; the raw and master data keep
     * everything. An active mapping always wins (merged names live on as
     * aliases of their target, not as rejections).
     */
    isRejected(raw: string): boolean {
      const key = matchKey(raw);
      return !aliasMap.has(key) && rejectedSet.has(key);
    },
  };
}

export interface SliceOpts {
  mode?: "instinct" | "search";
  /** Explicit engine scope: only these engines' answers are in play, and
   * they become the panel for this slice (a selection may include bonus
   * engines the project's core panel excludes). */
  engines?: string[];
  /** Brand lens: compute every cut with this brand as the focus instead
   * of the client — the workbook's Focus dropdown, server-side. Quotes
   * and verified prose stay client-coded and are nulled under a lens. */
  focus?: string;
}

/** Everything a run's metrics derive from — loaded once, computed many. */
export interface RunData {
  run: Run;
  project: Project;
  responses: ResponseRow[];
  mentions: MentionRow[];
  prompts: Prompt[];
  dictionary: DictionaryEntry[];
  /** Human verdicts from the evidence drawer. Only consulted when the
   * project has human override switched on. */
  labels: AnswerLabel[];
}

/**
 * Human labels as a lookup, or null when the project has override off — in
 * which case labels are recorded and scored but never move a figure.
 *
 * Returns undefined for an unlabelled cell, so a caller can tell "reviewed
 * and rejected" from "never reviewed" and keep the coder's value for the
 * latter. That distinction is what makes an overridden figure a defensible
 * blend rather than a silent edit.
 */
function buildOverride(
  labels: AnswerLabel[],
  project: Project
): ((responseId: string, metric: LabelMetric, norm: string) => boolean | undefined) | null {
  if (!project.human_override) return null;
  const map = new Map<string, boolean>();
  for (const l of labels) {
    map.set(`${l.response_id}|${l.metric}|${l.brand_norm}`, l.verdict === 1);
  }
  return (responseId, metric, norm) => map.get(`${responseId}|${metric}|${norm}`);
}

/** Apply verdicts to one metric's answer set; returns how many it changed. */
function applyOverride(
  ids: Set<string>,
  candidates: string[],
  metric: LabelMetric,
  norm: string,
  lookup: ReturnType<typeof buildOverride>
): number {
  if (!lookup) return 0;
  let changed = 0;
  for (const id of candidates) {
    const verdict = lookup(id, metric, norm);
    if (verdict === undefined) continue;
    if (verdict && !ids.has(id)) { ids.add(id); changed++; }
    else if (!verdict && ids.has(id)) { ids.delete(id); changed++; }
  }
  return changed;
}

export async function loadRunData(runId: string): Promise<RunData | null> {
  const run = await store.getRun(runId);
  if (!run) return null;
  const [projectMaybe, responses, mentions] = await Promise.all([
    store.getProject(run.project_id),
    store.listResponses(runId),
    store.listMentionsForRun(runId),
  ]);
  const project = projectMaybe!;
  const [prompts, dictionary, labels] = await Promise.all([
    store.listPrompts(project.id),
    store.getDictionary(project.id),
    store.listLabelsForRun(runId),
  ]);
  return { run, project, responses, mentions, prompts, dictionary, labels };
}

export async function computeRunMetrics(
  runId: string,
  opts?: SliceOpts
): Promise<RunMetrics | null> {
  const data = await loadRunData(runId);
  return data ? computeRunMetricsFromData(data, opts) : null;
}

/** The pure computation: N slices of one run share a single load. */
export function computeRunMetricsFromData(
  data: RunData,
  opts?: SliceOpts
): RunMetrics {
  const { run, project, responses: allResponses, mentions, prompts, dictionary } = data;
  const override = buildOverride(data.labels ?? [], project);
  const runId = run.id;
  // Optional instrument filter: every cut below recomputes over one mode's
  // answers only. Mentions need no prefilter — every downstream loop checks
  // membership in a response-id set derived from `responses`.
  const engineScope =
    opts?.engines && opts.engines.length > 0 ? new Set(opts.engines) : null;
  const responses = allResponses.filter((r) => {
    const model = r.model || run.model;
    if (opts?.mode && engineMode(model) !== opts.mode) return false;
    if (engineScope && !engineScope.has(model)) return false;
    return true;
  });
  const canon = buildCanonicalizer(dictionary);
  // A lens naming the client is just the home state. "parent:X" makes the
  // parent company the focus: any member brand counts as the target.
  const parentFocus = opts?.focus?.startsWith("parent:")
    ? opts.focus.slice(7).trim()
    : undefined;
  const focus =
    parentFocus ||
    (opts?.focus && canon.norm(opts.focus) !== canon.norm(project.brand)
      ? opts.focus.trim()
      : undefined);

  const promptById = new Map(prompts.map((p) => [p.id, p]));
  const brandedPromptIds = new Set(
    prompts.filter((p) => p.theme === "branded").map((p) => p.id)
  );
  // The core engine panel: the project's declared set, falling back to the
  // run's own engines for pre-engine-set projects. Headline rates compute
  // over core engines only — engines beyond the core are bonus views, shown
  // per-engine but excluded from pooled numbers so the trend stays a trend.
  const sampledModels = [
    ...new Set(responses.map((r) => r.model).filter(Boolean)),
  ];
  // An explicit engine scope IS the panel for that slice; otherwise the
  // project's declared core panel decides what pools into headline rates.
  const coreModels = engineScope
    ? sampledModels
    : project.engine_set.length > 0
      ? project.engine_set.filter(
          (m) => sampledModels.includes(m) || sampledModels.length === 0
        )
      : sampledModels;
  const coreSet = new Set(coreModels.length > 0 ? coreModels : sampledModels);
  const bonusModels = sampledModels.filter((m) => !coreSet.has(m));
  const inCore = (r: ResponseRow) =>
    !r.model || coreSet.size === 0 || coreSet.has(r.model);

  // Headline rates use unbranded prompts only — asking about the brand by
  // name trivially guarantees a mention.
  const unbranded = responses.filter(
    (r) => !brandedPromptIds.has(r.prompt_id) && inCore(r)
  );
  const unbrandedIds = new Set(unbranded.map((r) => r.id));

  // The target identity is a SET of norms: one brand normally, every member
  // brand under a parent lens. isT() is the only test used downstream.
  const targetNorms = parentFocus
    ? new Set(
        dictionary
          .filter(
            (e) =>
              e.status === "active" &&
              (e.parent ?? e.display_name ?? e.canonical) === parentFocus
          )
          .map((e) => e.canonical.trim().toLowerCase())
      )
    : new Set([canon.norm(focus ?? project.brand)]);
  const isT = (norm: string) => targetNorms.has(norm);
  const roleOf = dictionaryRoles(dictionary, project, canon);

  // --- per-brand stats over unbranded responses (canonicalized) ---
  const byBrand = new Map<string, { display: string; rows: MentionRow[] }>();
  const mentionNorm = new Map<string, string>(); // mention id -> canonical norm
  for (const m of mentions) {
    const norm = canon.norm(m.brand);
    mentionNorm.set(m.id, norm);
    if (!unbrandedIds.has(m.response_id)) continue;
    if (canon.isRejected(m.brand)) continue; // reviewed out of the category
    const entry =
      byBrand.get(norm) ?? { display: canon.canonical(m.brand), rows: [] };
    entry.rows.push(m);
    byBrand.set(norm, entry);
  }
  // Share of voice divides by every brand's distinct-answer count, so the
  // numerator and denominator are in the same unit.
  const totalMentions = [...byBrand.values()].reduce(
    (acc, e) => acc + new Set(e.rows.map((r) => r.response_id)).size,
    0
  );

  const brands: BrandStats[] = [...byBrand.entries()].map(([norm, entry]) => {
    // Aliases may merge several mentions of one brand within an answer;
    // count distinct answers, and take the best (lowest) rank per answer.
    const perResponse = new Map<string, MentionRow>();
    for (const row of entry.rows) {
      const prev = perResponse.get(row.response_id);
      if (!prev || row.rank < prev.rank) perResponse.set(row.response_id, row);
    }
    const rows = [...perResponse.values()];
    const n = unbranded.length;
    const framing: Record<Framing, number> = {
      recommended: 0,
      mentioned: 0,
      negative: 0,
    };
    for (const row of rows) framing[row.framing as Framing]++;
    // Funnel middle stage. Crowning a brand is the strongest endorsement
    // there is, so a chosen answer counts as recommended even when the
    // coder framed the mention neutrally — without this the funnel can
    // invert (stage 3 wider than stage 2).
    const chosenIds = new Set(
      unbranded
        .filter((r) => r.top_pick_brand && canon.norm(r.top_pick_brand) === norm)
        .map((r) => r.id)
    );
    const recommendedIds = new Set(chosenIds);
    for (const row of rows) {
      if (row.framing === "recommended") recommendedIds.add(row.response_id);
    }
    const mentionedIds = new Set(rows.map((r) => r.response_id));
    // Human verdicts, where the project has override on. Every answer in the
    // run is a candidate: a label can add an answer the coder missed as
    // readily as it can remove one the coder wrongly counted.
    const candidates = unbranded.map((r) => r.id);
    const changed =
      applyOverride(mentionedIds, candidates, "mentioned", norm, override) +
      applyOverride(recommendedIds, candidates, "recommended", norm, override) +
      applyOverride(chosenIds, candidates, "chosen", norm, override);
    const k = mentionedIds.size;
    const ci = wilson(k, n);
    return {
      brand: isT(norm) && !focus ? project.brand : entry.display,
      isTarget: isT(norm),
      isCompetitor: roleOf(norm) === "competitor",
      mentionCount: k,
      mentionRate: n > 0 ? k / n : 0,
      overrides: changed,
      recommendedCount: recommendedIds.size,
      recommendedRate: n > 0 ? recommendedIds.size / n : 0,
      chosenCount: chosenIds.size,
      chosenRate: n > 0 ? chosenIds.size / n : 0,
      ciLow: ci.low,
      ciHigh: ci.high,
      // Average position stays on real mention rows — a label says whether an
      // answer counts, not where in the list the brand appeared.
      avgRank:
        rows.length > 0
          ? rows.reduce((acc, r) => acc + r.rank, 0) / rows.length
          : null,
      // Distinct answers, matching the unit the mentioned rate uses — raw
      // mention rows double-count a brand named under two aliases.
      shareOfVoice: totalMentions > 0 ? k / totalMentions : 0,
      framing,
    };
  });
  brands.sort((a, b) => b.mentionRate - a.mentionRate);

  // Parent lens: the target entry must be the ROLLUP — distinct answers
  // naming any member, best rank per answer — not the largest member. The
  // member rows stay, demoted to non-target.
  if (parentFocus) {
    const per = new Map<string, MentionRow>();
    let mentionTotal = 0;
    for (const m of mentions) {
      if (!unbrandedIds.has(m.response_id)) continue;
      if (!isT(canon.norm(m.brand))) continue;
      mentionTotal++;
      const prev = per.get(m.response_id);
      if (!prev || m.rank < prev.rank) per.set(m.response_id, m);
    }
    const rows = [...per.values()];
    const chosenIds = new Set(
      unbranded
        .filter((r) => r.top_pick_brand && isT(canon.norm(r.top_pick_brand)))
        .map((r) => r.id)
    );
    const recIds = new Set(chosenIds);
    for (const row of rows) {
      if (row.framing === "recommended") recIds.add(row.response_id);
    }
    const ci = wilson(rows.length, unbranded.length);
    const framing: Record<Framing, number> = {
      recommended: 0,
      mentioned: 0,
      negative: 0,
    };
    for (const row of rows) framing[row.framing as Framing]++;
    for (const b of brands) b.isTarget = false;
    brands.unshift({
      brand: parentFocus,
      isTarget: true,
      isCompetitor: false,
      mentionCount: rows.length,
      mentionRate: unbranded.length > 0 ? rows.length / unbranded.length : 0,
      recommendedCount: recIds.size,
      recommendedRate: unbranded.length > 0 ? recIds.size / unbranded.length : 0,
      chosenCount: chosenIds.size,
      chosenRate: unbranded.length > 0 ? chosenIds.size / unbranded.length : 0,
      ciLow: ci.low,
      ciHigh: ci.high,
      avgRank:
        rows.length > 0
          ? rows.reduce((a, r) => a + r.rank, 0) / rows.length
          : null,
      shareOfVoice: totalMentions > 0 ? mentionTotal / totalMentions : 0,
      framing,
    });
  }

  // --- per-engine breakdown: the same headline questions, engine by engine ---
  const allUnbranded = responses.filter(
    (r) => !brandedPromptIds.has(r.prompt_id)
  );
  const engineIds = [
    ...new Set(allUnbranded.map((r) => r.model).filter(Boolean)),
  ].sort();
  const engines: RunMetrics["engines"] =
    engineIds.length > 0
      ? engineIds.map((model) => {
          const rows = allUnbranded.filter((r) => r.model === model);
          const ids = new Set(rows.map((r) => r.id));
          // Best (lowest) target rank per answer, from canonicalized mentions.
          const bestRank = new Map<string, number>();
          for (const m of mentions) {
            if (!ids.has(m.response_id)) continue;
            if (!isT(canon.norm(m.brand))) continue;
            const prev = bestRank.get(m.response_id);
            if (prev === undefined || m.rank < prev) {
              bestRank.set(m.response_id, m.rank);
            }
          }
          const named = bestRank.size;
          const picks = rows.filter(
            (r) => r.top_pick_brand && isT(canon.norm(r.top_pick_brand))
          ).length;
          const ci = wilson(named, rows.length);
          const ranks = [...bestRank.values()];
          const reported = rows.filter((r) => r.search_count !== null);
          return {
            model,
            mode: engineMode(model),
            answers: rows.length,
            named,
            namedRate: rows.length > 0 ? named / rows.length : 0,
            ciLow: ci.low,
            ciHigh: ci.high,
            picks,
            pickRate: rows.length > 0 ? picks / rows.length : 0,
            avgPosition:
              ranks.length > 0
                ? ranks.reduce((a, b) => a + b, 0) / ranks.length
                : null,
            searchRate:
              reported.length > 0
                ? reported.filter((r) => (r.search_count ?? 0) > 0).length /
                  reported.length
                : null,
            citedAnswers: rows.filter((r) => r.citations && r.citations.length > 0).length,
            outcomes: {
              pick: rows.filter((r) => r.outcome === "pick").length,
              conditional: rows.filter((r) => r.outcome === "conditional").length,
              no_pick: rows.filter((r) => r.outcome === "no_pick").length,
              clarification: rows.filter((r) => r.outcome === "clarification")
                .length,
            },
            style: {
              avgBrands:
                rows.length > 0
                  ? Number(
                      (
                        rows.reduce(
                          (a, r) =>
                            a +
                            new Set(
                              mentions
                                .filter((m) => m.response_id === r.id)
                                .map((m) => canon.norm(m.brand))
                            ).size,
                          0
                        ) / rows.length
                      ).toFixed(1)
                    )
                  : 0,
              avgWords:
                rows.length > 0
                  ? Math.round(
                      rows.reduce(
                        (a, r) => a + r.text.split(/\s+/).length,
                        0
                      ) / rows.length
                    )
                  : 0,
              recRate: rate(rows, (r) => r.gives_recommendation === 1),
              priceRate: rate(rows, (r) => r.includes_prices === 1),
              specRate: rate(rows, (r) => r.includes_specs === 1),
              clarRate: rate(rows, (r) => r.clarification_requested === 1),
              avgOptions:
                rows.length > 0
                  ? rows.reduce(
                      (a, r) => a + (r.total_recommendations ?? 0),
                      0
                    ) / rows.length
                  : 0,
            },
          };
        })
      : null;

  // --- instinct vs search: the same questions, split by instrument ---
  // Search engines may retrieve mid-answer (consumer-app behavior, carries
  // citations); instinct engines answer from trained knowledge alone. The
  // gap between the two rows is itself a finding: visibility the live web
  // grants or withholds relative to the model's priors.
  let modes: RunMetrics["modes"] = null;
  if (engineIds.length > 0) {
    modes = (["instinct", "search"] as const).flatMap((mode) => {
      const modelIds = engineIds.filter((m) => engineMode(m) === mode);
      if (modelIds.length === 0) return [];
      const rows = allUnbranded.filter((r) => engineMode(r.model) === mode);
      const ids = new Set(rows.map((r) => r.id));
      const bestRank = new Map<string, number>();
      for (const m of mentions) {
        if (!ids.has(m.response_id)) continue;
        if (!isT(canon.norm(m.brand))) continue;
        const prev = bestRank.get(m.response_id);
        if (prev === undefined || m.rank < prev) bestRank.set(m.response_id, m.rank);
      }
      const named = bestRank.size;
      const picks = rows.filter(
        (r) => r.top_pick_brand && isT(canon.norm(r.top_pick_brand))
      ).length;
      const ci = wilson(named, rows.length);
      const ranks = [...bestRank.values()];
      const reported = rows.filter((r) => r.search_count !== null);
      return [{
        mode,
        engines: modelIds,
        answers: rows.length,
        named,
        namedRate: rows.length > 0 ? named / rows.length : 0,
        ciLow: ci.low,
        ciHigh: ci.high,
        picks,
        pickRate: rows.length > 0 ? picks / rows.length : 0,
        avgPosition:
          ranks.length > 0 ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null,
        searchedAnswers:
          reported.length > 0
            ? reported.filter((r) => (r.search_count ?? 0) > 0).length
            : null,
        searchRate:
          reported.length > 0
            ? reported.filter((r) => (r.search_count ?? 0) > 0).length /
              reported.length
            : null,
        citedAnswers: rows.filter((r) => r.citations && r.citations.length > 0).length,
      }];
    });
    if (modes.length === 0) modes = null;
  }

  // --- source landscape: where grounded answers got their facts ---
  // Any citation-bearing answer contributes (Perplexity always; search-mode
  // engines when they chose to retrieve); domains ranked by DISTINCT citing
  // answers so one answer's ten citations count once each.
  let sources: RunMetrics["sources"] = null;
  {
    const cited = unbranded.filter(
      (r) => r.citations && r.citations.length > 0
    );
    if (cited.length > 0) {
      const activeBrands = dictionary.filter((e) => e.status === "active");
      const brandForDomain = (domain: string): string | null => {
        const bare = domain.replace(/^www\./, "").split(".")[0];
        for (const e of activeBrands) {
          const label = (e.display_name ?? e.canonical).toLowerCase();
          const compact = label.replace(/[^a-z0-9]/g, "");
          if (
            compact.length >= 4 &&
            (bare === compact || bare.includes(compact) || compact.includes(bare))
          ) {
            return e.display_name ?? e.canonical;
          }
        }
        return null;
      };
      const byDomain = new Map<string, Set<string>>();
      for (const r of cited) {
        for (const url of r.citations!) {
          let domain: string;
          try {
            domain = new URL(url).hostname.replace(/^www\./, "");
          } catch {
            continue;
          }
          const set = byDomain.get(domain) ?? new Set<string>();
          set.add(r.id);
          byDomain.set(domain, set);
        }
      }
      // Which brands co-occur in each domain's citing answers — the seed of
      // owned-vs-earned per brand. Distinct answers per (domain, brand).
      const citedIds = new Set(cited.map((r) => r.id));
      const brandsByResponse = new Map<string, Set<string>>();
      for (const m of mentions) {
        if (!citedIds.has(m.response_id)) continue;
        if (canon.isRejected(m.brand)) continue;
        const set = brandsByResponse.get(m.response_id) ?? new Set<string>();
        set.add(canon.canonical(m.brand));
        brandsByResponse.set(m.response_id, set);
      }
      sources = {
        citedAnswers: cited.length,
        domains: [...byDomain.entries()]
          .map(([domain, ids]) => {
            const counts = new Map<string, number>();
            for (const id of ids) {
              for (const b of brandsByResponse.get(id) ?? []) {
                counts.set(b, (counts.get(b) ?? 0) + 1);
              }
            }
            return {
              domain,
              answers: ids.size,
              share: ids.size / cited.length,
              brand: brandForDomain(domain),
              topBrands: [...counts.entries()]
                .map(([brand, answers]) => ({ brand, answers }))
                .sort((a, b) => b.answers - a.answers)
                .slice(0, 3),
            };
          })
          .sort((a, b) => b.answers - a.answers)
          .slice(0, 30),
      };
    }
  }

  // --- parent-company rollup (present only when parents are assigned) ---
  // A parent's rate counts distinct answers naming ANY of its brands, so
  // two siblings in one answer count once — not a sum of member rates.
  // Every independent brand is its own parent company by default, so the
  // view is a complete parent-grain landscape, not just the grouped ones.
  const parentByNorm = new Map<string, string>();
  const parentMembers = new Map<string, Set<string>>();
  const explicitParents = new Set<string>();
  for (const e of dictionary) {
    if (e.status !== "active") continue;
    const label = e.parent ?? e.display_name ?? e.canonical;
    if (e.parent) explicitParents.add(e.parent);
    parentByNorm.set(e.canonical.trim().toLowerCase(), label);
    const members = parentMembers.get(label) ?? new Set<string>();
    members.add(e.display_name ?? e.canonical);
    parentMembers.set(label, members);
  }
  let parentRollup: RunMetrics["parentRollup"] = null;
  if (explicitParents.size > 0) {
    const stats = new Map<
      string,
      { responseIds: Set<string>; mentionCount: number; hasTarget: boolean }
    >();
    for (const [norm, entry] of byBrand.entries()) {
      const parent = parentByNorm.get(norm);
      if (!parent) continue;
      const s =
        stats.get(parent) ??
        { responseIds: new Set<string>(), mentionCount: 0, hasTarget: false };
      for (const row of entry.rows) s.responseIds.add(row.response_id);
      s.mentionCount += entry.rows.length;
      if (isT(norm)) s.hasTarget = true;
      stats.set(parent, s);
    }
    parentRollup = [...parentMembers.entries()]
      .map(([parent, members]) => {
        const s = stats.get(parent);
        const k = s?.responseIds.size ?? 0;
        const ci = wilson(k, unbranded.length);
        return {
          parent,
          brands: [...members].sort(),
          mentionCount: s?.mentionCount ?? 0,
          responses: k,
          mentionRate: unbranded.length > 0 ? k / unbranded.length : 0,
          ciLow: ci.low,
          ciHigh: ci.high,
          shareOfVoice:
            totalMentions > 0 ? (s?.mentionCount ?? 0) / totalMentions : 0,
          includesTarget: s?.hasTarget ?? false,
        };
      })
      // Deliberately-grouped parents always show; single-brand default
      // parents earn their row by appearing in this run (or being you).
      .filter(
        (p) =>
          explicitParents.has(p.parent) ||
          p.mentionCount > 0 ||
          p.includesTarget
      )
      .sort((a, b) => b.mentionRate - a.mentionRate);
  }

  // Guarantee the target brand appears even at zero mentions.
  if (!brands.some((b) => b.isTarget)) {
    const ci = wilson(0, unbranded.length);
    brands.push({
      brand: project.brand,
      isTarget: true,
      isCompetitor: false,
      mentionCount: 0,
      mentionRate: 0,
      recommendedCount: 0,
      recommendedRate: 0,
      chosenCount: 0,
      chosenRate: 0,
      ciLow: ci.low,
      ciHigh: ci.high,
      avgRank: null,
      shareOfVoice: 0,
      framing: { recommended: 0, mentioned: 0, negative: 0 },
    });
  }

  // --- per-prompt stats for the target brand ---
  const targetByResponse = new Map<string, MentionRow>();
  for (const m of mentions) {
    if (isT(mentionNorm.get(m.id) ?? "")) {
      const prev = targetByResponse.get(m.response_id);
      if (!prev || m.rank < prev.rank) targetByResponse.set(m.response_id, m);
    }
  }
  const promptStats: PromptStats[] = prompts.map((p) => {
    const rows = responses.filter((r) => r.prompt_id === p.id);
    const hits = rows.filter((r) => targetByResponse.has(r.id));
    const ranks = hits.map((r) => targetByResponse.get(r.id)!.rank);
    return {
      promptId: p.id,
      text: p.text,
      theme: p.theme,
      responses: rows.length,
      targetMentions: hits.length,
      targetRate: rows.length > 0 ? hits.length / rows.length : 0,
      targetAvgRank:
        ranks.length > 0
          ? ranks.reduce((a, b) => a + b, 0) / ranks.length
          : null,
    };
  });

  // --- topic rollups: target visibility aggregated per prompt theme ---
  const themes: ThemeStats[] = THEME_ORDER.flatMap((theme) => {
    const ps = promptStats.filter((p) => p.theme === theme);
    if (ps.length === 0) return [];
    const themeResponses = ps.reduce((a, p) => a + p.responses, 0);
    const hits = ps.reduce((a, p) => a + p.targetMentions, 0);
    const ci = wilson(hits, themeResponses);
    const rankSum = ps.reduce(
      (a, p) => a + (p.targetAvgRank ?? 0) * p.targetMentions,
      0
    );
    return [
      {
        theme,
        prompts: ps.length,
        responses: themeResponses,
        targetMentions: hits,
        targetRate: themeResponses > 0 ? hits / themeResponses : 0,
        ciLow: ci.low,
        ciHigh: ci.high,
        targetAvgRank: hits > 0 ? rankSum / hits : null,
      },
    ];
  });

  // --- sample verbatims: prefer responses that mention the target ---
  const withTarget = unbranded.filter((r) => targetByResponse.has(r.id));
  const withoutTarget = unbranded.filter((r) => !targetByResponse.has(r.id));
  const verbatims = [...withTarget.slice(0, 2), ...withoutTarget.slice(0, 2)].map(
    (r) => ({
      promptText: promptById.get(r.prompt_id)?.text ?? "",
      text: r.text.length > 600 ? r.text.slice(0, 600) + "…" : r.text,
      mentionsTarget: targetByResponse.has(r.id),
    })
  );

  // ------------------------------------------------------------------
  // Coded layer — present only for runs extracted with the full schema.
  // ------------------------------------------------------------------
  const codedRows = unbranded.filter((r) => r.outcome !== null);
  const coded = codedRows.length > 0;

  let firstPick: RunMetrics["firstPick"] = null;
  let outcomes: RunMetrics["outcomes"] = null;
  let topPicks: RunMetrics["topPicks"] = null;
  let reasonLift: RunMetrics["reasonLift"] = null;
  let promptGrid: RunMetrics["promptGrid"] = null;
  let negatives: RunMetrics["negatives"] = null;
  let positionDist: RunMetrics["positionDist"] = null;

  if (coded) {
    const isTargetPick = (r: ResponseRow) =>
      r.top_pick_brand !== null && isT(canon.norm(r.top_pick_brand));

    outcomes = {
      pick: codedRows.filter((r) => r.outcome === "pick").length,
      conditional: codedRows.filter((r) => r.outcome === "conditional").length,
      no_pick: codedRows.filter((r) => r.outcome === "no_pick").length,
      clarification: codedRows.filter((r) => r.outcome === "clarification")
        .length,
    };

    const wins = codedRows.filter(isTargetPick);
    const fpCi = wilson(wins.length, codedRows.length);
    firstPick = {
      rate: codedRows.length > 0 ? wins.length / codedRows.length : 0,
      ciLow: fpCi.low,
      ciHigh: fpCi.high,
      count: wins.length,
      of: codedRows.length,
    };

    // Who wins instead — over decided answers.
    const decided = codedRows.filter(
      (r) => r.outcome === "pick" && r.top_pick_brand
    );
    const pickCounts = new Map<string, { display: string; n: number }>();
    for (const r of decided) {
      if (canon.isRejected(r.top_pick_brand!)) continue;
      const norm = canon.norm(r.top_pick_brand!);
      const e =
        pickCounts.get(norm) ?? {
          display: canon.canonical(r.top_pick_brand!),
          n: 0,
        };
      e.n++;
      pickCounts.set(norm, e);
    }
    topPicks = [...pickCounts.entries()]
      .map(([norm, e]) => ({
        brand: isT(norm) && !focus ? project.brand : e.display,
        isTarget: isT(norm),
        isCompetitor: roleOf(norm) === "competitor",
        picks: e.n,
        shareOfDecided: decided.length > 0 ? e.n / decided.length : 0,
      }))
      .sort((a, b) => b.picks - a.picks);

    // Reason-code lift — argument share in wins vs overall vs target-absent.
    if (project.reason_taxonomy.length > 0) {
      const reasonsOf = (r: ResponseRow) =>
        new Set((r.reason_codes ?? "").split("|").filter(Boolean));
      const absent = codedRows.filter((r) => !targetByResponse.has(r.id));
      reasonLift = project.reason_taxonomy
        .map((code) => {
          const inAll = codedRows.filter((r) => reasonsOf(r).has(code)).length;
          const inWins = wins.filter((r) => reasonsOf(r).has(code)).length;
          const inAbsent = absent.filter((r) => reasonsOf(r).has(code)).length;
          const shareAll = codedRows.length > 0 ? inAll / codedRows.length : 0;
          const shareWins = wins.length > 0 ? inWins / wins.length : 0;
          const shareAbsent = absent.length > 0 ? inAbsent / absent.length : 0;
          return {
            code,
            n: inAll,
            shareAll,
            shareWins,
            shareAbsent,
            lift: shareWins - shareAll,
            of: codedRows.length,
            winsN: inWins,
            winsOf: wins.length,
            absentN: inAbsent,
            absentOf: absent.length,
          };
        })
        .filter((r) => r.n > 0)
        .sort((a, b) => b.lift - a.lift);
    }

    // Prompt grid: modal pick per prompt + stability + badge.
    promptGrid = prompts
      .filter((p) => p.theme !== "branded")
      .map((p) => {
        const rows = codedRows.filter((r) => r.prompt_id === p.id);
        const decidedRows = rows.filter(
          (r) => r.outcome === "pick" && r.top_pick_brand
        );
        const counts = new Map<string, { display: string; n: number }>();
        for (const r of decidedRows) {
          if (canon.isRejected(r.top_pick_brand!)) continue;
          const norm = canon.norm(r.top_pick_brand!);
          const e =
            counts.get(norm) ?? {
              display: canon.canonical(r.top_pick_brand!),
              n: 0,
            };
          e.n++;
          counts.set(norm, e);
        }
        let modalNorm: string | null = null;
        let modalN = 0;
        let tie = false;
        for (const [norm, e] of counts) {
          if (e.n > modalN) {
            modalNorm = norm;
            modalN = e.n;
            tie = false;
          } else if (e.n === modalN) tie = true;
        }
        const named = rows.filter((r) => targetByResponse.has(r.id)).length;
        const targetPicks = rows.filter(isTargetPick).length;
        const badge: PromptBadge =
          named === 0
            ? "absent"
            : !tie &&
                modalNorm !== null &&
                isT(modalNorm) &&
                decidedRows.length > 0 &&
                modalN / decidedRows.length >= 0.5
              ? "win"
              : "contested";
        return {
          promptId: p.id,
          text: p.text,
          theme: p.theme,
          answers: rows.length,
          decided: decidedRows.length,
          modalPick:
            modalNorm && !tie
              ? isT(modalNorm)
                ? project.brand
                : counts.get(modalNorm)!.display
              : null,
          modalShare:
            modalNorm && !tie && decidedRows.length > 0
              ? modalN / decidedRows.length
              : null,
          targetNamed: named,
          targetPicks,
          badge,
        };
      });

    // Negatives: answers framing the target negatively, with the quote.
    negatives = responses
      .filter((r) => {
        const tm = targetByResponse.get(r.id);
        return tm?.framing === "negative";
      })
      .map((r) => ({
        promptText: promptById.get(r.prompt_id)?.text ?? "",
        // The coder extracts quotes for the client at collection time; under
        // a brand lens only the counts are honest, never the prose.
        quote: focus ? null : r.focus_quote,
        interpretation: focus ? null : r.focus_interpretation,
      }));

    // Position distribution among answers where the target appears.
    const ranks = [...targetByResponse.entries()]
      .filter(([id]) => unbrandedIds.has(id))
      .map(([, m]) => m.rank);
    positionDist = {
      r1: ranks.filter((r) => r === 1).length,
      r2: ranks.filter((r) => r === 2).length,
      r3: ranks.filter((r) => r === 3).length,
      r4plus: ranks.filter((r) => r >= 4).length,
    };
  }

  return {
    runId,
    model: run.model,
    totalResponses: responses.length,
    unbrandedResponses: unbranded.length,
    brands,
    prompts: promptStats,
    themes,
    verbatims,
    coded,
    firstPick,
    outcomes,
    positionDist,
    topPicks,
    reasonLift,
    promptGrid,
    negatives,
    sources,
    coreModels: [...coreSet],
    bonusModels,
    engines,
    modes,
    parentRollup,
    dictionaryVersion: project.dictionary_version,
  };
}
