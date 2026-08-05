import postgres from "postgres";
import type {
  DictionaryEntry,
  Project,
  Prompt,
  Run,
  ResponseRow,
  MentionRow,
  SetupDraft,
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
    const url = process.env.DATABASE_URL!;
    // Hosted poolers (Supabase supavisor) expect TLS; local dev databases
    // usually don't have certs. prepare:false is required for
    // transaction-mode poolers.
    const local = /localhost|127\.0\.0\.1/.test(url);
    globalThis.__answerpoll_sql = postgres(url, {
      prepare: false,
      max: 5,
      ssl: local ? undefined : "require",
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
        schedule TEXT NOT NULL DEFAULT 'none',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS schedule TEXT NOT NULL DEFAULT 'none'`;
      await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id TEXT`;
      await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS reason_taxonomy TEXT NOT NULL DEFAULT '[]'`;
      await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS dictionary_version INTEGER NOT NULL DEFAULT 1`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS top_pick_brand TEXT`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS outcome TEXT`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS reason_codes TEXT`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS clarification_requested INTEGER`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS gives_recommendation INTEGER`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS includes_prices INTEGER`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS includes_specs INTEGER`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS total_recommendations INTEGER`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS focus_quote TEXT`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS focus_interpretation TEXT`;
      await sql`CREATE TABLE IF NOT EXISTS dictionary_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        canonical TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`ALTER TABLE dictionary_entries ADD COLUMN IF NOT EXISTS display_name TEXT`;
      await sql`CREATE TABLE IF NOT EXISTS user_plans (
        user_id TEXT PRIMARY KEY,
        plan TEXT NOT NULL DEFAULT 'free'
      )`;
      await sql`CREATE TABLE IF NOT EXISTS llm_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS setup_drafts (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        brand TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        competitors TEXT NOT NULL DEFAULT '[]',
        audience TEXT,
        prompts TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_task ON responses(run_id, prompt_id, repeat_idx)`;
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
    schedule: (r.schedule as Project["schedule"]) ?? "none",
    user_id: (r.user_id as string | null) ?? null,
    reason_taxonomy: JSON.parse((r.reason_taxonomy as string) ?? "[]"),
    dictionary_version: (r.dictionary_version as number) ?? 1,
    created_at: iso(r.created_at)!,
  };
}

function rowToDictEntry(r: Record<string, unknown>): DictionaryEntry {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    canonical: r.canonical as string,
    aliases: JSON.parse((r.aliases as string) ?? "[]"),
    display_name: (r.display_name as string | null) ?? null,
    status: r.status as DictionaryEntry["status"],
    version: (r.version as number) ?? 1,
    created_at: iso(r.created_at)!,
  };
}

function rowToDraft(r: Record<string, unknown>): SetupDraft {
  return {
    id: r.id as string,
    user_id: (r.user_id as string | null) ?? null,
    brand: r.brand as string,
    category: (r.category as string) ?? "",
    competitors: JSON.parse((r.competitors as string) ?? "[]"),
    audience: (r.audience as string | null) ?? null,
    prompts: r.prompts ? JSON.parse(r.prompts as string) : null,
    updated_at: iso(r.updated_at)!,
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
    started_at: iso(r.started_at),
    completed_at: iso(r.completed_at),
    created_at: iso(r.created_at)!,
  };
}

export const pgStore: Store = {
  async createProject(input) {
    const sql = await db();
    const id = crypto.randomUUID();
    await sql`INSERT INTO projects (id, name, brand, competitors, category, audience, user_id, reason_taxonomy)
      VALUES (${id}, ${input.name}, ${input.brand}, ${JSON.stringify(input.competitors)}, ${input.category}, ${input.audience}, ${input.userId}, ${JSON.stringify(input.reasonTaxonomy)})`;
    return (await this.getProject(id))!;
  },

  async getDictionary(projectId) {
    const sql = await db();
    const rows =
      await sql`SELECT * FROM dictionary_entries WHERE project_id = ${projectId} ORDER BY canonical`;
    return rows.map(rowToDictEntry);
  },

  async upsertDictionaryEntry(input) {
    const sql = await db();
    const id = input.id ?? crypto.randomUUID();
    const aliases = JSON.stringify(input.aliases);
    const display = input.displayName ?? null;
    await sql`INSERT INTO dictionary_entries (id, project_id, canonical, aliases, status, display_name)
      VALUES (${id}, ${input.projectId}, ${input.canonical}, ${aliases}, ${input.status}, ${display})
      ON CONFLICT (id) DO UPDATE SET
        canonical = ${input.canonical}, aliases = ${aliases},
        status = ${input.status},
        display_name = COALESCE(${display}, dictionary_entries.display_name),
        version = dictionary_entries.version + 1`;
    const rows = await sql`SELECT * FROM dictionary_entries WHERE id = ${id}`;
    return rowToDictEntry(rows[0]);
  },

  async queueDictionaryCandidates(projectId, names) {
    const sql = await db();
    const existing = new Set<string>();
    for (const e of await this.getDictionary(projectId)) {
      existing.add(e.canonical.trim().toLowerCase());
      for (const a of e.aliases) existing.add(a);
    }
    for (const raw of names) {
      const norm = raw.trim().toLowerCase();
      if (!norm || existing.has(norm)) continue;
      existing.add(norm);
      await sql`INSERT INTO dictionary_entries (id, project_id, canonical, aliases, status)
        VALUES (${crypto.randomUUID()}, ${projectId}, ${raw.trim()}, '[]', 'pending')`;
    }
  },

  async bumpDictionaryVersion(projectId) {
    const sql = await db();
    const rows = await sql`UPDATE projects
      SET dictionary_version = dictionary_version + 1
      WHERE id = ${projectId}
      RETURNING dictionary_version`;
    return rows[0].dictionary_version as number;
  },

  async getProject(id) {
    const sql = await db();
    const rows = await sql`SELECT * FROM projects WHERE id = ${id}`;
    return rows.length > 0 ? rowToProject(rows[0]) : null;
  },

  async listProjects(userId) {
    const sql = await db();
    const rows =
      userId === undefined
        ? await sql`SELECT * FROM projects ORDER BY created_at DESC`
        : await sql`SELECT * FROM projects WHERE user_id = ${userId} ORDER BY created_at DESC`;
    return rows.map(rowToProject);
  },

  async getPlan(userId) {
    const sql = await db();
    const rows =
      await sql`SELECT plan FROM user_plans WHERE user_id = ${userId}`;
    return (rows[0]?.plan as "free" | "pro" | "enterprise") ?? "free";
  },

  async cacheGet(key, maxAgeMs) {
    const sql = await db();
    const cutoff = new Date(Date.now() - maxAgeMs);
    const rows =
      await sql`SELECT value FROM llm_cache WHERE key = ${key} AND created_at > ${cutoff}`;
    return (rows[0]?.value as string | undefined) ?? null;
  },

  async cacheSet(key, value) {
    const sql = await db();
    await sql`INSERT INTO llm_cache (key, value, created_at)
      VALUES (${key}, ${value}, now())
      ON CONFLICT (key) DO UPDATE SET value = ${value}, created_at = now()`;
  },

  async saveSetupDraft(input) {
    const sql = await db();
    const id = input.id ?? crypto.randomUUID();
    const competitors = JSON.stringify(input.competitors);
    const prompts = input.prompts ? JSON.stringify(input.prompts) : null;
    await sql`INSERT INTO setup_drafts (id, user_id, brand, category, competitors, audience, prompts, updated_at)
      VALUES (${id}, ${input.userId}, ${input.brand}, ${input.category}, ${competitors}, ${input.audience}, ${prompts}, now())
      ON CONFLICT (id) DO UPDATE SET
        brand = ${input.brand}, category = ${input.category},
        competitors = ${competitors}, audience = ${input.audience},
        prompts = ${prompts}, updated_at = now()`;
    return (await this.getSetupDraft(id))!;
  },

  async getSetupDraft(id) {
    const sql = await db();
    const rows = await sql`SELECT * FROM setup_drafts WHERE id = ${id}`;
    return rows.length > 0 ? rowToDraft(rows[0]) : null;
  },

  async listSetupDrafts(userId) {
    const sql = await db();
    const rows =
      userId === null
        ? await sql`SELECT * FROM setup_drafts WHERE user_id IS NULL ORDER BY updated_at DESC`
        : await sql`SELECT * FROM setup_drafts WHERE user_id = ${userId} ORDER BY updated_at DESC`;
    return rows.map(rowToDraft);
  },

  async deleteSetupDraft(id) {
    const sql = await db();
    await sql`DELETE FROM setup_drafts WHERE id = ${id}`;
  },

  async updateProjectSchedule(id, schedule) {
    const sql = await db();
    await sql`UPDATE projects SET schedule = ${schedule} WHERE id = ${id}`;
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
    await sql`INSERT INTO runs (id, project_id, model, repeats, status)
      VALUES (${id}, ${input.projectId}, ${input.model}, ${input.repeats}, 'pending')`;
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
    const c = input.coding;
    await sql.begin(async (tx) => {
      // DO NOTHING + unique(run, prompt, repeat): overlapping chunk workers
      // can race on the same task; only the first insert lands.
      const res = await tx`INSERT INTO responses (
          id, run_id, prompt_id, repeat_idx, text,
          top_pick_brand, outcome, reason_codes, clarification_requested,
          gives_recommendation, includes_prices, includes_specs,
          total_recommendations, focus_quote, focus_interpretation
        ) VALUES (
          ${responseId}, ${input.runId}, ${input.promptId}, ${input.repeatIdx}, ${input.text},
          ${c?.top_pick_brand ?? null}, ${c?.outcome ?? null},
          ${c ? c.reasons.join("|") : null},
          ${c ? (c.clarification_requested ? 1 : 0) : null},
          ${c ? (c.gives_recommendation ? 1 : 0) : null},
          ${c ? (c.includes_prices ? 1 : 0) : null},
          ${c ? (c.includes_specs ? 1 : 0) : null},
          ${c?.total_recommendations ?? null},
          ${c?.focus_quote ?? null}, ${c?.focus_interpretation ?? null}
        )
        ON CONFLICT (run_id, prompt_id, repeat_idx) DO NOTHING`;
      if (res.count === 0) return;
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
          top_pick_brand: r.top_pick_brand ?? null,
          outcome: r.outcome ?? null,
          reason_codes: r.reason_codes ?? null,
          clarification_requested: r.clarification_requested ?? null,
          gives_recommendation: r.gives_recommendation ?? null,
          includes_prices: r.includes_prices ?? null,
          includes_specs: r.includes_specs ?? null,
          total_recommendations: r.total_recommendations ?? null,
          focus_quote: r.focus_quote ?? null,
          focus_interpretation: r.focus_interpretation ?? null,
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
