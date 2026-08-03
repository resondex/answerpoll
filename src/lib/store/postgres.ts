import postgres from "postgres";
import type {
  Project,
  Prompt,
  Run,
  ResponseRow,
  MentionRow,
  Store,
} from "../types";

declare global {
  // eslint-disable-next-line no-var
  var __answerpoll_sql: ReturnType<typeof postgres> | undefined;
  // eslint-disable-next-line no-var
  var __answerpoll_schema: Promise<void> | undefined;
}

function getSql() {
  if (!globalThis.__answerpoll_sql) {
    // prepare:false — required for transaction-mode poolers (Supabase pgbouncer).
    globalThis.__answerpoll_sql = postgres(process.env.DATABASE_URL!, {
      prepare: false,
      max: 5,
    });
  }
  return globalThis.__answerpoll_sql;
}

function ensureSchema(): Promise<void> {
  if (!globalThis.__answerpoll_schema) {
    const sql = getSql();
    globalThis.__answerpoll_schema = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brand TEXT NOT NULL,
        competitors TEXT NOT NULL,
        category TEXT NOT NULL,
        audience TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        text TEXT NOT NULL,
        theme TEXT NOT NULL,
        seq SERIAL
      )`;
      await sql`CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        model TEXT NOT NULL,
        repeats INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        mock INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        prompt_id TEXT NOT NULL REFERENCES prompts(id),
        repeat_idx INTEGER NOT NULL,
        text TEXT NOT NULL,
        seq SERIAL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS mentions (
        id TEXT PRIMARY KEY,
        response_id TEXT NOT NULL REFERENCES responses(id),
        brand TEXT NOT NULL,
        brand_norm TEXT NOT NULL,
        rank INTEGER NOT NULL,
        framing TEXT NOT NULL
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_responses_run ON responses(run_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_mentions_response ON mentions(response_id)`;
    })();
  }
  return globalThis.__answerpoll_schema;
}

async function db() {
  await ensureSchema();
  return getSql();
}

// postgres.js returns Date objects for timestamps; the app's types use strings.
function iso(v: unknown): string | null {
  return v instanceof Date ? v.toISOString() : ((v as string | null) ?? null);
}

function rowToProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    brand: r.brand as string,
    competitors: JSON.parse(r.competitors as string),
    category: r.category as string,
    audience: (r.audience as string | null) ?? null,
    created_at: iso(r.created_at)!,
  };
}

function rowToRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    model: r.model as string,
    repeats: r.repeats as number,
    status: r.status as Run["status"],
    error: (r.error as string | null) ?? null,
    mock: r.mock as number,
    started_at: iso(r.started_at),
    completed_at: iso(r.completed_at),
    created_at: iso(r.created_at)!,
  };
}

export const pgStore: Store = {
  async createProject(input) {
    const sql = await db();
    const id = crypto.randomUUID();
    await sql`INSERT INTO projects (id, name, brand, competitors, category, audience)
      VALUES (${id}, ${input.name}, ${input.brand}, ${JSON.stringify(input.competitors)}, ${input.category}, ${input.audience})`;
    return (await this.getProject(id))!;
  },

  async getProject(id) {
    const sql = await db();
    const rows = await sql`SELECT * FROM projects WHERE id = ${id}`;
    return rows.length > 0 ? rowToProject(rows[0]) : null;
  },

  async listProjects() {
    const sql = await db();
    const rows = await sql`SELECT * FROM projects ORDER BY created_at DESC`;
    return rows.map(rowToProject);
  },

  async insertPrompts(projectId, prompts) {
    const sql = await db();
    await sql.begin(async (tx) => {
      for (const p of prompts) {
        await tx`INSERT INTO prompts (id, project_id, text, theme)
          VALUES (${crypto.randomUUID()}, ${projectId}, ${p.text}, ${p.theme})`;
      }
    });
    return this.listPrompts(projectId);
  },

  async listPrompts(projectId) {
    const sql = await db();
    const rows =
      await sql`SELECT id, project_id, text, theme FROM prompts WHERE project_id = ${projectId} ORDER BY seq`;
    return rows.map((r) => ({ ...r }) as unknown as Prompt);
  },

  async createRun(input) {
    const sql = await db();
    const id = crypto.randomUUID();
    await sql`INSERT INTO runs (id, project_id, model, repeats, status, mock)
      VALUES (${id}, ${input.projectId}, ${input.model}, ${input.repeats}, 'pending', ${input.mock ? 1 : 0})`;
    return (await this.getRun(id))!;
  },

  async getRun(id) {
    const sql = await db();
    const rows = await sql`SELECT * FROM runs WHERE id = ${id}`;
    return rows.length > 0 ? rowToRun(rows[0]) : null;
  },

  async listRuns(projectId) {
    const sql = await db();
    const rows =
      await sql`SELECT * FROM runs WHERE project_id = ${projectId} ORDER BY created_at DESC`;
    return rows.map(rowToRun);
  },

  async updateRunStatus(id, status, error) {
    const sql = await db();
    if (status === "running") {
      await sql`UPDATE runs SET status = ${status}, started_at = now() WHERE id = ${id}`;
    } else if (status === "complete" || status === "failed") {
      await sql`UPDATE runs SET status = ${status}, error = ${error ?? null}, completed_at = now() WHERE id = ${id}`;
    } else {
      await sql`UPDATE runs SET status = ${status} WHERE id = ${id}`;
    }
  },

  async insertResponse(input) {
    const sql = await db();
    const responseId = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO responses (id, run_id, prompt_id, repeat_idx, text)
        VALUES (${responseId}, ${input.runId}, ${input.promptId}, ${input.repeatIdx}, ${input.text})`;
      for (let i = 0; i < input.mentions.length; i++) {
        const m = input.mentions[i];
        await tx`INSERT INTO mentions (id, response_id, brand, brand_norm, rank, framing)
          VALUES (${crypto.randomUUID()}, ${responseId}, ${m.brand}, ${m.brand.trim().toLowerCase()}, ${i + 1}, ${m.framing})`;
      }
    });
  },

  async countResponses(runId) {
    const sql = await db();
    const rows =
      await sql`SELECT COUNT(*)::int AS n FROM responses WHERE run_id = ${runId}`;
    return rows[0].n as number;
  },

  async listResponses(runId) {
    const sql = await db();
    const rows =
      await sql`SELECT * FROM responses WHERE run_id = ${runId} ORDER BY seq`;
    return rows.map(
      (r) =>
        ({
          id: r.id,
          run_id: r.run_id,
          prompt_id: r.prompt_id,
          repeat_idx: r.repeat_idx,
          text: r.text,
          created_at: iso(r.created_at)!,
        }) as ResponseRow
    );
  },

  async listMentionsForRun(runId) {
    const sql = await db();
    const rows = await sql`SELECT m.* FROM mentions m
      JOIN responses r ON r.id = m.response_id
      WHERE r.run_id = ${runId}`;
    return rows.map((r) => ({ ...r }) as unknown as MentionRow);
  },
};
