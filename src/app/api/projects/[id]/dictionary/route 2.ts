import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";
import { requireAuth, requireProject } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth);
  if (project instanceof NextResponse) return project;
  const entries = await store.getDictionary(id);
  return NextResponse.json({
    entries,
    version: project.dictionary_version,
  });
}

const actionSchema = z.object({
  entryId: z.string().min(1),
  action: z.enum(["approve", "reject", "merge", "rename", "unalias"]),
  mergeIntoId: z.string().min(1).optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
  alias: z.string().trim().min(1).optional(),
});

const batchSchema = z.object({
  actions: z.array(actionSchema).min(1).max(300),
});

type Action = z.infer<typeof actionSchema>;

async function applyAction(projectId: string, a: Action): Promise<string | null> {
  const entries = await store.getDictionary(projectId);
  const entry = entries.find((e) => e.id === a.entryId);
  if (!entry) return `entry not found: ${a.entryId}`;

  if (a.action === "approve") {
    await store.upsertDictionaryEntry({
      id: entry.id,
      projectId,
      canonical: entry.canonical,
      aliases: entry.aliases,
      status: "active",
    });
  } else if (a.action === "reject") {
    await store.upsertDictionaryEntry({
      id: entry.id,
      projectId,
      canonical: entry.canonical,
      aliases: entry.aliases,
      status: "rejected",
    });
  } else if (a.action === "rename") {
    // Display-only: the fossilized match strings are never touched.
    if (!a.displayName) return "rename needs displayName";
    await store.upsertDictionaryEntry({
      id: entry.id,
      projectId,
      canonical: entry.canonical,
      aliases: entry.aliases,
      status: entry.status,
      displayName: a.displayName,
    });
  } else if (a.action === "unalias") {
    // Reverse a merge: the alias returns to the queue as its own entry.
    if (!a.alias) return "unalias needs alias";
    const norm = a.alias.trim().toLowerCase();
    if (!entry.aliases.includes(norm)) return `alias not on entry: ${a.alias}`;
    await store.upsertDictionaryEntry({
      id: entry.id,
      projectId,
      canonical: entry.canonical,
      aliases: entry.aliases.filter((x) => x !== norm),
      status: entry.status,
    });
    await store.queueDictionaryCandidates(projectId, [a.alias.trim()]);
  } else {
    const into = entries.find((e) => e.id === a.mergeIntoId);
    if (!into || into.status !== "active")
      return `merge target must be active: ${a.mergeIntoId}`;
    await store.upsertDictionaryEntry({
      id: into.id,
      projectId,
      canonical: into.canonical,
      aliases: [
        ...new Set([
          ...into.aliases,
          entry.canonical.trim().toLowerCase(),
          ...entry.aliases,
        ]),
      ],
      status: "active",
    });
    await store.upsertDictionaryEntry({
      id: entry.id,
      projectId,
      canonical: entry.canonical,
      aliases: [],
      status: "rejected",
    });
  }
  return null;
}

/**
 * Review dictionary entries. Accepts a single action or a batch
 * ({actions: [...]}); merges are applied before approves so pending-to-
 * pending merges can target a just-approved entry via ordering by caller.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth);
  if (project instanceof NextResponse) return project;
  const body = await req.json().catch(() => null);
  const batch = batchSchema.safeParse(body);
  const single = actionSchema.safeParse(body);
  const actions = batch.success
    ? batch.data.actions
    : single.success
      ? [single.data]
      : null;
  if (!actions) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  // Approvals first so same-batch merges can land on newly active entries.
  const ordered = [
    ...actions.filter((a) => a.action !== "merge"),
    ...actions.filter((a) => a.action === "merge"),
  ];
  const errors: string[] = [];
  for (const a of ordered) {
    const err = await applyAction(id, a);
    if (err) errors.push(err);
  }
  const version = await store.bumpDictionaryVersion(id);
  return NextResponse.json({
    ok: errors.length === 0,
    applied: ordered.length - errors.length,
    errors,
    version,
  });
}
