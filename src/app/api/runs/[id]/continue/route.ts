import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { store } from "@/lib/store";
import { driveAndChain, runInBackground } from "@/lib/engine/runner";

export const maxDuration = 300;

/**
 * Process the next chunk of an unfinished run. Called by the chunk chain on
 * Vercel; also safe to call manually to resume a run a killed function left
 * stuck in "running".
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const run = await store.getRun(id);
  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (run.status === "complete" || run.status === "failed") {
    return NextResponse.json({ run });
  }
  if (process.env.VERCEL) {
    waitUntil(driveAndChain(id, new URL(req.url).origin));
  } else {
    void runInBackground(id);
  }
  return NextResponse.json({ resumed: true }, { status: 202 });
}
