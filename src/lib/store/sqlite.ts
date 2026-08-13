import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type {
  AnswerLabel,
  DictionaryEntry,
  Framing,
  Org,
  OrgMember,
  Project,
  Prompt,
  Run,
  ResponseRow,
  MentionRow,
  SetupDraft,
  Store,
} from "../types";
import { codingColumns } from "../coding_columns";
import { matchKey } from "../brand_key";

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
      reason_taxonomy TEXT NOT NULL DEFAULT '[]',
      engine_set TEXT NOT NULL DEFAULT '[]',
      org_id TEXT,
      dictionary_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS dictionary_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      canonical TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      confirmed_aliases TEXT NOT NULL DEFAULT '[]',
      parent TEXT,
      role TEXT,
      version INTEGER NOT NULL DEFAULT 1,
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
    CREATE TABLE IF NOT EXISTS setup_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      brand TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      competitors TEXT NOT NULL DEFAULT '[]',
      audience TEXT,
      prompts TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      text TEXT NOT NULL,
      theme TEXT NOT NULL,
      flagged INTEGER NOT NULL DEFAULT 0,
      flag_reason TEXT,
      suggested_alternatives TEXT NOT NULL DEFAULT '[]',
      retired INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      model TEXT NOT NULL,
      models TEXT NOT NULL DEFAULT '[]',
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
      model TEXT,
      finish_reason TEXT,
      citations TEXT,
      coder_model TEXT,
      search_count INTEGER,
      text TEXT NOT NULL,
      top_pick_brand TEXT,
      outcome TEXT,
      reason_codes TEXT,
      clarification_requested INTEGER,
      gives_recommendation INTEGER,
      includes_prices INTEGER,
      includes_specs INTEGER,
      total_recommendations INTEGER,
      focus_quote TEXT,
      focus_interpretation TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS org_members (
      org_id TEXT NOT NULL REFERENCES orgs(id),
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (org_id, email)
    );
    CREATE TABLE IF NOT EXISTS staff_users (
      email TEXT PRIMARY KEY
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
  if (!cols.some((c) => c.name === "org_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN org_id TEXT");
  }
  if (!cols.some((c) => c.name === "evidence_drawer")) {
    db.exec(
      "ALTER TABLE projects ADD COLUMN evidence_drawer INTEGER NOT NULL DEFAULT 1"
    );
  }
  if (!cols.some((c) => c.name === "human_override")) {
    db.exec(
      "ALTER TABLE projects ADD COLUMN human_override INTEGER NOT NULL DEFAULT 0"
    );
  }
  db.exec(`CREATE TABLE IF NOT EXISTS answer_labels (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    response_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    brand_norm TEXT NOT NULL,
    brand TEXT NOT NULL,
    verdict INTEGER NOT NULL,
    labeled_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (response_id, metric, brand_norm)
  )`);
  if (!cols.some((c) => c.name === "engine_set")) {
    db.exec(
      "ALTER TABLE projects ADD COLUMN engine_set TEXT NOT NULL DEFAULT '[]'"
    );
  }
  if (!cols.some((c) => c.name === "reason_taxonomy")) {
    db.exec(
      "ALTER TABLE projects ADD COLUMN reason_taxonomy TEXT NOT NULL DEFAULT '[]'"
    );
    db.exec(
      "ALTER TABLE projects ADD COLUMN dictionary_version INTEGER NOT NULL DEFAULT 1"
    );
  }
  const dictCols = db.prepare("PRAGMA table_info(dictionary_entries)").all() as {
    name: string;
  }[];
  if (dictCols.length > 0 && !dictCols.some((c) => c.name === "display_name")) {
    db.exec("ALTER TABLE dictionary_entries ADD COLUMN display_name TEXT");
  }
  if (
    dictCols.length > 0 &&
    !dictCols.some((c) => c.name === "confirmed_aliases")
  ) {
    db.exec(
      "ALTER TABLE dictionary_entries ADD COLUMN confirmed_aliases TEXT NOT NULL DEFAULT '[]'"
    );
  }
  if (dictCols.length > 0 && !dictCols.some((c) => c.name === "parent")) {
    db.exec("ALTER TABLE dictionary_entries ADD COLUMN parent TEXT");
  }
  if (dictCols.length > 0 && !dictCols.some((c) => c.name === "role")) {
    db.exec("ALTER TABLE dictionary_entries ADD COLUMN role TEXT");
  }
  const promptCols = db.prepare("PRAGMA table_info(prompts)").all() as {
    name: string;
  }[];
  if (!promptCols.some((c) => c.name === "flagged")) {
    for (const ddl of [
      "ALTER TABLE prompts ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE prompts ADD COLUMN flag_reason TEXT",
      "ALTER TABLE prompts ADD COLUMN suggested_alternatives TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE prompts ADD COLUMN retired INTEGER NOT NULL DEFAULT 0",
    ]) {
      db.exec(ddl);
    }
  }
  const respCols = db.prepare("PRAGMA table_info(responses)").all() as {
    name: string;
  }[];
  if (!respCols.some((c) => c.name === "top_pick_brand")) {
    for (const ddl of [
      "ALTER TABLE responses ADD COLUMN top_pick_brand TEXT",
      "ALTER TABLE responses ADD COLUMN outcome TEXT",
      "ALTER TABLE responses ADD COLUMN reason_codes TEXT",
      "ALTER TABLE responses ADD COLUMN clarification_requested INTEGER",
      "ALTER TABLE responses ADD COLUMN gives_recommendation INTEGER",
      "ALTER TABLE responses ADD COLUMN includes_prices INTEGER",
      "ALTER TABLE responses ADD COLUMN includes_specs INTEGER",
      "ALTER TABLE responses ADD COLUMN total_recommendations INTEGER",
      "ALTER TABLE responses ADD COLUMN focus_quote TEXT",
      "ALTER TABLE responses ADD COLUMN focus_interpretation TEXT",
    ]) {
      db.exec(ddl);
    }
  }
  // Multi-engine: a task is prompt × repeat × ENGINE. Backfill the model on
  // pre-multi-engine rows from their run, then key the index on it.
  if (!respCols.some((c) => c.name === "finish_reason")) {
    db.exec("ALTER TABLE responses ADD COLUMN finish_reason TEXT");
  }
  if (!respCols.some((c) => c.name === "citations")) {
    db.exec("ALTER TABLE responses ADD COLUMN citations TEXT");
  }
  if (!respCols.some((c) => c.name === "coder_model")) {
    db.exec("ALTER TABLE responses ADD COLUMN coder_model TEXT");
  }
  if (!respCols.some((c) => c.name === "search_count")) {
    db.exec("ALTER TABLE responses ADD COLUMN search_count INTEGER");
  }
  if (!respCols.some((c) => c.name === "model")) {
    db.exec("ALTER TABLE responses ADD COLUMN model TEXT");
    db.exec(
      "UPDATE responses SET model = (SELECT model FROM runs WHERE runs.id = responses.run_id) WHERE model IS NULL"
    );
  }
  const runCols = db.prepare("PRAGMA table_info(runs)").all() as {
    name: string;
  }[];
  if (!runCols.some((c) => c.name === "models")) {
    db.exec("ALTER TABLE runs ADD COLUMN models TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec(
    "INSERT OR IGNORE INTO staff_users (email) VALUES ('tyler@resondex.com')"
  );
  db.exec("DROP INDEX IF EXISTS idx_responses_task");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_task_engine ON responses(run_id, prompt_id, repeat_idx, model)"
  );
  return db;
}

/** Runs predating multi-engine have no models array — fall back to their
 * single model so every consumer can treat runs uniformly. */
function parseRun(row: Record<string, unknown>): Run {
  let models: string[] = [];
  try {
    const v = JSON.parse((row.models as string) ?? "[]");
    if (Array.isArray(v)) models = v;
  } catch {
    models = [];
  }
  return {
    ...(row as unknown as Run),
    models: models.length > 0 ? models : [row.model as string],
  };
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
    engine_set: JSON.parse((row as unknown as { engine_set?: string }).engine_set ?? "[]"),
    schedule: row.schedule ?? "none",
    reason_taxonomy: JSON.parse(
      (row as unknown as { reason_taxonomy?: string }).reason_taxonomy ?? "[]"
    ),
    dictionary_version:
      (row as unknown as { dictionary_version?: number }).dictionary_version ?? 1,
    evidence_drawer:
      (row as unknown as { evidence_drawer?: number }).evidence_drawer ?? 1,
    human_override:
      (row as unknown as { human_override?: number }).human_override ?? 0,
  };
}

function parseDictEntry(row: Record<string, unknown>): DictionaryEntry {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    canonical: row.canonical as string,
    aliases: JSON.parse((row.aliases as string) ?? "[]"),
    display_name: (row.display_name as string | null) ?? null,
    status: row.status as DictionaryEntry["status"],
    confirmed: JSON.parse((row.confirmed_aliases as string) ?? "[]"),
    parent: (row.parent as string | null) ?? null,
    role: (row.role as DictionaryEntry["role"]) ?? null,
    version: (row.version as number) ?? 1,
    created_at: row.created_at as string,
  };
}

function parseDraft(row: Record<string, string | null>): SetupDraft {
  return {
    id: row.id!,
    user_id: row.user_id ?? null,
    brand: row.brand!,
    category: row.category ?? "",
    competitors: JSON.parse(row.competitors ?? "[]"),
    audience: row.audience ?? null,
    prompts: row.prompts ? JSON.parse(row.prompts) : null,
    updated_at: row.updated_at!,
  };
}

function writeMentions(
  db: ReturnType<typeof getDb>,
  responseId: string,
  mentions: { brand: string; framing: Framing }[]
): void {
  const stmt = db.prepare(
    `INSERT INTO mentions (id, response_id, brand, brand_norm, rank, framing)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  mentions.forEach((m, i) => {
    stmt.run(crypto.randomUUID(), responseId, m.brand, matchKey(m.brand), i + 1, m.framing);
  });
}

export const sqliteStore: Store = {
  async createProject(input) {
    const id = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO projects (id, name, brand, competitors, category, audience, user_id, reason_taxonomy, engine_set)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.brand,
        JSON.stringify(input.competitors),
        input.category,
        input.audience,
        input.userId,
        JSON.stringify(input.reasonTaxonomy),
        JSON.stringify(input.engineSet)
      );
    return (await this.getProject(id))!;
  },

  async getDictionary(projectId) {
    return (
      getDb()
        .prepare(
          "SELECT * FROM dictionary_entries WHERE project_id = ? ORDER BY canonical"
        )
        .all(projectId) as Record<string, unknown>[]
    ).map(parseDictEntry);
  },

  async setDictionaryParent(entryId, parent) {
    getDb()
      .prepare("UPDATE dictionary_entries SET parent = ? WHERE id = ?")
      .run(parent, entryId);
  },

  async renameDictionaryParent(projectId, from, to) {
    getDb()
      .prepare(
        "UPDATE dictionary_entries SET parent = ? WHERE project_id = ? AND parent = ?"
      )
      .run(to, projectId, from);
  },

  async createOrg(name) {
    const id = crypto.randomUUID();
    getDb().prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run(id, name);
    return getDb().prepare("SELECT * FROM orgs WHERE id = ?").get(id) as Org;
  },

  async listOrgs() {
    return getDb().prepare("SELECT * FROM orgs ORDER BY name").all() as Org[];
  },

  async listOrgMembers(orgId) {
    return getDb()
      .prepare("SELECT * FROM org_members WHERE org_id = ? ORDER BY email")
      .all(orgId) as OrgMember[];
  },

  async upsertOrgMember(orgId, email, role) {
    getDb()
      .prepare(
        `INSERT INTO org_members (org_id, email, role) VALUES (?, ?, ?)
         ON CONFLICT(org_id, email) DO UPDATE SET role = excluded.role`
      )
      .run(orgId, email.toLowerCase(), role);
  },

  async removeOrgMember(orgId, email) {
    getDb()
      .prepare("DELETE FROM org_members WHERE org_id = ? AND email = ?")
      .run(orgId, email.toLowerCase());
  },

  async listMembershipsForEmail(email) {
    return getDb()
      .prepare("SELECT * FROM org_members WHERE email = ?")
      .all(email.toLowerCase()) as OrgMember[];
  },

  async setProjectOrg(projectId, orgId) {
    getDb()
      .prepare("UPDATE projects SET org_id = ? WHERE id = ?")
      .run(orgId, projectId);
  },

  async listProjectsByOrgIds(orgIds) {
    if (orgIds.length === 0) return [];
    const marks = orgIds.map(() => "?").join(",");
    return (
      getDb()
        .prepare(
          `SELECT * FROM projects WHERE org_id IN (${marks}) ORDER BY created_at DESC`
        )
        .all(...orgIds) as ProjectRaw[]
    ).map(parseProject);
  },

  async isStaffEmail(email) {
    return Boolean(
      getDb()
        .prepare("SELECT 1 FROM staff_users WHERE email = ?")
        .get(email.toLowerCase())
    );
  },

  async listStaff() {
    return (
      getDb().prepare("SELECT email FROM staff_users ORDER BY email").all() as {
        email: string;
      }[]
    ).map((r) => r.email);
  },

  async addStaff(email) {
    getDb()
      .prepare("INSERT OR IGNORE INTO staff_users (email) VALUES (?)")
      .run(email.toLowerCase());
  },

  async removeStaff(email) {
    getDb()
      .prepare("DELETE FROM staff_users WHERE email = ?")
      .run(email.toLowerCase());
  },

  async confirmDictionaryNames(projectId, names) {
    const db = getDb();
    const norms = new Set(names.map((n) => n.trim().toLowerCase()));
    const rows = db
      .prepare("SELECT * FROM dictionary_entries WHERE project_id = ?")
      .all(projectId) as Record<string, unknown>[];
    const update = db.prepare(
      "UPDATE dictionary_entries SET confirmed_aliases = ? WHERE id = ?"
    );
    const apply = db.transaction(() => {
      for (const row of rows) {
        const e = parseDictEntry(row);
        const owned = [e.canonical.trim().toLowerCase(), ...e.aliases];
        const add = owned.filter((n) => norms.has(n));
        if (add.length === 0) continue;
        const next = [...new Set([...e.confirmed, ...add])];
        if (next.length !== e.confirmed.length) {
          update.run(JSON.stringify(next), e.id);
        }
      }
    });
    apply();
  },

  async insertDictionaryEntries(projectId, entries) {
    const db = getDb();
    const stmt = db.prepare(
      "INSERT INTO dictionary_entries (id, project_id, canonical, aliases, status, role) VALUES (?, ?, ?, ?, 'active', ?)"
    );
    const insertAll = db.transaction(() => {
      for (const e of entries) {
        stmt.run(
          crypto.randomUUID(),
          projectId,
          e.canonical,
          JSON.stringify(e.aliases),
          e.role ?? null
        );
      }
    });
    insertAll();
  },

  async setDictionaryRole(entryId, role) {
    getDb()
      .prepare("UPDATE dictionary_entries SET role = ? WHERE id = ?")
      .run(role, entryId);
  },

  async upsertDictionaryEntry(input) {
    const id = input.id ?? crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO dictionary_entries (id, project_id, canonical, aliases, status, display_name)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           canonical = excluded.canonical, aliases = excluded.aliases,
           status = excluded.status,
           display_name = COALESCE(excluded.display_name, dictionary_entries.display_name),
           version = dictionary_entries.version + 1`
      )
      .run(
        id,
        input.projectId,
        input.canonical,
        JSON.stringify(input.aliases),
        input.status,
        input.displayName ?? null
      );
    const row = getDb()
      .prepare("SELECT * FROM dictionary_entries WHERE id = ?")
      .get(id) as Record<string, unknown>;
    return parseDictEntry(row);
  },

  async queueDictionaryCandidates(projectId, names) {
    const db = getDb();
    const existing = new Set<string>();
    for (const e of await this.getDictionary(projectId)) {
      existing.add(e.canonical.trim().toLowerCase());
      for (const a of e.aliases) existing.add(a);
    }
    const stmt = db.prepare(
      `INSERT INTO dictionary_entries (id, project_id, canonical, aliases, status)
       VALUES (?, ?, ?, '[]', 'pending')`
    );
    for (const raw of names) {
      const norm = raw.trim().toLowerCase();
      if (!norm || existing.has(norm)) continue;
      existing.add(norm);
      stmt.run(crypto.randomUUID(), projectId, raw.trim());
    }
  },

  async bumpDictionaryVersion(projectId) {
    getDb()
      .prepare(
        "UPDATE projects SET dictionary_version = dictionary_version + 1 WHERE id = ?"
      )
      .run(projectId);
    const row = getDb()
      .prepare("SELECT dictionary_version FROM projects WHERE id = ?")
      .get(projectId) as { dictionary_version: number };
    return row.dictionary_version;
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
              "SELECT * FROM projects WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC"
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

  async saveSetupDraft(input) {
    const id = input.id ?? crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO setup_drafts (id, user_id, brand, category, competitors, audience, prompts, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           brand = excluded.brand, category = excluded.category,
           competitors = excluded.competitors, audience = excluded.audience,
           prompts = excluded.prompts, updated_at = datetime('now')`
      )
      .run(
        id,
        input.userId,
        input.brand,
        input.category,
        JSON.stringify(input.competitors),
        input.audience,
        input.prompts ? JSON.stringify(input.prompts) : null
      );
    return (await this.getSetupDraft(id))!;
  },

  async getSetupDraft(id) {
    const row = getDb()
      .prepare("SELECT * FROM setup_drafts WHERE id = ?")
      .get(id) as Record<string, string | null> | undefined;
    return row ? parseDraft(row) : null;
  },

  async listSetupDrafts(userId) {
    const rows = (
      userId === null
        ? getDb()
            .prepare(
              "SELECT * FROM setup_drafts WHERE user_id IS NULL ORDER BY updated_at DESC"
            )
            .all()
        : getDb()
            .prepare(
              "SELECT * FROM setup_drafts WHERE user_id = ? ORDER BY updated_at DESC"
            )
            .all(userId)
    ) as Record<string, string | null>[];
    return rows.map(parseDraft);
  },

  async deleteSetupDraft(id) {
    getDb().prepare("DELETE FROM setup_drafts WHERE id = ?").run(id);
  },

  async updateProjectSchedule(id, schedule) {
    getDb()
      .prepare("UPDATE projects SET schedule = ? WHERE id = ?")
      .run(schedule, id);
  },

  async updateProjectFlags(id, flags) {
    const db = getDb();
    if (flags.evidenceDrawer !== undefined) {
      db.prepare("UPDATE projects SET evidence_drawer = ? WHERE id = ?")
        .run(flags.evidenceDrawer ? 1 : 0, id);
    }
    if (flags.humanOverride !== undefined) {
      db.prepare("UPDATE projects SET human_override = ? WHERE id = ?")
        .run(flags.humanOverride ? 1 : 0, id);
    }
  },

  async upsertAnswerLabel(input) {
    getDb()
      .prepare(
        `INSERT INTO answer_labels
           (id, project_id, response_id, metric, brand_norm, brand, verdict, labeled_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (response_id, metric, brand_norm) DO UPDATE SET
           verdict = excluded.verdict,
           brand = excluded.brand,
           labeled_by = excluded.labeled_by`
      )
      .run(
        crypto.randomUUID(),
        input.projectId,
        input.responseId,
        input.metric,
        input.brandNorm,
        input.brand,
        input.verdict ? 1 : 0,
        input.labeledBy
      );
  },

  async listLabelsForRun(runId) {
    return getDb()
      .prepare(
        `SELECT l.* FROM answer_labels l
           JOIN responses r ON r.id = l.response_id
          WHERE r.run_id = ?`
      )
      .all(runId) as AnswerLabel[];
  },

  async updateProjectEngineSet(id, engineSet) {
    getDb()
      .prepare("UPDATE projects SET engine_set = ? WHERE id = ?")
      .run(JSON.stringify(engineSet), id);
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
    const rows = getDb()
      .prepare("SELECT * FROM prompts WHERE project_id = ? ORDER BY rowid")
      .all(projectId) as (Omit<Prompt, "suggested_alternatives"> & {
      suggested_alternatives: string;
    })[];
    return rows.map((r) => ({
      ...r,
      suggested_alternatives: JSON.parse(r.suggested_alternatives ?? "[]"),
    }));
  },

  async setPromptFlag(promptId, flag) {
    getDb()
      .prepare(
        "UPDATE prompts SET flagged = ?, flag_reason = ?, suggested_alternatives = ? WHERE id = ?"
      )
      .run(
        flag ? 1 : 0,
        flag?.reason ?? null,
        JSON.stringify(flag?.alternatives ?? []),
        promptId
      );
  },

  async retirePrompt(promptId) {
    getDb().prepare("UPDATE prompts SET retired = 1 WHERE id = ?").run(promptId);
  },

  async createRun(input) {
    const id = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO runs (id, project_id, model, models, repeats, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        id,
        input.projectId,
        (input.models && input.models[0]) || input.model,
        JSON.stringify(
          input.models && input.models.length > 0 ? input.models : [input.model]
        ),
        input.repeats
      );
    return (await this.getRun(id))!;
  },

  async getRun(id) {
    const row = getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? parseRun(row) : null;
  },

  async listRuns(projectId) {
    return (
      getDb()
        .prepare(
          "SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC"
        )
        .all(projectId) as Record<string, unknown>[]
    ).map(parseRun);
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
    // Columns are derived from the shared coding shape, never hand-written,
    // so insert and recode cannot drift. See lib/coding_columns.ts.
    const row: Record<string, unknown> = {
      id: responseId,
      run_id: input.runId,
      prompt_id: input.promptId,
      repeat_idx: input.repeatIdx,
      model: input.model,
      finish_reason: input.finishReason ?? null,
      citations: input.citations ? JSON.stringify(input.citations) : null,
      search_count: input.searchCount ?? null,
      text: input.text,
      ...codingColumns(input.coding, input.coderModel ?? null),
    };
    const cols = Object.keys(row);
    const insertAll = db.transaction(() => {
      // OR IGNORE + unique(run, prompt, repeat): overlapping chunk workers
      // can race on the same task; only the first insert lands.
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO responses (${cols.join(", ")})
           VALUES (${cols.map(() => "?").join(", ")})`
        )
        .run(...cols.map((k) => row[k]));
      if (info.changes === 0) return;
      writeMentions(db, responseId, input.mentions);
    });
    insertAll();
  },

  async writeResponseCoding(responseId, coding, coderModel, mentions) {
    const db = getDb();
    const cols = codingColumns(coding, coderModel) as unknown as Record<string, unknown>;
    const keys = Object.keys(cols);
    db.transaction(() => {
      db.prepare(
        `UPDATE responses SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`
      ).run(...keys.map((k) => cols[k]), responseId);
      db.prepare("DELETE FROM mentions WHERE response_id = ?").run(responseId);
      writeMentions(db, responseId, mentions);
    })();
  },

  async deleteRun(runId) {
    const db = getDb();
    const del = db.transaction(() => {
      db.prepare(
        "DELETE FROM mentions WHERE response_id IN (SELECT id FROM responses WHERE run_id = ?)"
      ).run(runId);
      db.prepare("DELETE FROM responses WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    });
    del();
  },

  async deleteProject(projectId) {
    const db = getDb();
    const del = db.transaction(() => {
      db.prepare(
        `DELETE FROM mentions WHERE response_id IN (
           SELECT r.id FROM responses r JOIN runs ru ON ru.id = r.run_id
           WHERE ru.project_id = ?)`
      ).run(projectId);
      db.prepare(
        "DELETE FROM responses WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)"
      ).run(projectId);
      db.prepare("DELETE FROM runs WHERE project_id = ?").run(projectId);
      db.prepare("DELETE FROM prompts WHERE project_id = ?").run(projectId);
      db.prepare("DELETE FROM dictionary_entries WHERE project_id = ?").run(
        projectId
      );
      db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    });
    del();
  },

  async countResponses(runId) {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM responses WHERE run_id = ?")
      .get(runId) as { n: number };
    return row.n;
  },

  async countResponsesByModel(runId) {
    const rows = getDb()
      .prepare(
        "SELECT model, COUNT(*) AS n FROM responses WHERE run_id = ? GROUP BY model"
      )
      .all(runId) as { model: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.model, r.n]));
  },

  async listResponses(runId) {
    return (
      getDb()
        .prepare("SELECT * FROM responses WHERE run_id = ? ORDER BY rowid")
        .all(runId) as Record<string, unknown>[]
    ).map(
      (r) =>
        ({
          ...r,
          model: (r.model as string) ?? "",
          finish_reason: (r.finish_reason as string | null) ?? null,
          citations: r.citations ? JSON.parse(r.citations as string) : null,
          coder_model: (r.coder_model as string | null) ?? null,
          search_count: (r.search_count as number | null) ?? null,
        }) as ResponseRow
    );
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
