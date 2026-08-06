import { NextResponse } from "next/server";
import { requireAuth, requireRun } from "@/lib/auth";
import { apiKeyConfigured } from "@/lib/engine/providers";
import { buildRunInsights } from "@/lib/engine/insights";

export const maxDuration = 120;

/** Numbered insights + plays for a run — cache-first, gate-verified. The
 * same bundle threads through the exec summary, workbooks, and deck. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth);
  if (loaded instanceof NextResponse) return loaded;
  if (!apiKeyConfigured()) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 503 }
    );
  }
  const insights = await buildRunInsights(id);
  if (!insights) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ insights });
}
