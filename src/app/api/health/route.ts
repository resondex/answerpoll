import { NextResponse } from "next/server";
import { store } from "@/lib/store";

/** Reports whether the app can reach its database (no secrets in output). */
export async function GET() {
  const driver = process.env.DATABASE_URL ? "postgres" : "sqlite";
  try {
    await store.listProjects();
    return NextResponse.json({ ok: true, driver });
  } catch (err) {
    return NextResponse.json(
      { ok: false, driver, error: String(err) },
      { status: 500 }
    );
  }
}
