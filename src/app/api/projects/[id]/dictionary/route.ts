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
  action: z.enum(["approve", "reject", "merge"]),
  mergeIntoId: z.string().min(1).optional(),
});

/** Review a pending dictionary entry: approve as brand, merge as alias, reject. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth);
  if (project instanceof NextResponse) return project;
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  const entries = await store.getDictionary(id);
  const entry = entries.find((e) => e.id === parsed.data.entryId);
  if (!entry) {
    return NextResponse.json({ error: "entry not found" }, { status: 404 });
  }

  if (parsed.data.action === "approve") {
    await store.upsertDictionaryEntry({
      id: entry.id,
      projectId: id,
      canonical: entry.canonical,
      aliases: entry.aliases,
      status: "active",
    });
  } else if (parsed.data.action === "reject") {
    await store.upsertDictionaryEntry({
      id: entry.id,
      projectId: id,
      canonical: entry.canonical,
      aliases: entry.aliases,
      status: "rejected",
    });
  } else {
    const into = entries.find((e) => e.id === parsed.data.mergeIntoId);
    if (!into || into.status !== "active") {
      return NextResponse.json(
        { error: "merge target must be an active entry" },
        { status: 400 }
      );
    }
    await store.upsertDictionaryEntry({
      id: into.id,
      projectId: id,
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
      projectId: id,
      canonical: entry.canonical,
      aliases: [],
      status: "rejected",
    });
  }
  const version = await store.bumpDictionaryVersion(id);
  return NextResponse.json({ ok: true, version });
}
