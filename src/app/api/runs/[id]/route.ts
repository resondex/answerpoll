import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireAuth, requireRun } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth);
  if (loaded instanceof NextResponse) return loaded;
  const { run } = loaded;
  const [prompts, completed] = await Promise.all([
    store.listPrompts(run.project_id),
    store.countResponses(id),
  ]);
  return NextResponse.json({
    run,
    completed,
    total: prompts.length * run.repeats,
  });
}
