import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { store } from "@/lib/store";
import { requireAuth, requireRun } from "@/lib/auth";
import { finalizeRun, recodeRun } from "@/lib/engine/runner";

export const maxDuration = 300;

/**
 * Re-code a completed run's stored answers under the current coder, without
 * re-collecting anything. Holds the answers constant so a coder change can be
 * measured on its own rather than confounded with day-to-day drift in what
 * the assistants say. Owner-only: it rewrites stored coding in place.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth, { write: true });
  if (loaded instanceof NextResponse) return loaded;
  if (loaded.run.status !== "complete") {
    return NextResponse.json(
      { error: "only a completed run can be re-coded" },
      { status: 409 }
    );
  }

  // Re-coding changes what every downstream number says, so the dictionary
  // queue and health check have to be rebuilt from the new coding too.
  const job = async () => {
    await recodeRun(id);
    await store.updateRunStatus(id, "running");
    await finalizeRun(id);
  };
  if (process.env.VERCEL) {
    waitUntil(job());
  } else {
    await job();
  }
  return NextResponse.json({ ok: true });
}
