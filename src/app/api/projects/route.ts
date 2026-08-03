import { NextResponse } from "next/server";
import { z } from "zod";
import { createProject, insertPrompts, listProjects, listRuns } from "@/lib/db";
import { generatePromptBattery } from "@/lib/engine/prompts";

const createSchema = z.object({
  name: z.string().trim().min(1).optional(),
  brand: z.string().trim().min(1),
  competitors: z.array(z.string().trim().min(1)).max(12).default([]),
  category: z.string().trim().min(1),
  audience: z.string().trim().optional(),
});

export async function GET() {
  const projects = listProjects().map((p) => ({
    ...p,
    latestRun: listRuns(p.id)[0] ?? null,
  }));
  return NextResponse.json({ projects });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid input" },
      { status: 400 }
    );
  }
  const { brand, competitors, category } = parsed.data;
  const audience = parsed.data.audience || null;
  const project = createProject({
    name: parsed.data.name ?? brand,
    brand,
    competitors,
    category,
    audience,
  });
  insertPrompts(project.id, generatePromptBattery({ brand, category, audience }));
  return NextResponse.json({ project }, { status: 201 });
}
