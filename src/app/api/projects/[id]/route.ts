import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await store.getProject(id);
  if (!project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
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

const patchSchema = z.object({
  schedule: z.enum(["none", "weekly", "monthly"]),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await store.getProject(id);
  if (!project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid schedule" }, { status: 400 });
  }
  await store.updateProjectSchedule(id, parsed.data.schedule);
  return NextResponse.json({ ok: true, schedule: parsed.data.schedule });
}
