import { store } from "../store";
import { getProvider } from "./providers";

const CONCURRENCY = 4;

// Serverless functions cap at maxDuration=300s; leave headroom for in-flight
// completions to finish and the chain handoff to fire.
export const VERCEL_CHUNK_BUDGET_MS = 220_000;

interface Task {
  promptId: string;
  promptText: string;
  repeatIdx: number;
}

export type ChunkOutcome = "complete" | "continue" | "failed";

/**
 * Process as much of a run as fits in budgetMs, then report whether work
 * remains. Tasks are (prompt × repeat) pairs; already-stored responses are
 * skipped, so a chunk can resume a run that a killed function left behind.
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
  const prompts = await store.listPrompts(project.id);
  // Target brand first — the mock provider keys appearance odds off position.
  const knownBrands = [project.brand, ...project.competitors];

  if (run.status === "pending") await store.updateRunStatus(runId, "running");

  const doneKeys = new Set(
    (await store.listResponses(runId)).map(
      (r) => `${r.prompt_id}:${r.repeat_idx}`
    )
  );
  const total = prompts.length * run.repeats;
  const pending: Task[] = [];
  for (const p of prompts) {
    for (let r = 0; r < run.repeats; r++) {
      if (!doneKeys.has(`${p.id}:${r}`)) {
        pending.push({ promptId: p.id, promptText: p.text, repeatIdx: r });
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
        const promptForModel = run!.mock
          ? `${task.promptText} [[brands:${knownBrands.join("|")}]]`
          : task.promptText;
        const text = await provider.complete(promptForModel, run!.model);
        const mentions = await provider.extractMentions(text, knownBrands);
        await store.insertResponse({
          runId,
          promptId: task.promptId,
          repeatIdx: task.repeatIdx,
          text,
          mentions,
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
      await fetch(`${origin}/api/runs/${runId}/continue`, { method: "POST" });
    }
  } catch (err) {
    console.error(`answerpoll run ${runId} crashed:`, err);
    await store.updateRunStatus(runId, "failed", String(err));
  }
}
