import { NextResponse } from "next/server";
import { getPlanFor, requireAuth, requireRun } from "@/lib/auth";
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
  const url = new URL(req.url);
  const modeParam = url.searchParams.get("mode");
  const mode =
    modeParam === "instinct" || modeParam === "search" ? modeParam : undefined;
  // ?focus=<brand> is the brand lens — every cut recomputes with that brand
  // as the focus. Combines freely with ?mode=.
  const focus = url.searchParams.get("focus")?.trim().slice(0, 120) || undefined;
  const metrics = await computeRunMetrics(
    id,
    mode || focus ? { mode, focus } : undefined
  );
  const plan = await getPlanFor(auth);
  return NextResponse.json({ metrics, project: loaded.project, plan });
}
