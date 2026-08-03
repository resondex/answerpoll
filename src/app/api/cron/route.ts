import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { store } from "@/lib/store";
import { apiKeyConfigured } from "@/lib/engine/providers";
import { driveAndChain, runInBackground } from "@/lib/engine/runner";

export const maxDuration = 300;

const INTERVAL_DAYS: Record<string, number> = {
  // A margin under the nominal interval so a cron that fires a little early
  // (or a run that completed a little late) still triggers on the right day.
  weekly: 6.5,
  monthly: 27,
};

const CRON_MODEL = "gpt-5-mini";
const CRON_REPEATS = 5;

/** Both store drivers emit UTC; sqlite omits the T and Z, postgres has them. */
function toUtcMs(ts: string): number {
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z").getTime();
}

/**
 * Fired daily by Vercel cron (see vercel.json). Launches a run for every
 * project whose schedule says it's due. Requires CRON_SECRET to be set and
 * matched — Vercel sends it as a bearer token on cron invocations.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!apiKeyConfigured()) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 503 }
    );
  }

  const origin = new URL(req.url).origin;
  const launched: string[] = [];
  const projects = await store.listProjects();

  for (const project of projects) {
    const intervalDays = INTERVAL_DAYS[project.schedule];
    if (!intervalDays) continue;
    const runs = await store.listRuns(project.id);
    if (runs.some((r) => r.status === "pending" || r.status === "running")) {
      continue;
    }
    const latest = runs[0];
    const dueSince = Date.now() - intervalDays * 24 * 3600 * 1000;
    if (latest && toUtcMs(latest.created_at) > dueSince) {
      continue;
    }
    const run = await store.createRun({
      projectId: project.id,
      model: CRON_MODEL,
      repeats: CRON_REPEATS,
    });
    if (process.env.VERCEL) {
      waitUntil(driveAndChain(run.id, origin));
    } else {
      void runInBackground(run.id);
    }
    launched.push(project.name);
  }

  return NextResponse.json({ ok: true, launched });
}
