import { store } from "@/lib/store";
import {
  computeRunMetricsFromData,
  loadRunData,
  type SliceOpts,
} from "@/lib/engine/metrics";
import type { Project, Run, RunMetrics } from "@/lib/types";

/**
 * Two-level cache for computed run slices, shared by the metrics and slices
 * routes.
 *
 * L1 is per-process memory — free hits while a serverless instance stays
 * warm. L2 is the llm_cache table — a cold instance pays one ~2ms row read
 * instead of a full run load + compute. Completed runs are immutable, and
 * everything mutable that feeds a slice is part of the key:
 *
 *   slice:<runId>:<dictVersion>:<humanOverride>:<labelsRev>:<engineSet>:<mode>:<engines>:<focus>
 *
 * dictionary_version bumps on dictionary edits, human_override is the
 * project flag, and labelsRev is a count+max(created_at) fingerprint that
 * moves on every evidence-drawer write — so no invalidation hooks are
 * needed; a stale entry simply stops being addressed. When a run's key
 * generation moves, its old rows are purged in one statement.
 */
const L1_TTL_MS = 10 * 60 * 1000;
const L2_TTL_MS = 24 * 3600 * 1000;
const L1_MAX = 500;
const l1 = new Map<string, { at: number; m: RunMetrics }>();

function l1Get(key: string): RunMetrics | null {
  const hit = l1.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > L1_TTL_MS) {
    l1.delete(key);
    return null;
  }
  return hit.m;
}

function l1Set(key: string, m: RunMetrics) {
  if (l1.size >= L1_MAX) {
    const oldest = [...l1.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) l1.delete(oldest[0]);
  }
  l1.set(key, { at: Date.now(), m });
}

export interface SliceQuery {
  /** Echoed back verbatim — the caller's own cache key. */
  key: string;
  opts: SliceOpts;
}

export async function computeSlicesCached(
  run: Run,
  project: Project,
  queries: SliceQuery[]
): Promise<Record<string, RunMetrics>> {
  // A run still collecting answers changes under every request — compute
  // fresh and cache nothing until it completes.
  if (run.status !== "complete") {
    const out: Record<string, RunMetrics> = {};
    const data = await loadRunData(run.id);
    if (!data) return out;
    for (const q of queries) out[q.key] = computeRunMetricsFromData(data, q.opts);
    return out;
  }

  const labelsRev = await store.labelsRevisionForRun(run.id);
  const runPrefix = `slice:${run.id}:`;
  const generation = `${runPrefix}${project.dictionary_version}:${project.human_override}:${labelsRev}:${project.engine_set.join("+")}`;
  const fullKey = (q: SliceQuery) =>
    `${generation}:${q.opts.mode ?? ""}:${(q.opts.engines ?? []).slice().sort().join(",")}:${q.opts.focus ?? ""}`;

  const out: Record<string, RunMetrics> = {};

  const pastL1 = queries.filter((q) => {
    const hit = l1Get(fullKey(q));
    if (hit) out[q.key] = hit;
    return !hit;
  });

  const misses: SliceQuery[] = [];
  await Promise.all(
    pastL1.map(async (q) => {
      const raw = await store.cacheGet(fullKey(q), L2_TTL_MS);
      if (raw) {
        const m = JSON.parse(raw) as RunMetrics;
        out[q.key] = m;
        l1Set(fullKey(q), m);
      } else {
        misses.push(q);
      }
    })
  );

  if (misses.length > 0) {
    const data = await loadRunData(run.id);
    if (!data) return out;
    for (const q of misses) {
      const m = computeRunMetricsFromData(data, q.opts);
      out[q.key] = m;
      l1Set(fullKey(q), m);
    }
    // Persist new slices, then drop this run's rows from older generations.
    await Promise.all(
      misses.map((q) => store.cacheSet(fullKey(q), JSON.stringify(out[q.key])))
    );
    await store.cachePurge(runPrefix, generation);
  }

  return out;
}
