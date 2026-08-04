import { NextResponse } from "next/server";
import { requireAuth, requireRun } from "@/lib/auth";
import { computeRunMetrics } from "@/lib/engine/metrics";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth);
  if (loaded instanceof NextResponse) return loaded;
  const metrics = await computeRunMetrics(id);
  return NextResponse.json({ metrics, project: loaded.project });
}
