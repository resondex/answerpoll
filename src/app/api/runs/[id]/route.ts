import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireAuth, requireRun } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth);
  if (loaded instanceof NextResponse) return loaded;
  const { run } = loaded;
  const [prompts, completed] = await Promise.all([
    store.listPrompts(run.project_id),
    store.countResponses(id),
  ]);
  return NextResponse.json({
    run,
    completed,
    total: prompts.filter((p) => !p.retired).length * run.repeats,
  });
}

/** Delete a run and its data. Prompts, dictionary, and other runs stay. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth);
  if (loaded instanceof NextResponse) return loaded;
  if (loaded.run.status === "running" || loaded.run.status === "pending") {
    return NextResponse.json(
      { error: "stop is not supported — wait for the run to finish first" },
      { status: 409 }
    );
  }
  await store.deleteRun(id);
  return NextResponse.json({ ok: true });
}
