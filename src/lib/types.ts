export type PromptTheme =
  | "discovery"
  | "recommendation"
  | "comparison"
  | "use_case"
  | "branded";

export type RunStatus = "pending" | "running" | "complete" | "failed";

export type Framing = "recommended" | "mentioned" | "negative";

export interface Project {
  id: string;
  name: string;
  brand: string;
  competitors: string[];
  category: string;
  audience: string | null;
  created_at: string;
}

export interface Prompt {
  id: string;
  project_id: string;
  text: string;
  theme: PromptTheme;
}

export interface Run {
  id: string;
  project_id: string;
  model: string;
  repeats: number;
  status: RunStatus;
  error: string | null;
  mock: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ResponseRow {
  id: string;
  run_id: string;
  prompt_id: string;
  repeat_idx: number;
  text: string;
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

export interface BrandStats {
  brand: string;
  isTarget: boolean;
  isCompetitor: boolean;
  mentionCount: number;
  mentionRate: number;
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

export interface RunMetrics {
  runId: string;
  model: string;
  mock: boolean;
  totalResponses: number;
  unbrandedResponses: number;
  brands: BrandStats[];
  prompts: PromptStats[];
  verbatims: { promptText: string; text: string; mentionsTarget: boolean }[];
}

export interface RunProgress {
  run: Run;
  completed: number;
  total: number;
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
  }): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;
  insertPrompts(
    projectId: string,
    prompts: { text: string; theme: PromptTheme }[]
  ): Promise<Prompt[]>;
  listPrompts(projectId: string): Promise<Prompt[]>;
  createRun(input: {
    projectId: string;
    model: string;
    repeats: number;
    mock: boolean;
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
    text: string;
    mentions: { brand: string; framing: Framing }[];
  }): Promise<void>;
  countResponses(runId: string): Promise<number>;
  listResponses(runId: string): Promise<ResponseRow[]>;
  listMentionsForRun(runId: string): Promise<MentionRow[]>;
}
