import { NextResponse } from "next/server";
import { requireAuth, requireRun } from "@/lib/auth";
import { computeRunMetrics } from "@/lib/engine/metrics";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth);
  if (loaded instanceof NextResponse) return loaded;
  // ?mode=instinct|search recomputes every cut over that instrument only —
  // the Workbench mode filter is a real filter, not a cosmetic one.
  const modeParam = new URL(req.url).searchParams.get("mode");
  const mode =
    modeParam === "instinct" || modeParam === "search" ? modeParam : undefined;
  const metrics = await computeRunMetrics(id, mode ? { mode } : undefined);
  return NextResponse.json({ metrics, project: loaded.project });
}
