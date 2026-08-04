import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { apiKeyConfigured } from "@/lib/engine/providers";
import { getBattery } from "@/lib/engine/suggest";
import { generatePromptBattery } from "@/lib/engine/prompts";

const schema = z.object({
  brand: z.string().trim().min(1),
  category: z.string().trim().min(1),
  competitors: z.array(z.string().trim().min(1)).max(12).default([]),
  audience: z.string().trim().optional(),
  // Explicit regenerate clicks want fresh variation, not the cached battery.
  force: z.boolean().default(false),
});

/** Generate an editable prompt battery for review before tracker creation. */
export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid input" },
      { status: 400 }
    );
  }
  const { brand, category, competitors } = parsed.data;
  const audience = parsed.data.audience || null;
  const prompts = apiKeyConfigured()
    ? await getBattery(
        { brand, category, competitors, audience },
        parsed.data.force
      )
    : generatePromptBattery({ brand, category, audience });
  return NextResponse.json({ prompts });
}
