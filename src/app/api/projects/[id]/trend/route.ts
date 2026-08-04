import { NextResponse } from "next/server";
import { requireAuth, requireProject } from "@/lib/auth";
import { computeProjectTrend } from "@/lib/engine/trend";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth);
  if (project instanceof NextResponse) return project;
  const trend = await computeProjectTrend(id);
  if (!trend) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ trend });
}
