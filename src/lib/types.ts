export type PromptTheme =
  | "discovery"
  | "recommendation"
  | "comparison"
  | "use_case"
  | "branded";

export type RunStatus = "pending" | "running" | "complete" | "failed";

export type Framing = "recommended" | "mentioned" | "negative";

export type RunSchedule = "none" | "weekly" | "monthly";

export type Plan = "free" | "pro" | "enterprise";

export type OrgRole = "admin" | "editor" | "viewer";

export interface Org {
  id: string;
  name: string;
  created_at: string;
}

export interface OrgMember {
  org_id: string;
  email: string; // lowercase
  role: OrgRole;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  brand: string;
  competitors: string[];
  category: string;
  audience: string | null;
  schedule: RunSchedule;
  user_id: string | null;
  /** Owning organization; null = personal/legacy tracker. */
  org_id: string | null;
  /** Closed reason-code taxonomy, generated at setup and frozen. */
  reason_taxonomy: string[];
  /** The core engine panel — part of the frozen instrument. Scheduled runs
   * always use it; headline metrics and the trend compute over it. Engines
   * beyond it in a run are bonus views. */
  engine_set: string[];
  dictionary_version: number;
  created_at: string;
}

export interface Prompt {
  id: string;
  project_id: string;
  text: string;
  theme: PromptTheme;
  /** Set by the post-first-run health check when a prompt looks defective. */
  flagged: number;
  flag_reason: string | null;
  suggested_alternatives: string[];
  /** Retired prompts keep their history but are excluded from future runs. */
  retired: number;
}

export interface Run {
  id: string;
  project_id: string;
  /** Primary engine — kept for display and pre-multi-engine runs. */
  model: string;
  /** Every engine this run samples. One answer per prompt × repeat × engine. */
  models: string[];
  repeats: number;
  status: RunStatus;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

/** How decisive an answer was. "conditional" = recommends different
 * options for different situations, so it crowns nobody. */
export type AnswerOutcome =
  | "pick"
  | "conditional"
  | "no_pick"
  | "clarification";

export interface ResponseRow {
  id: string;
  run_id: string;
  prompt_id: string;
  repeat_idx: number;
  /** The engine that produced this answer. */
  model: string;
  /** Vendor-reported stop reason — 'length'/'max_tokens' = truncated. */
  finish_reason: string | null;
  /** Grounded engines' source URLs (Perplexity), JSON-parsed. */
  citations: string[] | null;
  /** Which extraction model coded this answer — per-response provenance. */
  coder_model: string | null;
  /** Web searches the engine chose to run for this answer. 0 = had the
   * search tool but answered from weights; null = not reported. */
  search_count: number | null;
  text: string;
  /** Brand the answer explicitly crowns as its choice (raw, pre-dictionary). */
  top_pick_brand: string | null;
  outcome: AnswerOutcome | null;
  reason_codes: string | null; // pipe-joined, from the project taxonomy
  clarification_requested: number | null;
  gives_recommendation: number | null;
  includes_prices: number | null;
  includes_specs: number | null;
  total_recommendations: number | null;
  focus_quote: string | null;
  focus_interpretation: string | null;
  created_at: string;
}

export interface DictionaryEntry {
  id: string;
  project_id: string;
  /** Fossilized match string — never destroyed, keeps runs comparable. */
  canonical: string;
  aliases: string[]; // normalized lowercase — also fossilized match strings
  /** User-facing label; renameable at any time without touching matching. */
  display_name: string | null;
  status: "active" | "pending" | "rejected";
  /** Normalized names the user has explicitly confirmed in the Identify
   * view — drives the red (new) / blue (confirmed) pill states. */
  confirmed: string[];
  /** Parent-company label for rollups; null = not assigned to a parent. */
  parent: string | null;
  /** Tracked rival or model-volunteered discovery. null = derive from the
   * setup-time competitor list (pre-migration entries). The target brand's
   * role is always derived from the project, never stored. */
  role: "competitor" | "emerged" | null;
  version: number;
  created_at: string;
}

export interface MentionRow {
  id: string;
  response_id: string;
  brand: string;
  brand_norm: string;
  rank: number;
  framing: Framing;
}

export interface ExtractedMention {
  brand: string;
  framing: Framing;
}

/** Full per-answer coding returned by the extraction model. */
export interface ExtractionResult {
  mentions: ExtractedMention[];
  top_pick_brand: string | null;
  outcome: AnswerOutcome;
  reasons: string[];
  clarification_requested: boolean;
  gives_recommendation: boolean;
  includes_prices: boolean;
  includes_specs: boolean;
  total_recommendations: number;
  focus_quote: string | null;
  focus_interpretation: string | null;
}

export interface BrandStats {
  brand: string;
  isTarget: boolean;
  isCompetitor: boolean;
  mentionCount: number;
  mentionRate: number;
  /** Answers that endorse the brand — the funnel's middle stage. A crowned
   * brand always counts as recommended, so the funnel can never invert. */
  recommendedCount: number;
  recommendedRate: number;
  /** Answers that crown this brand, over the same base as the two above. */
  chosenCount: number;
  chosenRate: number;
  ciLow: number;
  ciHigh: number;
  avgRank: number | null;
  shareOfVoice: number;
  framing: Record<Framing, number>;
}

export interface PromptStats {
  promptId: string;
  text: string;
  theme: PromptTheme;
  responses: number;
  targetMentions: number;
  targetRate: number;
  targetAvgRank: number | null;
}

export interface ThemeStats {
  theme: PromptTheme;
  prompts: number;
  responses: number;
  targetMentions: number;
  targetRate: number;
  ciLow: number;
  ciHigh: number;
  targetAvgRank: number | null;
}

export type PromptBadge = "win" | "contested" | "absent";

export interface RunMetrics {
  runId: string;
  model: string;
  totalResponses: number;
  unbrandedResponses: number;
  brands: BrandStats[];
  prompts: PromptStats[];
  themes: ThemeStats[];
  verbatims: { promptText: string; text: string; mentionsTarget: boolean }[];
  /** Whether this run carries the full coding layer (top pick, reasons…). */
  coded: boolean;
  firstPick: {
    rate: number;
    ciLow: number;
    ciHigh: number;
    count: number;
    of: number;
  } | null;
  outcomes: {
    pick: number;
    conditional: number;
    no_pick: number;
    clarification: number;
  } | null;
  /** Target position distribution among answers where it appears. */
  positionDist: { r1: number; r2: number; r3: number; r4plus: number } | null;
  /** Who wins instead: first-pick leaderboard over decided unbranded answers. */
  topPicks:
    | {
        brand: string;
        isTarget: boolean;
        isCompetitor: boolean;
        picks: number;
        shareOfDecided: number;
      }[]
    | null;
  reasonLift:
    | {
        code: string;
        n: number;
        shareAll: number;
        shareWins: number;
        shareAbsent: number;
        lift: number;
        /** The counts behind the shares — small denominators should read
         * loosely, so every surface can show them. */
        of: number;
        winsN: number;
        winsOf: number;
        absentN: number;
        absentOf: number;
      }[]
    | null;
  promptGrid:
    | {
        promptId: string;
        text: string;
        theme: PromptTheme;
        answers: number;
        decided: number;
        modalPick: string | null;
        modalShare: number | null;
        targetNamed: number;
        targetPicks: number;
        badge: PromptBadge;
      }[]
    | null;
  negatives:
    | { promptText: string; quote: string | null; interpretation: string | null }[]
    | null;
  /** Where grounded answers got their facts — present when any sampled
   * engine returned citations. Domains ranked by distinct citing answers. */
  sources:
    | {
        citedAnswers: number;
        domains: {
          domain: string;
          answers: number;
          share: number;
          brand: string | null;
          /** Brands most co-occurring in the answers that cite this domain. */
          topBrands: { brand: string; answers: number }[];
        }[];
      }
    | null;
  /** The engine panel headline numbers were computed over, and any bonus
   * engines sampled beyond it (shown per-engine, excluded from headlines). */
  coreModels: string[];
  bonusModels: string[];
  /** Per-engine breakdown — one entry per engine sampled in the run. */
  engines:
    | {
        model: string;
        /** Instinct (trained knowledge) vs search (may retrieve mid-answer). */
        mode: "instinct" | "search";
        answers: number;
        named: number;
        namedRate: number;
        ciLow: number;
        ciHigh: number;
        picks: number;
        pickRate: number;
        avgPosition: number | null;
        /** Share of answers where the engine chose to search; null when the
         * vendor doesn't report search counts (e.g. Perplexity). */
        searchRate: number | null;
        citedAnswers: number;
        /** How the engine's answers behave — the Style view. */
        outcomes: {
          pick: number;
          conditional: number;
          no_pick: number;
          clarification: number;
        };
        style: {
          avgWords: number;
          /** Distinct brands the engine names per answer — category crowding. */
          avgBrands: number;
          recRate: number;
          priceRate: number;
          specRate: number;
          clarRate: number;
          avgOptions: number;
        };
      }[]
    | null;
  /** The instinct-vs-search cut: the same headline questions, split by
   * whether engines could retrieve. Two rows when a run samples both. */
  modes:
    | {
        mode: "instinct" | "search";
        engines: string[];
        answers: number;
        named: number;
        namedRate: number;
        ciLow: number;
        ciHigh: number;
        picks: number;
        pickRate: number;
        avgPosition: number | null;
        /** Answers where the engine actually searched (reported only). */
        searchedAnswers: number | null;
        searchRate: number | null;
        citedAnswers: number;
      }[]
    | null;
  /** Parent-company rollup — present when any grouping has a parent. */
  parentRollup:
    | {
        parent: string;
        brands: string[];
        mentionCount: number;
        responses: number;
        mentionRate: number;
        ciLow: number;
        ciHigh: number;
        shareOfVoice: number;
        includesTarget: boolean;
      }[]
    | null;
  dictionaryVersion: number;
}

export interface RunProgress {
  run: Run;
  completed: number;
  total: number;
}

export interface SetupDraft {
  id: string;
  user_id: string | null;
  brand: string;
  category: string;
  competitors: string[];
  audience: string | null;
  prompts: { text: string; theme: PromptTheme }[] | null;
  updated_at: string;
}

export interface TrendPoint {
  rate: number;
  ciLow: number;
  ciHigh: number;
  shareOfVoice: number;
}

export interface TrendSeries {
  brand: string;
  isTarget: boolean;
  points: TrendPoint[];
}

export interface ProjectTrend {
  runs: { runId: string; date: string; model: string; unbranded: number }[];
  series: TrendSeries[];
}

/**
 * Async storage interface implemented by both drivers (SQLite for local dev,
 * Postgres when DATABASE_URL is set — serverless filesystems don't persist).
 */
export interface Store {
  createProject(input: {
    name: string;
    brand: string;
    competitors: string[];
    category: string;
    audience: string | null;
    userId: string | null;
    reasonTaxonomy: string[];
    engineSet: string[];
  }): Promise<Project>;
  getDictionary(projectId: string): Promise<DictionaryEntry[]>;
  upsertDictionaryEntry(input: {
    id: string | null;
    projectId: string;
    canonical: string;
    aliases: string[];
    status: DictionaryEntry["status"];
    displayName?: string | null;
  }): Promise<DictionaryEntry>;
  /** Queue unmatched raw names as pending entries (skip known names). */
  queueDictionaryCandidates(projectId: string, names: string[]): Promise<void>;
  /** Bulk-insert active entries for a fresh project (one write, no upsert). */
  insertDictionaryEntries(
    projectId: string,
    entries: {
      canonical: string;
      aliases: string[];
      role?: "competitor" | "emerged" | null;
    }[]
  ): Promise<void>;
  /** Flip a brand between tracked competitor and discovered. */
  setDictionaryRole(
    entryId: string,
    role: "competitor" | "emerged"
  ): Promise<void>;
  // --- orgs, membership, staff ---
  createOrg(name: string): Promise<Org>;
  listOrgs(): Promise<Org[]>;
  listOrgMembers(orgId: string): Promise<OrgMember[]>;
  upsertOrgMember(orgId: string, email: string, role: OrgRole): Promise<void>;
  removeOrgMember(orgId: string, email: string): Promise<void>;
  /** Org memberships for a user's email → [{org_id, role}]. */
  listMembershipsForEmail(email: string): Promise<OrgMember[]>;
  setProjectOrg(projectId: string, orgId: string | null): Promise<void>;
  listProjectsByOrgIds(orgIds: string[]): Promise<Project[]>;
  isStaffEmail(email: string): Promise<boolean>;
  listStaff(): Promise<string[]>;
  addStaff(email: string): Promise<void>;
  removeStaff(email: string): Promise<void>;
  /** Mark names (normalized) as user-confirmed on whichever entry owns them. */
  confirmDictionaryNames(projectId: string, names: string[]): Promise<void>;
  /** Assign (or clear, with null) an entry's parent-company label. */
  setDictionaryParent(entryId: string, parent: string | null): Promise<void>;
  /** Rename a parent label across every entry in the project that has it. */
  renameDictionaryParent(
    projectId: string,
    from: string,
    to: string
  ): Promise<void>;
  bumpDictionaryVersion(projectId: string): Promise<number>;
  getProject(id: string): Promise<Project | null>;
  /** All projects when userId is omitted (cron); the user's own otherwise. */
  listProjects(userId?: string): Promise<Project[]>;
  updateProjectSchedule(id: string, schedule: RunSchedule): Promise<void>;
  updateProjectEngineSet(id: string, engineSet: string[]): Promise<void>;
  getPlan(userId: string): Promise<Plan>;
  /** Cached value no older than maxAgeMs, else null. */
  cacheGet(key: string, maxAgeMs: number): Promise<string | null>;
  cacheSet(key: string, value: string): Promise<void>;
  saveSetupDraft(input: {
    id: string | null;
    userId: string | null;
    brand: string;
    category: string;
    competitors: string[];
    audience: string | null;
    prompts: { text: string; theme: PromptTheme }[] | null;
  }): Promise<SetupDraft>;
  getSetupDraft(id: string): Promise<SetupDraft | null>;
  listSetupDrafts(userId: string | null): Promise<SetupDraft[]>;
  deleteSetupDraft(id: string): Promise<void>;
  insertPrompts(
    projectId: string,
    prompts: { text: string; theme: PromptTheme }[]
  ): Promise<Prompt[]>;
  listPrompts(projectId: string): Promise<Prompt[]>;
  setPromptFlag(
    promptId: string,
    flag: { reason: string; alternatives: string[] } | null
  ): Promise<void>;
  retirePrompt(promptId: string): Promise<void>;
  createRun(input: {
    projectId: string;
    model: string;
    models?: string[];
    repeats: number;
  }): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  listRuns(projectId: string): Promise<Run[]>;
  updateRunStatus(
    id: string,
    status: RunStatus,
    error?: string | null
  ): Promise<void>;
  insertResponse(input: {
    runId: string;
    promptId: string;
    repeatIdx: number;
    model: string;
    finishReason?: string | null;
    citations?: string[] | null;
    coderModel?: string | null;
    searchCount?: number | null;
    text: string;
    mentions: { brand: string; framing: Framing }[];
    coding: Omit<ExtractionResult, "mentions"> | null;
  }): Promise<void>;
  /**
   * Re-code an existing answer in place: overwrite the coding columns and
   * replace its mentions, leaving the collected text untouched. Shares its
   * column list with insertResponse (see lib/coding_columns.ts) so the two
   * write paths cannot fall out of step.
   */
  writeResponseCoding(
    responseId: string,
    coding: Omit<ExtractionResult, "mentions"> | null,
    coderModel: string | null,
    mentions: { brand: string; framing: Framing }[]
  ): Promise<void>;
  /** Delete a run and its responses/mentions. Prompts and dictionary stay. */
  deleteRun(runId: string): Promise<void>;
  /** Delete a project and everything under it: runs, prompts, dictionary. */
  deleteProject(projectId: string): Promise<void>;
  countResponses(runId: string): Promise<number>;
  /**
   * Answers landed so far per engine. Powers live progress: engines are the
   * innermost loop of the task list, so they advance together and the laggards
   * are what the reader is actually waiting on.
   */
  countResponsesByModel(runId: string): Promise<Record<string, number>>;
  listResponses(runId: string): Promise<ResponseRow[]>;
  listMentionsForRun(runId: string): Promise<MentionRow[]>;
}
