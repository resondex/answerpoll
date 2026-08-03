import { NextResponse } from "next/server";
import { getProject, listPrompts, listRuns } from "@/lib/db";
import { mockModeActive } from "@/lib/engine/providers";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({
    project,
    prompts: listPrompts(id),
    runs: listRuns(id),
    mockMode: mockModeActive(),
  });
}
