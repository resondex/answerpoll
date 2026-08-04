import { NextResponse } from "next/server";
import { authEnabled, createSupabaseServer } from "@/lib/auth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (authEnabled()) {
    const code = url.searchParams.get("code");
    if (code) {
      const supabase = await createSupabaseServer();
      await supabase.auth.exchangeCodeForSession(code);
    }
  }
  return NextResponse.redirect(new URL("/app", url.origin));
}
