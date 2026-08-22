import postgres from "postgres";
import type { TransactionSql } from "postgres";
import type {
  AnswerLabel,
  CodingAssignment,
  DictionaryEntry,
  Framing,
  HumanCode,
  Intent,
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

declare global {
  // eslint-disable-next-line no-var
  var __procerno_sql: ReturnType<typeof postgres> | undefined;
  // eslint-disable-next-line no-var
  var __procerno_schema: Promise<void> | undefined;
}

function getSql() {
  if (!globalThis.__procerno_sql) {
    const url = process.env.DATABASE_URL!;
    // Hosted poolers (Supabase supavisor) expect TLS; local dev databases
    // usually don't have certs. prepare:false is required for
    // transaction-mode poolers.
    const local = /localhost|127\.0\.0\.1/.test(url);
    globalThis.__procerno_sql = postgres(url, {
      prepare: false,
      max: 5,
      ssl: local ? undefined : "require",
    });
  }
  return globalThis.__procerno_sql;
}

function ensureSchema(): Promise<void> {
  if (!globalThis.__procerno_schema) {
    const sql = getSql();
    globalThis.__procerno_schema = (async () => {
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
      await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS engine_set TEXT NOT NULL DEFAULT '[]'`;
      await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS org_id TEXT`;
      await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS evidence_drawer INTEGER NOT NULL DEFAULT 1`;
      await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS human_override INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS moderators TEXT`;
      await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS instrument_version INTEGER NOT NULL DEFAULT 0`;
      await sql`CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        layer TEXT NOT NULL,
        situation TEXT,
        angle TEXT NOT NULL,
        text TEXT NOT NULL,
        seq SERIAL
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_intents_project ON intents (project_id)`;
      await sql`ALTER TABLE prompts ADD COLUMN IF NOT EXISTS intent_id TEXT`;
      await sql`CREATE TABLE IF NOT EXISTS answer_labels (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        response_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        brand_norm TEXT NOT NULL,
        brand TEXT NOT NULL,
        verdict INTEGER NOT NULL,
        labeled_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (response_id, metric, brand_norm)
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_labels_project ON answer_labels (project_id)`;
      await sql`CREATE TABLE IF NOT EXISTS coding_assignments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        metric TEXT NOT NULL,
        items TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_codings_project ON coding_assignments (project_id)`;
      await sql`CREATE TABLE IF NOT EXISTS human_codes (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        response_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        brand_norm TEXT NOT NULL,
        brand TEXT NOT NULL,
        verdict INTEGER NOT NULL,
        coder TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (assignment_id, response_id, metric, brand_norm, coder)
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_human_codes_assignment ON human_codes (assignment_id)`;
      await sql`CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS org_members (
        org_id TEXT NOT NULL REFERENCES orgs(id),
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, email)
      )`;
      await sql`CREATE TABLE IF NOT EXISTS staff_users (
        email TEXT PRIMARY KEY
      )`;
      await sql`INSERT INTO staff_users (email) VALUES (${"tyler@resondex.com"}) ON CONFLICT DO NOTHING`;
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
      await sql`ALTER TABLE dictionary_entries ADD COLUMN IF NOT EXISTS confirmed_aliases TEXT NOT NULL DEFAULT '[]'`;
      await sql`ALTER TABLE dictionary_entries ADD COLUMN IF NOT EXISTS parent TEXT`;
      await sql`ALTER TABLE dictionary_entries ADD COLUMN IF NOT EXISTS role TEXT`;
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
      await sql`ALTER TABLE setup_drafts ADD COLUMN IF NOT EXISTS wizard TEXT`;
      await sql`CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        text TEXT NOT NULL,
        theme TEXT NOT NULL,
        seq SERIAL
      )`;
      await sql`ALTER TABLE prompts ADD COLUMN IF NOT EXISTS flagged INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE prompts ADD COLUMN IF NOT EXISTS flag_reason TEXT`;
      await sql`ALTER TABLE prompts ADD COLUMN IF NOT EXISTS suggested_alternatives TEXT NOT NULL DEFAULT '[]'`;
      await sql`ALTER TABLE prompts ADD COLUMN IF NOT EXISTS retired INTEGER NOT NULL DEFAULT 0`;
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
      // Multi-engine: a task is prompt × repeat × ENGINE. Backfill the model
      // on pre-multi-engine rows from their run, then re-key the index.
      await sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS models TEXT NOT NULL DEFAULT '[]'`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS model TEXT`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS finish_reason TEXT`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS citations TEXT`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS coder_model TEXT`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS search_count INTEGER`;
      await sql`UPDATE responses r SET model = ru.model FROM runs ru
        WHERE r.run_id = ru.id AND (r.model IS NULL OR r.model = '')`;
      await sql`DROP INDEX IF EXISTS idx_responses_task`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_task_engine
        ON responses(run_id, prompt_id, repeat_idx, model)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_responses_run ON responses(run_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_mentions_response ON mentions(response_id)`;
      // The app reads and writes as the table owner over DATABASE_URL, which
      // bypasses RLS — but Supabase also exposes every public table through
      // its REST API to anyone holding the browser-public anon key. RLS with
      // no policies is the lock: owner unaffected, REST sees nothing. Runs on
      // every boot so a newly created table can never ship exposed.
      const bare = await sql`SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND NOT rowsecurity`;
      for (const t of bare) {
        await sql`ALTER TABLE public.${sql(t.tablename as string)} ENABLE ROW LEVEL SECURITY`;
      }
    })();
  }
  return globalThis.__procerno_schema;
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
    org_id: (r.org_id as string | null) ?? null,
    reason_taxonomy: JSON.parse((r.reason_taxonomy as string) ?? "[]"),
    engine_set: JSON.parse((r.engine_set as string) ?? "[]"),
    dictionary_version: (r.dictionary_version as number) ?? 1,
    evidence_drawer: (r.evidence_drawer as number) ?? 1,
    human_override: (r.human_override as number) ?? 0,
    moderators: (r.moderators as string | null) ?? null,
    instrument_version: (r.instrument_version as number) ?? 0,
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
    confirmed: JSON.parse((r.confirmed_aliases as string) ?? "[]"),
    parent: (r.parent as string | null) ?? null,
    role: (r.role as DictionaryEntry["role"]) ?? null,
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
    wizard: r.wizard ? JSON.parse(r.wizard as string) : null,
    updated_at: iso(r.updated_at)!,
  };
}

function rowToRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    model: r.model as string,
    models: (() => {
      try {
        const v = JSON.parse((r.models as string) ?? "[]");
        return Array.isArray(v) && v.length > 0 ? v : [r.model as string];
      } catch {
        return [r.model as string];
      }
    })(),
    repeats: r.repeats as number,
    status: r.status as Run["status"],
    error: (r.error as string | null) ?? null,
    started_at: iso(r.started_at),
    completed_at: iso(r.completed_at),
    created_at: iso(r.created_at)!,
  };
}

async function insertMentions(
  tx: TransactionSql<Record<string, never>>,
  responseId: string,
  mentions: { brand: string; framing: Framing }[]
): Promise<void> {
  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    await tx`INSERT INTO mentions (id, response_id, brand, brand_norm, rank, framing)
      VALUES (${crypto.randomUUID()}, ${responseId}, ${m.brand}, ${matchKey(m.brand)}, ${i + 1}, ${m.framing})`;
  }
}

export const pgStore: Store = {
  async createProject(input) {
    const sql = await db();
    const id = crypto.randomUUID();
    await sql`INSERT INTO projects (id, name, brand, competitors, category, audience, user_id, reason_taxonomy, engine_set, moderators, instrument_version)
      VALUES (${id}, ${input.name}, ${input.brand}, ${JSON.stringify(input.competitors)}, ${input.category}, ${input.audience}, ${input.userId}, ${JSON.stringify(input.reasonTaxonomy)}, ${JSON.stringify(input.engineSet)}, ${input.moderators ?? null}, ${input.instrumentVersion ?? 0})`;
    return (await this.getProject(id))!;
  },

  async getDictionary(projectId) {
    const sql = await db();
    const rows =
      await sql`SELECT * FROM dictionary_entries WHERE project_id = ${projectId} ORDER BY canonical`;
    return rows.map(rowToDictEntry);
  },

  async setDictionaryParent(entryId, parent) {
    const sql = await db();
    await sql`UPDATE dictionary_entries SET parent = ${parent} WHERE id = ${entryId}`;
  },

  async renameDictionaryParent(projectId, from, to) {
    const sql = await db();
    await sql`UPDATE dictionary_entries SET parent = ${to} WHERE project_id = ${projectId} AND parent = ${from}`;
  },

  async createOrg(name) {
    const sql = await db();
    const id = crypto.randomUUID();
    await sql`INSERT INTO orgs (id, name) VALUES (${id}, ${name})`;
    const [row] = await sql`SELECT * FROM orgs WHERE id = ${id}`;
    return { id: row.id, name: row.name, created_at: iso(row.created_at)! };
  },

  async listOrgs() {
    const sql = await db();
    const rows = await sql`SELECT * FROM orgs ORDER BY name`;
    return rows.map((r) => ({ id: r.id, name: r.name, created_at: iso(r.created_at)! }));
  },

  async listOrgMembers(orgId) {
    const sql = await db();
    const rows = await sql`SELECT * FROM org_members WHERE org_id = ${orgId} ORDER BY email`;
    return rows.map((r) => ({ org_id: r.org_id, email: r.email, role: r.role, created_at: iso(r.created_at)! }));
  },

  async upsertOrgMember(orgId, email, role) {
    const sql = await db();
    await sql`INSERT INTO org_members (org_id, email, role) VALUES (${orgId}, ${email.toLowerCase()}, ${role})
      ON CONFLICT (org_id, email) DO UPDATE SET role = ${role}`;
  },

  async removeOrgMember(orgId, email) {
    const sql = await db();
    await sql`DELETE FROM org_members WHERE org_id = ${orgId} AND email = ${email.toLowerCase()}`;
  },

  async listMembershipsForEmail(email) {
    const sql = await db();
    const rows = await sql`SELECT * FROM org_members WHERE email = ${email.toLowerCase()}`;
    return rows.map((r) => ({ org_id: r.org_id, email: r.email, role: r.role, created_at: iso(r.created_at)! }));
  },

  async setProjectOrg(projectId, orgId) {
    const sql = await db();
    await sql`UPDATE projects SET org_id = ${orgId} WHERE id = ${projectId}`;
  },

  async listProjectsByOrgIds(orgIds) {
    if (orgIds.length === 0) return [];
    const sql = await db();
    const rows = await sql`SELECT * FROM projects WHERE org_id = ANY(${orgIds}) ORDER BY created_at DESC`;
    return rows.map(rowToProject);
  },

  async isStaffEmail(email) {
    const sql = await db();
    const rows = await sql`SELECT 1 FROM staff_users WHERE email = ${email.toLowerCase()}`;
    return rows.length > 0;
  },

  async listStaff() {
    const sql = await db();
    const rows = await sql`SELECT email FROM staff_users ORDER BY email`;
    return rows.map((r) => r.email as string);
  },

  async addStaff(email) {
    const sql = await db();
    await sql`INSERT INTO staff_users (email) VALUES (${email.toLowerCase()}) ON CONFLICT DO NOTHING`;
  },

  async removeStaff(email) {
    const sql = await db();
    await sql`DELETE FROM staff_users WHERE email = ${email.toLowerCase()}`;
  },

  async confirmDictionaryNames(projectId, names) {
    const sql = await db();
    const norms = new Set(names.map((n) => n.trim().toLowerCase()));
    const rows =
      await sql`SELECT * FROM dictionary_entries WHERE project_id = ${projectId}`;
    await sql.begin(async (tx) => {
      for (const row of rows) {
        const e = rowToDictEntry(row);
        const owned = [e.canonical.trim().toLowerCase(), ...e.aliases];
        const add = owned.filter((n) => norms.has(n));
        if (add.length === 0) continue;
        const next = [...new Set([...e.confirmed, ...add])];
        if (next.length !== e.confirmed.length) {
          await tx`UPDATE dictionary_entries SET confirmed_aliases = ${JSON.stringify(next)} WHERE id = ${e.id}`;
        }
      }
    });
  },

  async insertDictionaryEntries(projectId, entries) {
    if (entries.length === 0) return;
    const sql = await db();
    const rows = entries.map((e) => ({
      id: crypto.randomUUID(),
      project_id: projectId,
      canonical: e.canonical,
      aliases: JSON.stringify(e.aliases),
      status: "active",
      role: e.role ?? null,
    }));
    await sql`INSERT INTO dictionary_entries ${sql(rows, "id", "project_id", "canonical", "aliases", "status", "role")}`;
  },

  async setDictionaryRole(entryId, role) {
    const sql = await db();
    await sql`UPDATE dictionary_entries SET role = ${role} WHERE id = ${entryId}`;
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
        : await sql`SELECT * FROM projects WHERE user_id = ${userId} OR user_id IS NULL ORDER BY created_at DESC`;
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

  async cachePurge(prefix, keep) {
    const sql = await db();
    await sql`DELETE FROM llm_cache
      WHERE key LIKE ${prefix + "%"} AND key NOT LIKE ${keep + "%"}`;
  },

  async labelsRevisionForRun(runId) {
    const sql = await db();
    const rows = await sql`SELECT count(*)::int AS n,
        coalesce(max(l.created_at)::text, '0') AS m
      FROM answer_labels l
      JOIN responses r ON r.id = l.response_id
      WHERE r.run_id = ${runId}`;
    return `${rows[0]?.n ?? 0}:${rows[0]?.m ?? "0"}`;
  },

  async createCodingAssignment(a) {
    const sql = await db();
    await sql`INSERT INTO coding_assignments
        (id, project_id, run_id, name, metric, items, token, created_by, created_at)
      VALUES (${a.id}, ${a.project_id}, ${a.run_id}, ${a.name}, ${a.metric},
        ${a.items}, ${a.token}, ${a.created_by}, now())`;
  },

  async getCodingAssignmentByToken(token) {
    const sql = await db();
    const rows =
      await sql`SELECT * FROM coding_assignments WHERE token = ${token}`;
    if (!rows[0]) return null;
    return {
      ...rows[0],
      created_at: new Date(rows[0].created_at as string).toISOString(),
    } as CodingAssignment;
  },

  async listCodingAssignments(projectId) {
    const sql = await db();
    const rows = await sql`SELECT * FROM coding_assignments
      WHERE project_id = ${projectId} ORDER BY created_at DESC`;
    return rows.map((r) => ({
      ...r,
      created_at: new Date(r.created_at as string).toISOString(),
    })) as CodingAssignment[];
  },

  async upsertHumanCode(c) {
    const sql = await db();
    await sql`INSERT INTO human_codes
        (id, assignment_id, response_id, metric, brand_norm, brand, verdict, coder)
      VALUES (${crypto.randomUUID()}, ${c.assignmentId}, ${c.responseId},
        ${c.metric}, ${c.brandNorm}, ${c.brand}, ${c.verdict ? 1 : 0}, ${c.coder})
      ON CONFLICT (assignment_id, response_id, metric, brand_norm, coder)
        DO UPDATE SET verdict = EXCLUDED.verdict, created_at = now()`;
  },

  async listHumanCodes(assignmentId) {
    const sql = await db();
    const rows = await sql`SELECT * FROM human_codes
      WHERE assignment_id = ${assignmentId} ORDER BY created_at`;
    return rows.map((r) => ({
      ...r,
      created_at: new Date(r.created_at as string).toISOString(),
    })) as HumanCode[];
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
    const wizard = input.wizard ? JSON.stringify(input.wizard) : null;
    await sql`INSERT INTO setup_drafts (id, user_id, brand, category, competitors, audience, prompts, wizard, updated_at)
      VALUES (${id}, ${input.userId}, ${input.brand}, ${input.category}, ${competitors}, ${input.audience}, ${prompts}, ${wizard}, now())
      ON CONFLICT (id) DO UPDATE SET
        brand = ${input.brand}, category = ${input.category},
        competitors = ${competitors}, audience = ${input.audience},
        prompts = ${prompts}, wizard = ${wizard}, updated_at = now()`;
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

  async updateProjectFlags(id, flags) {
    const sql = await db();
    if (flags.evidenceDrawer !== undefined) {
      await sql`UPDATE projects SET evidence_drawer = ${flags.evidenceDrawer ? 1 : 0} WHERE id = ${id}`;
    }
    if (flags.humanOverride !== undefined) {
      await sql`UPDATE projects SET human_override = ${flags.humanOverride ? 1 : 0} WHERE id = ${id}`;
    }
  },

  async upsertAnswerLabel(input) {
    const sql = await db();
    await sql`INSERT INTO answer_labels
        (id, project_id, response_id, metric, brand_norm, brand, verdict, labeled_by)
      VALUES (${crypto.randomUUID()}, ${input.projectId}, ${input.responseId},
        ${input.metric}, ${input.brandNorm}, ${input.brand},
        ${input.verdict ? 1 : 0}, ${input.labeledBy})
      ON CONFLICT (response_id, metric, brand_norm) DO UPDATE
        SET verdict = EXCLUDED.verdict,
            brand = EXCLUDED.brand,
            labeled_by = EXCLUDED.labeled_by,
            created_at = now()`;
  },

  async listLabelsForRun(runId) {
    const sql = await db();
    const rows = await sql`SELECT l.* FROM answer_labels l
      JOIN responses r ON r.id = l.response_id
      WHERE r.run_id = ${runId}`;
    return rows.map((r) => ({
      ...r,
      created_at: new Date(r.created_at as string).toISOString(),
    })) as AnswerLabel[];
  },

  async updateProjectEngineSet(id, engineSet) {
    const sql = await db();
    await sql`UPDATE projects SET engine_set = ${JSON.stringify(engineSet)} WHERE id = ${id}`;
  },

  async insertPrompts(projectId, prompts) {
    const sql = await db();
    const rows = prompts.map((p) => ({
      id: crypto.randomUUID(),
      project_id: projectId,
      text: p.text,
      theme: p.theme,
      intent_id: p.intentId ?? null,
    }));
    if (rows.length > 0) {
      await sql`INSERT INTO prompts ${sql(rows, "id", "project_id", "text", "theme", "intent_id")}`;
    }
    return this.listPrompts(projectId);
  },

  async insertIntents(projectId, intents) {
    const sql = await db();
    const rows = intents.map((i) => ({
      id: crypto.randomUUID(),
      project_id: projectId,
      stage: i.stage,
      layer: i.layer,
      situation: i.situation,
      angle: i.angle,
      text: i.text,
    }));
    if (rows.length > 0) {
      await sql`INSERT INTO intents ${sql(rows, "id", "project_id", "stage", "layer", "situation", "angle", "text")}`;
    }
    return this.listIntents(projectId);
  },

  async listIntents(projectId) {
    const sql = await db();
    const rows = await sql`SELECT * FROM intents WHERE project_id = ${projectId} ORDER BY seq`;
    return rows.map((r) => ({ ...r }) as unknown as Intent);
  },

  async listPrompts(projectId) {
    const sql = await db();
    const rows =
      await sql`SELECT id, project_id, text, theme, intent_id, flagged, flag_reason, suggested_alternatives, retired
        FROM prompts WHERE project_id = ${projectId} ORDER BY seq`;
    return rows.map(
      (r) =>
        ({
          ...r,
          flagged: (r.flagged as number) ?? 0,
          retired: (r.retired as number) ?? 0,
          suggested_alternatives: JSON.parse(
            (r.suggested_alternatives as string) ?? "[]"
          ),
        }) as unknown as Prompt
    );
  },

  async setPromptFlag(promptId, flag) {
    const sql = await db();
    await sql`UPDATE prompts SET flagged = ${flag ? 1 : 0},
      flag_reason = ${flag?.reason ?? null},
      suggested_alternatives = ${JSON.stringify(flag?.alternatives ?? [])}
      WHERE id = ${promptId}`;
  },

  async retirePrompt(promptId) {
    const sql = await db();
    await sql`UPDATE prompts SET retired = 1 WHERE id = ${promptId}`;
  },

  async createRun(input) {
    const sql = await db();
    const id = crypto.randomUUID();
    const models =
      input.models && input.models.length > 0 ? input.models : [input.model];
    await sql`INSERT INTO runs (id, project_id, model, models, repeats, status)
      VALUES (${id}, ${input.projectId}, ${models[0]}, ${JSON.stringify(models)}, ${input.repeats}, 'pending')`;
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
    // Column list is derived from the shared coding shape, never hand-written,
    // so insert and recode cannot drift. See lib/coding_columns.ts.
    const row = {
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
    await sql.begin(async (tx) => {
      // DO NOTHING + unique(run, prompt, repeat): overlapping chunk workers
      // can race on the same task; only the first insert lands.
      const res = await tx`INSERT INTO responses ${tx(row)}
        ON CONFLICT (run_id, prompt_id, repeat_idx, model) DO NOTHING`;
      if (res.count === 0) return;
      await insertMentions(tx, responseId, input.mentions);
    });
  },

  async writeResponseCoding(responseId, coding, coderModel, mentions) {
    const sql = await db();
    const cols = codingColumns(coding, coderModel);
    await sql.begin(async (tx) => {
      await tx`UPDATE responses SET ${tx(cols)} WHERE id = ${responseId}`;
      await tx`DELETE FROM mentions WHERE response_id = ${responseId}`;
      await insertMentions(tx, responseId, mentions);
    });
  },

  async deleteRun(runId) {
    const sql = await db();
    await sql.begin(async (tx) => {
      await tx`DELETE FROM mentions WHERE response_id IN (SELECT id FROM responses WHERE run_id = ${runId})`;
      await tx`DELETE FROM responses WHERE run_id = ${runId}`;
      await tx`DELETE FROM runs WHERE id = ${runId}`;
    });
  },

  async deleteProject(projectId) {
    const sql = await db();
    await sql.begin(async (tx) => {
      await tx`DELETE FROM mentions WHERE response_id IN (
        SELECT r.id FROM responses r JOIN runs ru ON ru.id = r.run_id
        WHERE ru.project_id = ${projectId})`;
      await tx`DELETE FROM responses WHERE run_id IN (SELECT id FROM runs WHERE project_id = ${projectId})`;
      await tx`DELETE FROM runs WHERE project_id = ${projectId}`;
      await tx`DELETE FROM prompts WHERE project_id = ${projectId}`;
      await tx`DELETE FROM intents WHERE project_id = ${projectId}`;
      await tx`DELETE FROM dictionary_entries WHERE project_id = ${projectId}`;
      await tx`DELETE FROM projects WHERE id = ${projectId}`;
    });
  },

  async countResponses(runId) {
    const sql = await db();
    const rows =
      await sql`SELECT COUNT(*)::int AS n FROM responses WHERE run_id = ${runId}`;
    return rows[0].n as number;
  },

  async countResponsesByModel(runId) {
    const sql = await db();
    const rows =
      await sql`SELECT model, COUNT(*)::int AS n FROM responses WHERE run_id = ${runId} GROUP BY model`;
    return Object.fromEntries(
      rows.map((r) => [r.model as string, r.n as number])
    );
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
          model: r.model ?? "",
          finish_reason: r.finish_reason ?? null,
          citations: r.citations ? JSON.parse(r.citations) : null,
          coder_model: r.coder_model ?? null,
          search_count: r.search_count ?? null,
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
