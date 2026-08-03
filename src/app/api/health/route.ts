import { NextResponse } from "next/server";
import { store } from "@/lib/store";

/** Reports whether the app can reach its database (no secrets in output). */
export async function GET() {
  const driver = process.env.DATABASE_URL ? "postgres" : "sqlite";
  const env = {
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    mockForced: process.env.MOCK_LLM === "1",
  };
  try {
    await store.listProjects();
    return NextResponse.json({ ok: true, driver, ...env });
  } catch (err) {
    return NextResponse.json(
      { ok: false, driver, ...env, error: String(err) },
      { status: 500 }
    );
  }
}
