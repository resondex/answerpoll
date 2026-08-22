import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";
import { requireAuth } from "@/lib/auth";

const saveSchema = z.object({
  id: z.string().uuid().optional(),
  brand: z.string().trim().min(1),
  category: z.string().trim().default(""),
  competitors: z.array(z.string().trim().min(1)).max(12).default([]),
  audience: z.string().trim().optional(),
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
    .nullable()
    .default(null),
  wizard: z.record(z.string(), z.unknown()).nullable().optional(),
});

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const drafts = await store.listSetupDrafts(auth.userId);
  return NextResponse.json({ drafts });
}

export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const parsed = saveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid input" },
      { status: 400 }
    );
  }
  if (parsed.data.id) {
    const existing = await store.getSetupDraft(parsed.data.id);
    if (existing && existing.user_id !== auth.userId && auth.userId !== null) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }
  const draft = await store.saveSetupDraft({
    id: parsed.data.id ?? null,
    userId: auth.userId,
    brand: parsed.data.brand,
    category: parsed.data.category,
    competitors: parsed.data.competitors,
    audience: parsed.data.audience || null,
    prompts: parsed.data.prompts,
    wizard: parsed.data.wizard ?? null,
  });
  return NextResponse.json({ draft }, { status: 201 });
}
