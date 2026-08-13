import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";
import { isStaff, getPlanFor, requireAuth, requireProject } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth);
  if (project instanceof NextResponse) return project;
  const [prompts, runs, staff] = await Promise.all([
    store.listPrompts(id),
    store.listRuns(id),
    isStaff(auth),
  ]);
  // Drives whether staff-only switches are rendered at all. The PATCH route
  // enforces the same check, so a hidden control is a courtesy, not the gate.
  return NextResponse.json({
    project,
    prompts,
    runs,
    staff,
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
  const project = await requireProject(id, auth, { write: true });
  if (project instanceof NextResponse) return project;
  await store.deleteProject(id);
  return NextResponse.json({ ok: true });
}

const patchSchema = z.object({
  schedule: z.enum(["none", "weekly", "monthly"]).optional(),
  /** Editing the core engine panel is an epoch change for the trend. */
  engines: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
  /** Per-project availability of the evidence drawer. */
  evidenceDrawer: z.boolean().optional(),
  /** Staff-only: let human labels override the coder. */
  humanOverride: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth, { write: true });
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
  if (parsed.data.evidenceDrawer !== undefined) {
    await store.updateProjectFlags(id, {
      evidenceDrawer: parsed.data.evidenceDrawer,
    });
  }
  // Human override changes what every reported figure means, so it is not a
  // customer-facing switch: staff only, regardless of project ownership.
  if (parsed.data.humanOverride !== undefined) {
    if (!(await isStaff(auth))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    await store.updateProjectFlags(id, {
      humanOverride: parsed.data.humanOverride,
    });
  }
  return NextResponse.json({ ok: true });
}
