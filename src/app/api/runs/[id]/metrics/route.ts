import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { computeRunMetrics } from "@/lib/engine/metrics";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const run = await store.getRun(id);
  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const [metrics, project] = await Promise.all([
    computeRunMetrics(id),
    store.getProject(run.project_id),
  ]);
  return NextResponse.json({ metrics, project });
}
