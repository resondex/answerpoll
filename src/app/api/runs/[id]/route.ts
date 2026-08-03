import { NextResponse } from "next/server";
import { countResponses, getRun, listPrompts } from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const total = listPrompts(run.project_id).length * run.repeats;
  return NextResponse.json({
    run,
    completed: countResponses(id),
    total,
  });
}
