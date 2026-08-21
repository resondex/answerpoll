import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";
import {
  getPlanFor,
  isStaff,
  PLAN_TRACKER_LIMITS,
  requireAuth,
} from "@/lib/auth";
import { generatePromptBattery } from "@/lib/engine/prompts";
import { getReasonTaxonomy, seedDictionary } from "@/lib/engine/suggest";
import { namesAnyBrand } from "@/lib/engine/instrument";
import { apiKeyConfigured, availableEngines, getEngine } from "@/lib/engine/providers";

const createSchema = z.object({
  name: z.string().trim().min(1).optional(),
  brand: z.string().trim().min(1),
  competitors: z.array(z.string().trim().min(1)).max(12).default([]),
  category: z.string().trim().min(1),
  audience: z.string().trim().optional(),
  /** The tracker's core engine panel — scheduled runs and headline metrics
   * use exactly this set. Defaults to the default-tier engine per vendor. */
  engines: z.array(z.string().trim().min(1)).max(8).optional(),
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
  /** Grid-built battery from /api/setup/grid, as reviewed in the setup UI.
   * Mutually exclusive with `prompts`; the classic path is untouched. */
  grid: z
    .object({
      moderators: z.record(z.string(), z.unknown()),
      cells: z
        .array(
          z.object({
            stage: z.string().trim().min(1),
            layer: z.string().trim().min(1),
            situation: z.string().trim().nullable(),
            angle: z.string().trim().min(1),
            text: z.string().trim().min(1),
            /** The confirmed paraphrase set for this cell; each becomes its
             * own prompt under the same intent. */
            phrasings: z.array(z.string().trim().min(1)).max(20).optional(),
          })
        )
        .min(4)
        .max(80),
    })
    .optional(),
});

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  // Staff see every tracker; members also see their orgs' trackers.
  let projects;
  if (auth.userId !== null && (await isStaff(auth))) {
    projects = await store.listProjects();
  } else {
    projects = await store.listProjects(auth.userId ?? undefined);
    if (auth.email) {
      const memberships = await store.listMembershipsForEmail(auth.email);
      const orgProjects = await store.listProjectsByOrgIds(
        memberships.map((m) => m.org_id)
      );
      const seen = new Set(projects.map((p) => p.id));
      projects = [...projects, ...orgProjects.filter((p) => !seen.has(p.id))];
    }
  }
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
  const requestedEngines = (parsed.data.engines ?? []).filter((m) =>
    getEngine(m)
  );
  const engineSet =
    requestedEngines.length > 0
      ? requestedEngines
      : availableEngines()
          .slice(0, 1)
          .map((e) => e.id);
  const grid = parsed.data.grid;
  const project = await store.createProject({
    name: parsed.data.name ?? brand,
    brand,
    competitors,
    category,
    audience,
    userId: auth.userId,
    reasonTaxonomy,
    engineSet,
    moderators: grid ? JSON.stringify(grid.moderators) : null,
    instrumentVersion: grid ? 1 : 0,
  });
  if (grid) {
    // Grid path: intents carry the stage identity; prompts carry the stage
    // as their theme UNLESS the text names the brand or a rival, in which
    // case the prompt stores "branded" so the unbranded funnel stays blind.
    // Each cell's seed prompt and its paraphrases all hang off one intent;
    // the theme is decided per prompt, so a paraphrase that names a brand is
    // fenced off individually even if its seed is blind.
    const intents = await store.insertIntents(
      project.id,
      grid.cells.map((c) => ({
        stage: c.stage, layer: c.layer, situation: c.situation, angle: c.angle, text: c.text,
      }))
    );
    await store.insertPrompts(
      project.id,
      grid.cells.flatMap((c, i) =>
        [c.text, ...(c.phrasings ?? [])].map((text) => ({
          text,
          theme: namesAnyBrand(text, brand, competitors) ? "branded" : c.stage,
          intentId: intents[i]?.id ?? null,
        }))
      )
    );
  } else {
    await store.insertPrompts(
      project.id,
      parsed.data.prompts ?? generatePromptBattery({ brand, category, audience })
    );
  }
  await seedDictionary(project.id, [brand, ...competitors]);
  return NextResponse.json({ project }, { status: 201 });
}
