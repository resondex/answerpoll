import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { store } from "@/lib/store";
import { getAuth, canAccessProject } from "@/lib/auth";
import { driveAndChain, runInBackground } from "@/lib/engine/runner";

export const maxDuration = 300;

/**
 * Process the next chunk of an unfinished run. Reached two ways: the chunk
 * chain calls it server-to-server bearing CRON_SECRET (no cookies exist on
 * that path), and a signed-in owner can call it to resume a stuck run.
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

  const secret = process.env.CRON_SECRET;
  const chainAuthorized =
    Boolean(secret) && req.headers.get("authorization") === `Bearer ${secret}`;
  if (!chainAuthorized) {
    const auth = await getAuth();
    if (!auth) {
      return NextResponse.json({ error: "sign in required" }, { status: 401 });
    }
    const project = await store.getProject(run.project_id);
    if (!project || !canAccessProject(project, auth)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
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
