import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireAuth, requireRun } from "@/lib/auth";

/** Answer texts for one run, optionally filtered to a prompt — powers the
 * "show example answers" reveal in the prompt-health view. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth);
  if (loaded instanceof NextResponse) return loaded;
  const promptId = new URL(req.url).searchParams.get("promptId");
  const responses = (await store.listResponses(id))
    .filter((r) => !promptId || r.prompt_id === promptId)
    .map((r) => ({
      prompt_id: r.prompt_id,
      repeat_idx: r.repeat_idx,
      text: r.text,
    }));
  return NextResponse.json({ responses });
}
