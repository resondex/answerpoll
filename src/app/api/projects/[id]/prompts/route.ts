import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";
import { requireAuth, requireProject } from "@/lib/auth";

const schema = z.object({
  action: z.literal("replace"),
  promptId: z.string().min(1),
  text: z.string().trim().min(4),
});

/**
 * Refield a flagged prompt: the old prompt is retired (its history stays
 * intact and attributed to its original text), and a new prompt with the
 * replacement text joins the battery for future runs.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth, { write: true });
  if (project instanceof NextResponse) return project;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }
  const prompts = await store.listPrompts(id);
  const old = prompts.find((p) => p.id === parsed.data.promptId);
  if (!old) {
    return NextResponse.json({ error: "prompt not found" }, { status: 404 });
  }
  await store.retirePrompt(old.id);
  const [created] = await store.insertPrompts(id, [
    { text: parsed.data.text, theme: old.theme },
  ]).then((all) => all.filter((p) => p.text === parsed.data.text && !p.retired));
  return NextResponse.json({ ok: true, replacement: created ?? null });
}
