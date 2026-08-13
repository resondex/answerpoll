import { NextResponse } from "next/server";
import { getPlanFor, requireAuth, requireRun } from "@/lib/auth";
import { computeSlicesCached } from "@/lib/engine/slice_cache";
import type { RunMetrics } from "@/lib/types";

export const maxDuration = 60;

/**
 * Batched slice computation: one request, one database load, N slices
 * computed in memory. This is what makes a many-brand comparison cost the
 * same round trips as a single-brand view. Caching (warm-instance memory +
 * the llm_cache table for cold serverless instances) lives in
 * lib/engine/slice_cache — see there for the key discipline.
 */
interface SliceRequest {
  /** Echoed back verbatim — the client's own cache key. */
  key: string;
  focus?: string;
  engines?: string[];
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth);
  if (loaded instanceof NextResponse) return loaded;

  const body = (await req.json().catch(() => null)) as {
    requests?: SliceRequest[];
  } | null;
  const requests = (body?.requests ?? []).slice(0, 64);
  if (requests.length === 0) {
    return NextResponse.json({ error: "requests required" }, { status: 400 });
  }

  const { project, run } = loaded;
  const slices: Record<string, RunMetrics> = await computeSlicesCached(
    run,
    project,
    requests.map((r) => ({
      key: r.key,
      opts: {
        focus: r.focus?.trim().slice(0, 120) || undefined,
        engines:
          r.engines && r.engines.length > 0
            ? r.engines.map((e) => e.trim()).filter(Boolean).slice(0, 20)
            : undefined,
      },
    }))
  );
  if (Object.keys(slices).length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const plan = await getPlanFor(auth);
  return NextResponse.json({ slices, plan });
}
