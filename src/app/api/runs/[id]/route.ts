import { NextResponse } from "next/server";
import { store } from "@/lib/store";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const run = await store.getRun(id);
  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const [prompts, completed] = await Promise.all([
    store.listPrompts(run.project_id),
    store.countResponses(id),
  ]);
  return NextResponse.json({
    run,
    completed,
    total: prompts.length * run.repeats,
  });
}
