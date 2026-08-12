import { NextResponse } from "next/server";
import { getPlanFor, requireAuth, requireRun } from "@/lib/auth";
import {
  computeRunMetricsFromData,
  loadRunData,
  type SliceOpts,
} from "@/lib/engine/metrics";
import type { RunMetrics } from "@/lib/types";

export const maxDuration = 60;

/**
 * Batched slice computation: one request, one database load, N slices
 * computed in memory. This is what makes a many-brand comparison cost the
 * same round trips as a single-brand view.
 *
 * Completed runs are immutable and dictionary edits bump the dictionary
 * version, so a computed slice keyed on (run, dictVersion, engine set,
 * scope, focus) can be cached safely; TTL is just hygiene for warm
 * serverless instances.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const sliceCache = new Map<string, { at: number; m: RunMetrics }>();

function cacheGet(key: string): RunMetrics | null {
  const hit = sliceCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    sliceCache.delete(key);
    return null;
  }
  return hit.m;
}

function cacheSet(key: string, m: RunMetrics) {
  if (sliceCache.size >= CACHE_MAX) {
    const oldest = [...sliceCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) sliceCache.delete(oldest[0]);
  }
  sliceCache.set(key, { at: Date.now(), m });
}

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
  const stamp = `${run.id}:${project.dictionary_version}:${project.engine_set.join("+")}`;
  const serverKey = (r: SliceRequest) =>
    `${stamp}:${(r.engines ?? []).slice().sort().join(",")}:${r.focus ?? ""}`;

  const slices: Record<string, RunMetrics> = {};
  const misses = requests.filter((r) => {
    const hit = cacheGet(serverKey(r));
    if (hit) slices[r.key] = hit;
    return !hit;
  });

  if (misses.length > 0) {
    const data = await loadRunData(id);
    if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
    for (const r of misses) {
      const opts: SliceOpts = {
        focus: r.focus?.trim().slice(0, 120) || undefined,
        engines:
          r.engines && r.engines.length > 0
            ? r.engines.map((e) => e.trim()).filter(Boolean).slice(0, 20)
            : undefined,
      };
      const m = computeRunMetricsFromData(data, opts);
      slices[r.key] = m;
      cacheSet(serverKey(r), m);
    }
  }

  const plan = await getPlanFor(auth);
  return NextResponse.json({ slices, plan });
}
