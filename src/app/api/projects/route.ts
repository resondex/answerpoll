import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";
import {
  getPlanFor,
  PLAN_TRACKER_LIMITS,
  requireAuth,
} from "@/lib/auth";
import { generatePromptBattery } from "@/lib/engine/prompts";
import { getReasonTaxonomy, seedDictionary } from "@/lib/engine/suggest";
import { apiKeyConfigured } from "@/lib/engine/providers";

const createSchema = z.object({
  name: z.string().trim().min(1).optional(),
  brand: z.string().trim().min(1),
  competitors: z.array(z.string().trim().min(1)).max(12).default([]),
  category: z.string().trim().min(1),
  audience: z.string().trim().optional(),
  // User-reviewed battery from /api/prompts/generate; templates when absent.
  prompts: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        theme: z.enum([
          "discovery",
          "recommendation",
          "comparison",
          "use_case",
          "branded",
        ]),
      })
    )
    .min(4)
    .max(30)
    .optional(),
});

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const projects = await store.listProjects(auth.userId ?? undefined);
  const withRuns = await Promise.all(
    projects.map(async (p) => ({
      ...p,
      latestRun: (await store.listRuns(p.id))[0] ?? null,
    }))
  );
  return NextResponse.json({ projects: withRuns });
}

export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid input" },
      { status: 400 }
    );
  }

  if (auth.userId !== null) {
    const plan = await getPlanFor(auth);
    const existing = await store.listProjects(auth.userId);
    if (existing.length >= PLAN_TRACKER_LIMITS[plan]) {
      return NextResponse.json(
        {
          error: `The ${plan} plan includes ${PLAN_TRACKER_LIMITS[plan]} tracker${PLAN_TRACKER_LIMITS[plan] === 1 ? "" : "s"} — upgrade for more`,
        },
        { status: 403 }
      );
    }
  }

  const { brand, competitors, category } = parsed.data;
  const audience = parsed.data.audience || null;
  let reasonTaxonomy: string[] = [];
  if (apiKeyConfigured()) {
    try {
      reasonTaxonomy = await getReasonTaxonomy({ category, competitors });
    } catch (err) {
      console.error("taxonomy generation failed:", err);
    }
  }
  const project = await store.createProject({
    name: parsed.data.name ?? brand,
    brand,
    competitors,
    category,
    audience,
    userId: auth.userId,
    reasonTaxonomy,
  });
  await store.insertPrompts(
    project.id,
    parsed.data.prompts ?? generatePromptBattery({ brand, category, audience })
  );
  await seedDictionary(project.id, [brand, ...competitors]);
  return NextResponse.json({ project }, { status: 201 });
}
