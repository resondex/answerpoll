import { store } from "../store";
import { getProvider } from "./providers";

const CONCURRENCY = 4;

interface Task {
  promptId: string;
  promptText: string;
  repeatIdx: number;
}

/**
 * Execute every prompt × repeat for a run, extracting mentions as responses
 * arrive. The caller decides how to schedule this (fire-and-forget locally,
 * waitUntil on Vercel); the UI polls for progress either way.
 */
export async function executeRun(runId: string): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const project = await store.getProject(run.project_id);
  if (!project) throw new Error(`project ${run.project_id} not found`);
  const prompts = await store.listPrompts(project.id);
  // Target brand first — the mock provider keys appearance odds off position.
  const knownBrands = [project.brand, ...project.competitors];

  await store.updateRunStatus(runId, "running");

  const tasks: Task[] = [];
  for (const p of prompts) {
    for (let r = 0; r < run.repeats; r++) {
      tasks.push({ promptId: p.id, promptText: p.text, repeatIdx: r });
    }
  }

  const provider = getProvider();
  let cursor = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
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
      } catch (err) {
        failed++;
        console.error(`answerpoll run ${runId} task failed:`, err);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker)
  );

  if (failed === tasks.length && tasks.length > 0) {
    await store.updateRunStatus(
      runId,
      "failed",
      "every request failed — check API key and model"
    );
  } else {
    const note = failed > 0 ? `${failed}/${tasks.length} requests failed` : null;
    await store.updateRunStatus(runId, "complete", note);
  }
}

/** Run to completion in the background, recording failures on the run row. */
export function runInBackground(runId: string): Promise<void> {
  return executeRun(runId).catch(async (err) => {
    console.error(`answerpoll run ${runId} crashed:`, err);
    await store.updateRunStatus(runId, "failed", String(err));
  });
}
