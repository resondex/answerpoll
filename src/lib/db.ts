import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type {
  Project,
  Prompt,
  Run,
  ResponseRow,
  MentionRow,
  RunStatus,
  PromptTheme,
  Framing,
} from "./types";

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "answerpoll.db");

declare global {
  // eslint-disable-next-line no-var
  var __answerpoll_db: Database.Database | undefined;
}

function createDb(): Database.Database {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      competitors TEXT NOT NULL,
      category TEXT NOT NULL,
      audience TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      text TEXT NOT NULL,
      theme TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      model TEXT NOT NULL,
      repeats INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      mock INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      prompt_id TEXT NOT NULL REFERENCES prompts(id),
      repeat_idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mentions (
      id TEXT PRIMARY KEY,
      response_id TEXT NOT NULL REFERENCES responses(id),
      brand TEXT NOT NULL,
      brand_norm TEXT NOT NULL,
      rank INTEGER NOT NULL,
      framing TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id);
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
    CREATE INDEX IF NOT EXISTS idx_responses_run ON responses(run_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_response ON mentions(response_id);
  `);
  return db;
}

export function getDb(): Database.Database {
  if (!globalThis.__answerpoll_db) {
    globalThis.__answerpoll_db = createDb();
  }
  return globalThis.__answerpoll_db;
}

// --- projects ---

interface ProjectRaw extends Omit<Project, "competitors"> {
  competitors: string;
}

function parseProject(row: ProjectRaw): Project {
  return { ...row, competitors: JSON.parse(row.competitors) };
}

export function createProject(input: {
  name: string;
  brand: string;
  competitors: string[];
  category: string;
  audience: string | null;
}): Project {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, brand, competitors, category, audience)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.name,
      input.brand,
      JSON.stringify(input.competitors),
      input.category,
      input.audience
    );
  return getProject(id)!;
}

export function getProject(id: string): Project | null {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as ProjectRaw | undefined;
  return row ? parseProject(row) : null;
}

export function listProjects(): Project[] {
  const rows = getDb()
    .prepare("SELECT * FROM projects ORDER BY created_at DESC")
    .all() as ProjectRaw[];
  return rows.map(parseProject);
}

// --- prompts ---

export function insertPrompts(
  projectId: string,
  prompts: { text: string; theme: PromptTheme }[]
): Prompt[] {
  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO prompts (id, project_id, text, theme) VALUES (?, ?, ?, ?)"
  );
  const insertAll = db.transaction(() => {
    for (const p of prompts) {
      stmt.run(crypto.randomUUID(), projectId, p.text, p.theme);
    }
  });
  insertAll();
  return listPrompts(projectId);
}

export function listPrompts(projectId: string): Prompt[] {
  return getDb()
    .prepare("SELECT * FROM prompts WHERE project_id = ? ORDER BY rowid")
    .all(projectId) as Prompt[];
}

// --- runs ---

export function createRun(input: {
  projectId: string;
  model: string;
  repeats: number;
  mock: boolean;
}): Run {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO runs (id, project_id, model, repeats, status, mock)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    )
    .run(id, input.projectId, input.model, input.repeats, input.mock ? 1 : 0);
  return getRun(id)!;
}

export function getRun(id: string): Run | null {
  const row = getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id) as
    | Run
    | undefined;
  return row ?? null;
}

export function listRuns(projectId: string): Run[] {
  return getDb()
    .prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as Run[];
}

export function updateRunStatus(
  id: string,
  status: RunStatus,
  error?: string | null
): void {
  const db = getDb();
  if (status === "running") {
    db.prepare(
      "UPDATE runs SET status = ?, started_at = datetime('now') WHERE id = ?"
    ).run(status, id);
  } else if (status === "complete" || status === "failed") {
    db.prepare(
      "UPDATE runs SET status = ?, error = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(status, error ?? null, id);
  } else {
    db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, id);
  }
}

// --- responses + mentions ---

export function insertResponse(input: {
  runId: string;
  promptId: string;
  repeatIdx: number;
  text: string;
  mentions: { brand: string; framing: Framing }[];
}): void {
  const db = getDb();
  const responseId = crypto.randomUUID();
  const insertAll = db.transaction(() => {
    db.prepare(
      `INSERT INTO responses (id, run_id, prompt_id, repeat_idx, text)
       VALUES (?, ?, ?, ?, ?)`
    ).run(responseId, input.runId, input.promptId, input.repeatIdx, input.text);
    const stmt = db.prepare(
      `INSERT INTO mentions (id, response_id, brand, brand_norm, rank, framing)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    input.mentions.forEach((m, i) => {
      stmt.run(
        crypto.randomUUID(),
        responseId,
        m.brand,
        m.brand.trim().toLowerCase(),
        i + 1,
        m.framing
      );
    });
  });
  insertAll();
}

export function countResponses(runId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM responses WHERE run_id = ?")
    .get(runId) as { n: number };
  return row.n;
}

export function listResponses(runId: string): ResponseRow[] {
  return getDb()
    .prepare("SELECT * FROM responses WHERE run_id = ? ORDER BY rowid")
    .all(runId) as ResponseRow[];
}

export function listMentionsForRun(runId: string): MentionRow[] {
  return getDb()
    .prepare(
      `SELECT m.* FROM mentions m
       JOIN responses r ON r.id = m.response_id
       WHERE r.run_id = ?`
    )
    .all(runId) as MentionRow[];
}
