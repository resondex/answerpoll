import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type {
  Project,
  Prompt,
  Run,
  ResponseRow,
  MentionRow,
  Store,
} from "../types";

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
      schedule TEXT NOT NULL DEFAULT 'none',
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_plans (
      user_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free'
    );
    CREATE TABLE IF NOT EXISTS llm_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_task ON responses(run_id, prompt_id, repeat_idx);
    CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id);
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
    CREATE INDEX IF NOT EXISTS idx_responses_run ON responses(run_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_response ON mentions(response_id);
  `);
  // Databases created before these columns existed need the ALTERs.
  const cols = db.prepare("PRAGMA table_info(projects)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "schedule")) {
    db.exec(
      "ALTER TABLE projects ADD COLUMN schedule TEXT NOT NULL DEFAULT 'none'"
    );
  }
  if (!cols.some((c) => c.name === "user_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN user_id TEXT");
  }
  return db;
}

function getDb(): Database.Database {
  if (!globalThis.__answerpoll_db) {
    globalThis.__answerpoll_db = createDb();
  }
  return globalThis.__answerpoll_db;
}

interface ProjectRaw extends Omit<Project, "competitors"> {
  competitors: string;
}

function parseProject(row: ProjectRaw): Project {
  return {
    ...row,
    competitors: JSON.parse(row.competitors),
    schedule: row.schedule ?? "none",
  };
}

export const sqliteStore: Store = {
  async createProject(input) {
    const id = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO projects (id, name, brand, competitors, category, audience, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.brand,
        JSON.stringify(input.competitors),
        input.category,
        input.audience,
        input.userId
      );
    return (await this.getProject(id))!;
  },

  async getProject(id) {
    const row = getDb()
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRaw | undefined;
    return row ? parseProject(row) : null;
  },

  async listProjects(userId) {
    const rows = (
      userId === undefined
        ? getDb()
            .prepare("SELECT * FROM projects ORDER BY created_at DESC")
            .all()
        : getDb()
            .prepare(
              "SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC"
            )
            .all(userId)
    ) as ProjectRaw[];
    return rows.map(parseProject);
  },

  async getPlan(userId) {
    const row = getDb()
      .prepare("SELECT plan FROM user_plans WHERE user_id = ?")
      .get(userId) as { plan: string } | undefined;
    return (row?.plan as "free" | "pro" | "enterprise") ?? "free";
  },

  async cacheGet(key, maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const row = getDb()
      .prepare("SELECT value FROM llm_cache WHERE key = ? AND created_at > ?")
      .get(key, cutoff) as { value: string } | undefined;
    return row?.value ?? null;
  },

  async cacheSet(key, value) {
    getDb()
      .prepare(
        `INSERT INTO llm_cache (key, value, created_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = datetime('now')`
      )
      .run(key, value);
  },

  async updateProjectSchedule(id, schedule) {
    getDb()
      .prepare("UPDATE projects SET schedule = ? WHERE id = ?")
      .run(schedule, id);
  },

  async insertPrompts(projectId, prompts) {
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
    return this.listPrompts(projectId);
  },

  async listPrompts(projectId) {
    return getDb()
      .prepare("SELECT * FROM prompts WHERE project_id = ? ORDER BY rowid")
      .all(projectId) as Prompt[];
  },

  async createRun(input) {
    const id = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO runs (id, project_id, model, repeats, status)
         VALUES (?, ?, ?, ?, 'pending')`
      )
      .run(id, input.projectId, input.model, input.repeats);
    return (await this.getRun(id))!;
  },

  async getRun(id) {
    const row = getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | Run
      | undefined;
    return row ?? null;
  },

  async listRuns(projectId) {
    return getDb()
      .prepare(
        "SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC"
      )
      .all(projectId) as Run[];
  },

  async updateRunStatus(id, status, error) {
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
  },

  async insertResponse(input) {
    const db = getDb();
    const responseId = crypto.randomUUID();
    const insertAll = db.transaction(() => {
      // OR IGNORE + unique(run, prompt, repeat): overlapping chunk workers
      // can race on the same task; only the first insert lands.
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO responses (id, run_id, prompt_id, repeat_idx, text)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          responseId,
          input.runId,
          input.promptId,
          input.repeatIdx,
          input.text
        );
      if (info.changes === 0) return;
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
  },

  async countResponses(runId) {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM responses WHERE run_id = ?")
      .get(runId) as { n: number };
    return row.n;
  },

  async listResponses(runId) {
    return getDb()
      .prepare("SELECT * FROM responses WHERE run_id = ? ORDER BY rowid")
      .all(runId) as ResponseRow[];
  },

  async listMentionsForRun(runId) {
    return getDb()
      .prepare(
        `SELECT m.* FROM mentions m
         JOIN responses r ON r.id = m.response_id
         WHERE r.run_id = ?`
      )
      .all(runId) as MentionRow[];
  },
};
