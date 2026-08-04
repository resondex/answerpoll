import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireAuth } from "@/lib/auth";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const draft = await store.getSetupDraft(id);
  if (!draft || (auth.userId !== null && draft.user_id !== auth.userId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await store.deleteSetupDraft(id);
  return NextResponse.json({ ok: true });
}
