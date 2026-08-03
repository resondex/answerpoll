import { NextResponse } from "next/server";
import { computeProjectTrend } from "@/lib/engine/trend";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const trend = await computeProjectTrend(id);
  if (!trend) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ trend });
}
