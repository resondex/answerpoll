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
