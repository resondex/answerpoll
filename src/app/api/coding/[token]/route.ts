import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";
import {
  METRIC_DEFINITION,
  METRIC_QUESTION,
} from "@/lib/coding_questions";
import type { AssignmentItem } from "@/lib/engine/human_coding";

export const maxDuration = 60;

/**
 * The coder's side of a coding assignment, keyed by the link token alone —
 * coders are outside the product and have no account. The payload carries
 * only what coding needs: the sampled answers and the question. No metrics,
 * no LLM verdicts, no run identifiers — a coder can't be steered by the
 * machine's answer, and the token leaks nothing beyond its own sample.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!/^[a-f0-9]{32,64}$/.test(token)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const assignment = await store.getCodingAssignmentByToken(token);
  if (!assignment) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const items = JSON.parse(assignment.items) as AssignmentItem[];
  const [responses, prompts, project] = await Promise.all([
    store.listResponses(assignment.run_id),
    store.listPrompts(assignment.project_id),
    store.getProject(assignment.project_id),
  ]);
  const responseById = new Map(responses.map((r) => [r.id, r]));
  const promptById = new Map(prompts.map((p) => [p.id, p]));

  // A returning coder resumes where they left off.
  const url = new URL(req.url);
  const coder = url.searchParams.get("coder")?.trim().slice(0, 60);
  let codes: Record<string, boolean> = {};
  if (coder) {
    const all = await store.listHumanCodes(assignment.id);
    codes = Object.fromEntries(
      all
        .filter((c) => c.coder === coder)
        .map((c) => [`${c.response_id}|${c.brand_norm}`, c.verdict === 1])
    );
  }

  return NextResponse.json({
    name: assignment.name,
    metric: assignment.metric,
    question: METRIC_QUESTION[assignment.metric],
    definition: METRIC_DEFINITION[assignment.metric],
    category: project?.category ?? "",
    items: items.flatMap((it) => {
      const r = responseById.get(it.response_id);
      if (!r) return [];
      return [
        {
          responseId: it.response_id,
          brand: it.brand,
          brandNorm: it.brand_norm,
          prompt: promptById.get(r.prompt_id)?.text ?? "",
          text: r.text,
        },
      ];
    }),
    codes,
  });
}

const CodeBody = z.object({
  coder: z.string().trim().min(1).max(60),
  responseId: z.string().min(1),
  brandNorm: z.string().min(1),
  brand: z.string().min(1),
  verdict: z.boolean(),
});

/** Record one verdict; upserts so a coder can change their mind. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!/^[a-f0-9]{32,64}$/.test(token)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const assignment = await store.getCodingAssignmentByToken(token);
  if (!assignment) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsed = CodeBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { coder, responseId, brandNorm, brand, verdict } = parsed.data;
  // Verdicts only land on items in the frozen sample.
  const items = JSON.parse(assignment.items) as AssignmentItem[];
  const valid = items.some(
    (it) => it.response_id === responseId && it.brand_norm === brandNorm
  );
  if (!valid) {
    return NextResponse.json({ error: "not in this sample" }, { status: 400 });
  }
  await store.upsertHumanCode({
    assignmentId: assignment.id,
    responseId,
    metric: assignment.metric,
    brandNorm,
    brand,
    verdict,
    coder,
  });
  return NextResponse.json({ ok: true });
}
