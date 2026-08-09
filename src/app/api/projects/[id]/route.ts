import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";
import { getPlanFor, requireAuth, requireProject } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth);
  if (project instanceof NextResponse) return project;
  const [prompts, runs] = await Promise.all([
    store.listPrompts(id),
    store.listRuns(id),
  ]);
  return NextResponse.json({
    project,
    prompts,
    runs,
  });
}

/** Delete a tracker and everything under it. Irreversible. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth);
  if (project instanceof NextResponse) return project;
  await store.deleteProject(id);
  return NextResponse.json({ ok: true });
}

const patchSchema = z.object({
  schedule: z.enum(["none", "weekly", "monthly"]).optional(),
  /** Editing the core engine panel is an epoch change for the trend. */
  engines: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth);
  if (project instanceof NextResponse) return project;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid schedule" }, { status: 400 });
  }
  if (parsed.data.schedule && parsed.data.schedule !== "none") {
    const plan = await getPlanFor(auth);
    if (plan === "free") {
      return NextResponse.json(
        { error: "Scheduled runs are a Pro feature — upgrade to automate" },
        { status: 403 }
      );
    }
  }
  if (parsed.data.schedule) {
    await store.updateProjectSchedule(id, parsed.data.schedule);
  }
  if (parsed.data.engines) {
    await store.updateProjectEngineSet(id, parsed.data.engines);
  }
  return NextResponse.json({ ok: true });
}
