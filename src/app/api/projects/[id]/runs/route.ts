import { NextResponse } from "next/server";
import { z } from "zod";
import { createRun, getProject } from "@/lib/db";
import { mockModeActive } from "@/lib/engine/providers";
import { startRun } from "@/lib/engine/runner";

const runSchema = z.object({
  model: z.string().trim().min(1).default("gpt-5-mini"),
  repeats: z.number().int().min(1).max(20).default(5),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid input" },
      { status: 400 }
    );
  }
  const run = createRun({
    projectId: id,
    model: parsed.data.model,
    repeats: parsed.data.repeats,
    mock: mockModeActive(),
  });
  startRun(run.id);
  return NextResponse.json({ run }, { status: 201 });
}
