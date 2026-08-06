import { NextResponse } from "next/server";
import { requireAuth, requireProject } from "@/lib/auth";
import { apiKeyConfigured } from "@/lib/engine/providers";
import { getDictionarySuggestions } from "@/lib/engine/dict_suggest";

export const maxDuration = 120;

/**
 * AI pre-review of the pending dictionary queue. Returns proposed
 * dispositions only — nothing is applied without the batch confirm.
 * Cache-first: the expensive pass runs at run completion, so this is
 * normally an instant cache read.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth);
  if (project instanceof NextResponse) return project;
  if (!apiKeyConfigured()) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 503 }
    );
  }
  const suggestions = await getDictionarySuggestions(id, project.category);
  return NextResponse.json({ suggestions });
}
