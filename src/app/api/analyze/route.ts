import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { apiKeyConfigured } from "@/lib/engine/providers";
import { suggestBrandProfile } from "@/lib/engine/suggest";

const schema = z.object({ brand: z.string().trim().min(1) });

/** Estimate category, competitors, and audience from a brand name. */
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
  const profile = await suggestBrandProfile(parsed.data.brand);
  return NextResponse.json({ profile });
}
