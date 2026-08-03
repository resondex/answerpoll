import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { mockModeActive } from "@/lib/engine/providers";

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
    mockMode: mockModeActive(),
  });
}
