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
  const [prompts, completed, byModel] = await Promise.all([
    store.listPrompts(run.project_id),
    store.countResponses(id),
    store.countResponsesByModel(id),
  ]);
  const liveCount = prompts.filter((p) => !p.retired).length;
  const models = run.models.length > 0 ? run.models : [run.model];
  // Each engine answers every live prompt once per repeat, so they share one
  // per-engine target. Progress is honest only against that denominator.
  const perEngineTotal = liveCount * run.repeats;
  return NextResponse.json({
    run,
    completed,
    total: perEngineTotal * Math.max(models.length, 1),
    promptCount: liveCount,
    perEngineTotal,
    perEngine: models.map((m) => ({
      model: m,
      completed: byModel[m] ?? 0,
    })),
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
  const loaded = await requireRun(id, auth, { write: true });
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
