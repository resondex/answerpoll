import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { store } from "@/lib/store";
import { requireAuth, requireProject } from "@/lib/auth";
import { apiKeyConfigured, engineAvailable } from "@/lib/engine/providers";
import { driveAndChain, runInBackground } from "@/lib/engine/runner";

// Vercel: runs execute as a chain of budgeted chunks — each invocation
// processes what fits under maxDuration, then hands off via /continue.
export const maxDuration = 300;

const runSchema = z.object({
  model: z.string().trim().min(1).default("gpt-5-mini"),
  /** Engines to sample. One answer per prompt × repeat × engine. */
  models: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
  repeats: z.number().int().min(1).max(20).default(5),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  if (!apiKeyConfigured()) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured — runs need a real key" },
      { status: 503 }
    );
  }
  const project = await requireProject(id, auth, { write: true });
  if (project instanceof NextResponse) return project;
  const body = await req.json().catch(() => ({}));
  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid input" },
      { status: 400 }
    );
  }
  // One run at a time per tracker: a double-click or second tab must not
  // start a second paid run while one is already in flight.
  const existing = await store.listRuns(id);
  if (existing.some((r) => r.status === "pending" || r.status === "running")) {
    return NextResponse.json(
      { error: "A run is already in progress for this tracker" },
      { status: 409 }
    );
  }
  const requested = parsed.data.models ?? [parsed.data.model];
  const models = requested.filter((m) => engineAvailable(m));
  if (models.length === 0) {
    return NextResponse.json(
      {
        error: `No API key configured for the requested engine(s): ${requested.join(", ")}`,
      },
      { status: 503 }
    );
  }
  const run = await store.createRun({
    projectId: id,
    model: models[0],
    models,
    repeats: parsed.data.repeats,
  });
  if (process.env.VERCEL) {
    waitUntil(driveAndChain(run.id, new URL(req.url).origin));
  } else {
    void runInBackground(run.id);
  }
  return NextResponse.json({ run }, { status: 201 });
}
