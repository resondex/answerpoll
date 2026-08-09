import { store } from "../store";
import { completeWithEngine, engineAvailable, getProvider } from "./providers";
import { analyzePromptHealth } from "./prompt_health";
import { classifyNonBrands } from "./suggest";
import { getDictionarySuggestions } from "./dict_suggest";

const CONCURRENCY = 4;

// Serverless functions cap at maxDuration=300s; leave headroom for in-flight
// completions to finish and the chain handoff to fire.
export const VERCEL_CHUNK_BUDGET_MS = 220_000;

interface Task {
  promptId: string;
  promptText: string;
  repeatIdx: number;
  /** Which engine answers this task — the third axis of the grid. */
  model: string;
}

export type ChunkOutcome = "complete" | "continue" | "failed";

/**
 * Process as much of a run as fits in budgetMs, then report whether work
 * remains. Tasks are (prompt × repeat × engine) triples; already-stored
 * responses are skipped, so a chunk can resume a run that a killed function
 * left behind. Answers come from each engine; coding always comes from the
 * one fixed extraction model, so engine differences are real differences.
 */
export async function driveRunChunk(
  runId: string,
  budgetMs: number
): Promise<ChunkOutcome> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status === "complete" || run.status === "failed") return run.status;
  const project = await store.getProject(run.project_id);
  if (!project) throw new Error(`project ${run.project_id} not found`);
  const prompts = (await store.listPrompts(project.id)).filter(
    (p) => !p.retired
  );
  const knownBrands = [project.brand, ...project.competitors];
  const extractionCtx = {
    targetBrand: project.brand,
    knownBrands,
    reasonCodes: project.reason_taxonomy,
  };

  if (run.status === "pending") await store.updateRunStatus(runId, "running");

  // Engines whose vendor key is missing would fail every task; drop them and
  // measure what we can rather than failing the whole run.
  const engines = (run.models.length > 0 ? run.models : [run.model]).filter(
    (m) => engineAvailable(m)
  );
  if (engines.length === 0) {
    await store.updateRunStatus(
      runId,
      "failed",
      `no API key configured for any requested engine (${run.models.join(", ")})`
    );
    return "failed";
  }

  const doneKeys = new Set(
    (await store.listResponses(runId)).map(
      (r) => `${r.prompt_id}:${r.repeat_idx}:${r.model}`
    )
  );
  const total = prompts.length * run.repeats * engines.length;
  const pending: Task[] = [];
  for (const p of prompts) {
    for (let r = 0; r < run.repeats; r++) {
      for (const model of engines) {
        if (!doneKeys.has(`${p.id}:${r}:${model}`)) {
          pending.push({
            promptId: p.id,
            promptText: p.text,
            repeatIdx: r,
            model,
          });
        }
      }
    }
  }

  if (pending.length === 0) {
    await store.updateRunStatus(runId, "complete", null);
    return "complete";
  }

  const provider = getProvider();
  const deadline = Date.now() + budgetMs;
  let cursor = 0;
  let inserted = 0;

  async function worker(): Promise<void> {
    while (cursor < pending.length && Date.now() < deadline) {
      const task = pending[cursor++];
      try {
        const { text, finishReason } = await completeWithEngine(
          task.model,
          task.promptText
        );
        const coding = await provider.extractCoding(text, extractionCtx);
        await store.insertResponse({
          runId,
          promptId: task.promptId,
          repeatIdx: task.repeatIdx,
          model: task.model,
          finishReason,
          text,
          mentions: coding.mentions,
          coding,
        });
        inserted++;
      } catch (err) {
        console.error(`answerpoll run ${runId} task failed:`, err);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker)
  );

  const remaining = pending.length - inserted;
  if (remaining === 0) {
    await store.updateRunStatus(runId, "complete", null);
    // Feed unmatched brand names into the dictionary review queue — from
    // mentions AND top picks (a crowned pick can be phrased a way no
    // mention was).
    try {
      const [runMentions, runResponses] = await Promise.all([
        store.listMentionsForRun(runId),
        store.listResponses(runId),
      ]);
      await store.queueDictionaryCandidates(project.id, [
        ...new Set([
          ...runMentions.map((m) => m.brand),
          ...runResponses
            .map((r) => r.top_pick_brand)
            .filter((b): b is string => Boolean(b)),
        ]),
      ]);
      // Junk filter: obvious non-brands ("self-hosted server") land in the
      // dictionary pre-excluded — out of the review queue but visible and
      // reversible in the Analyze tab. Real names stay pending for review.
      const dict = await store.getDictionary(project.id);
      const pendingEntries = dict.filter((e) => e.status === "pending");
      if (pendingEntries.length > 0) {
        const nonBrands = await classifyNonBrands(
          pendingEntries.map((e) => e.canonical)
        );
        let excluded = 0;
        for (const e of pendingEntries) {
          if (nonBrands.has(e.canonical.trim().toLowerCase())) {
            await store.upsertDictionaryEntry({
              id: e.id,
              projectId: project.id,
              canonical: e.canonical,
              aliases: e.aliases,
              status: "rejected",
            });
            excluded++;
          }
        }
        if (excluded > 0) {
          await store.bumpDictionaryVersion(project.id);
          console.log(
            `dictionary junk filter: pre-excluded ${excluded} non-brand name(s)`
          );
        }
      }
      // Warm the Identify view: compute + cache the disposition suggestions
      // now, so the review board opens pre-sorted instead of making the
      // user watch the sorting pass.
      await getDictionarySuggestions(project.id, project.category);
    } catch (err) {
      console.error("dictionary queue failed:", err);
    }
    // First completed run: health-check the battery before the study is
    // trusted for scheduled measurement.
    try {
      const allRuns = await store.listRuns(project.id);
      if (allRuns.filter((r) => r.status === "complete").length === 1) {
        await analyzePromptHealth(project.id, runId);
      }
    } catch (err) {
      console.error("prompt health check failed:", err);
    }
    return "complete";
  }
  if (inserted > 0) return "continue";
  // A full chunk with zero progress: either every request errors (bad key,
  // bad model) or only permanently-failing tasks remain.
  const doneCount = total - remaining;
  if (doneCount > 0) {
    await store.updateRunStatus(
      runId,
      "complete",
      `${remaining}/${total} requests failed`
    );
    return "complete";
  }
  await store.updateRunStatus(
    runId,
    "failed",
    "every request failed — check API key and model"
  );
  return "failed";
}

/** Local driver: chunk in-process until the run reaches a terminal state. */
export function runInBackground(runId: string): Promise<void> {
  return (async () => {
    while ((await driveRunChunk(runId, 7 * 24 * 3600 * 1000)) === "continue") {
      // loop — retries tasks that failed transiently
    }
  })().catch(async (err) => {
    console.error(`answerpoll run ${runId} crashed:`, err);
    await store.updateRunStatus(runId, "failed", String(err));
  });
}

/**
 * Serverless driver: process one budgeted chunk, then hand the rest to a
 * fresh invocation via the run's /continue endpoint so no single function
 * has to outlive maxDuration.
 */
export async function driveAndChain(
  runId: string,
  origin: string
): Promise<void> {
  try {
    const outcome = await driveRunChunk(runId, VERCEL_CHUNK_BUDGET_MS);
    if (outcome === "continue") {
      // Server-to-server hop carries no session cookies; the continue route
      // accepts the cron secret as chain credentials.
      await fetch(`${origin}/api/runs/${runId}/continue`, {
        method: "POST",
        headers: process.env.CRON_SECRET
          ? { authorization: `Bearer ${process.env.CRON_SECRET}` }
          : undefined,
      });
    }
  } catch (err) {
    console.error(`answerpoll run ${runId} crashed:`, err);
    await store.updateRunStatus(runId, "failed", String(err));
  }
}
