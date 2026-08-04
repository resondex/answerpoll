import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { apiKeyConfigured } from "@/lib/engine/providers";
import { getBrandProfile, getBattery } from "@/lib/engine/suggest";

const schema = z.object({ brand: z.string().trim().min(1) });

export const maxDuration = 120;

/**
 * One-shot tracker setup: estimate the brand's market (call 1), then draft
 * the prompt battery for that estimate (call 2), both cache-first with a
 * ~6-month TTL, returned together.
 */
export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  if (!apiKeyConfigured()) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 503 }
    );
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "brand required" }, { status: 400 });
  }
  const brand = parsed.data.brand;
  const profile = await getBrandProfile(brand);
  const prompts = await getBattery({
    brand,
    category: profile.category,
    competitors: profile.competitors,
    audience: profile.audience || null,
  });
  return NextResponse.json({ profile, prompts });
}
