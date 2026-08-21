import { store } from "../store";
import {
  CoderUnavailableError,
  completeWithEngine,
  engineAvailable,
  extractCodingConsensus,
} from "./providers";
import { analyzePromptHealth } from "./prompt_health";
import { classifyNonBrands } from "./suggest";
import { getDictionarySuggestions } from "./dict_suggest";

// Sized when a run sampled one engine from one vendor. A six-engine panel
// spreads across four vendors, so 4 global slots left each vendor running
// roughly one request at a time while the rest of the run waited.
// A 420-answer run is ~121 minutes of API time (search engines take 20-27s
// per answer because they genuinely browse). Wall-clock is that divided by
// how many run at once, so this number IS the run duration. 32 lands near
// four minutes; raise it if the vendors tolerate more, but watch for 429s —
// retries make an over-subscribed run slower, not faster.
const CONCURRENCY = Number(process.env.RUN_CONCURRENCY ?? 64);

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

export type ChunkOutcome = "complete" | "continue" | "failed" | "finalize";

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

  if (pending.length === 0) return "finalize";

  const deadline = Date.now() + budgetMs;
  let cursor = 0;
  let inserted = 0;
  // Holder object: a plain `let` assigned only inside the worker closure
  // gets narrowed to `never` by control-flow analysis.
  const outage: { err: CoderUnavailableError | null } = { err: null };

  async function worker(): Promise<void> {
    while (cursor < pending.length && Date.now() < deadline) {
      const task = pending[cursor++];
      try {
        const { text, finishReason, citations, searchCount } = await completeWithEngine(
          task.model,
          task.promptText
        );
        const coding = await extractCodingConsensus(text, extractionCtx);
        await store.insertResponse({
          runId,
          promptId: task.promptId,
          repeatIdx: task.repeatIdx,
          model: task.model,
          finishReason,
          citations,
          coderModel: coding.coderProvenance,
          searchCount,
          text,
          mentions: coding.mentions,
          coding,
        });
        inserted++;
      } catch (err) {
        if (err instanceof CoderUnavailableError) {
          // Systemic, not transient: every remaining answer would be coded by
          // half the methodology. Stop rather than bank unusable data.
          outage.err = err;
          cursor = pending.length;
          return;
        }
        console.error(`procerno run ${runId} task failed:`, err);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker)
  );

  if (outage.err) {
    await store.updateRunStatus(runId, "failed", outage.err.message);
    console.error(`procerno run ${runId} halted: ${outage.err.message}`);
    return "failed";
  }

  const remaining = pending.length - inserted;
  if (remaining === 0) {
    // Collection is done, but the run is NOT complete: the dictionary and
    // the health check still have to land. They used to run here, in whatever
    // budget the last collection chunk had left over, which is why they were
    // silently skipped or arrived minutes late. finalizeRun gets its own
    // invocation and its own full budget.
    return "finalize";
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
/**
 * Re-code a run's stored answers without touching the vendors that produced
 * them. The text is already on disk and coding is a pure function of it, so a
 * coder change can be applied to existing data — and, more usefully, measured
 * against it: re-coding holds the answers constant, so any difference is the
 * coder change alone rather than the assistants having drifted that day.
 *
 * Costs roughly a third of a full run and takes well under a minute, since no
 * search engines are in the loop.
 */
export async function recodeRun(runId: string): Promise<number> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const project = await store.getProject(run.project_id);
  if (!project) throw new Error(`project ${run.project_id} not found`);
  const ctx = {
    targetBrand: project.brand,
    knownBrands: [project.brand, ...project.competitors],
    reasonCodes: project.reason_taxonomy,
  };
  const responses = await store.listResponses(runId);
  let cursor = 0;
  let recoded = 0;
  // Holder object: a plain `let` assigned only inside the worker closure
  // gets narrowed to `never` by control-flow analysis.
  const outage: { err: CoderUnavailableError | null } = { err: null };
  async function worker(): Promise<void> {
    while (cursor < responses.length) {
      const r = responses[cursor++];
      try {
        const coding = await extractCodingConsensus(r.text, ctx);
        await store.writeResponseCoding(
          r.id,
          coding,
          coding.coderProvenance,
          coding.mentions
        );
        recoded++;
      } catch (err) {
        if (err instanceof CoderUnavailableError) {
          outage.err = err;
          cursor = responses.length;
          return;
        }
        // One answer failing keeps its previous coding rather than losing it.
        console.error(`recode of response ${r.id} failed:`, err);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, responses.length) }, worker)
  );
  if (outage.err) {
    // Loud: a partially re-coded run is worse than an un-re-coded one, so the
    // caller has to know rather than read it off a provenance column later.
    throw new CoderUnavailableError(
      `${outage.err.message} Re-code stopped after ${recoded} of ${responses.length} answers.`
    );
  }
  console.log(`recoded ${recoded}/${responses.length} answers for run ${runId}`);
  return recoded;
}

/**
 * Everything a run owes after its last answer lands: unmatched names into the
 * dictionary queue, the junk filter, the pre-computed Identify suggestions,
 * and the prompt health check. The run stays "running" throughout — the
 * dashboard reads that as its "Analyzing answers" stage — and is marked
 * complete only once this finishes, so a reader never opens a finished run
 * onto an empty dictionary or a health check that has not happened yet.
 *
 * Every step is individually guarded and the run is completed regardless: a
 * failure here must not strand a run with 420 good answers in "running".
 */
export async function finalizeRun(runId: string): Promise<void> {
  const run = await store.getRun(runId);
  if (!run || run.status === "complete" || run.status === "failed") return;
  const project = await store.getProject(run.project_id);
  if (!project) return;
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
    await getDictionarySuggestions(project.id, project.category);
  } catch (err) {
    console.error("dictionary finalize failed:", err);
  }
  try {
    await analyzePromptHealth(project.id, runId);
  } catch (err) {
    console.error("prompt health check failed:", err);
  }
  await store.updateRunStatus(runId, "complete", null);
}

export function runInBackground(runId: string): Promise<void> {
  return (async () => {
    let outcome = await driveRunChunk(runId, 7 * 24 * 3600 * 1000);
    while (outcome === "continue") {
      // loop — retries tasks that failed transiently
      outcome = await driveRunChunk(runId, 7 * 24 * 3600 * 1000);
    }
    if (outcome === "finalize") await finalizeRun(runId);
  })().catch(async (err) => {
    console.error(`procerno run ${runId} crashed:`, err);
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
    if (outcome === "finalize") {
      // Fresh invocation, fresh budget. If the hop cannot be made at all,
      // finalize inline rather than leaving the run stuck in "running".
      try {
        const res = await fetch(`${origin}/api/runs/${runId}/finalize`, {
          method: "POST",
          headers: process.env.CRON_SECRET
            ? { authorization: `Bearer ${process.env.CRON_SECRET}` }
            : undefined,
        });
        if (!res.ok) await finalizeRun(runId);
      } catch {
        await finalizeRun(runId);
      }
    } else if (outcome === "continue") {
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
    console.error(`procerno run ${runId} crashed:`, err);
    await store.updateRunStatus(runId, "failed", String(err));
  }
}
