import { NextResponse } from "next/server";
import { authEnabled, createSupabaseServer } from "@/lib/auth";

export async function POST(req: Request) {
  if (authEnabled()) {
    const supabase = await createSupabaseServer();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/", new URL(req.url).origin), {
    status: 303,
  });
}
