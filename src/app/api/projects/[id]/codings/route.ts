import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { store } from "@/lib/store";
import { requireAuth, requireProject } from "@/lib/auth";
import {
  assignmentStats,
  llmVerdicts,
  sampleItems,
  type AssignmentItem,
} from "@/lib/engine/human_coding";
import type { CodingMetric } from "@/lib/types";

export const maxDuration = 60;

const CreateBody = z.object({
  runId: z.string().min(1),
  metric: z.enum(["mentioned", "recommended", "chosen", "negative"]),
  name: z.string().trim().max(80).optional(),
  sampleSize: z.number().int().min(5).max(500).optional(),
  brandScope: z.enum(["focus", "any"]).optional(),
});

/** Create a coding assignment: freeze the sample, mint the coder link. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth, { write: true });
  if (project instanceof NextResponse) return project;

  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { runId, metric, name, sampleSize, brandScope } = parsed.data;
  const run = await store.getRun(runId);
  if (!run || run.project_id !== project.id) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  if (run.status !== "complete") {
    return NextResponse.json(
      { error: "the run must finish before its answers can be sampled" },
      { status: 425 }
    );
  }

  const token = crypto.randomBytes(16).toString("hex");
  const items = await sampleItems(
    project,
    run,
    metric as CodingMetric,
    sampleSize ?? 50,
    brandScope ?? "any",
    token
  );
  if (items.length === 0) {
    return NextResponse.json(
      { error: "no answers qualify for this metric" },
      { status: 400 }
    );
  }

  const assignment = {
    id: crypto.randomUUID(),
    project_id: project.id,
    run_id: run.id,
    name: name || `${metric} · ${items.length} answers`,
    metric: metric as CodingMetric,
    items: JSON.stringify(items),
    token,
    created_by: auth.email,
    created_at: new Date().toISOString(),
  };
  await store.createCodingAssignment(assignment);
  return NextResponse.json({
    assignment: { ...assignment, items: undefined, itemCount: items.length },
    url: `/code/${token}`,
  });
}

/** List assignments with progress and human-vs-LLM agreement. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth, { write: true });
  if (project instanceof NextResponse) return project;

  const assignments = await store.listCodingAssignments(project.id);
  const out = [];
  for (const a of assignments) {
    const items = JSON.parse(a.items) as AssignmentItem[];
    const codes = await store.listHumanCodes(a.id);
    const llm = await llmVerdicts(project, a.run_id, a.metric, items);
    out.push({
      id: a.id,
      name: a.name,
      metric: a.metric,
      runId: a.run_id,
      url: `/code/${a.token}`,
      createdAt: a.created_at,
      stats: assignmentStats(a, codes, llm),
    });
  }
  return NextResponse.json({ assignments: out });
}
