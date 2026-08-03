import { NextResponse } from "next/server";
import { getProject, getRun } from "@/lib/db";
import { computeRunMetrics } from "@/lib/engine/metrics";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const metrics = computeRunMetrics(id);
  return NextResponse.json({
    metrics,
    project: getProject(run.project_id),
  });
}
