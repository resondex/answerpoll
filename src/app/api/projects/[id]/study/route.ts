import { NextResponse } from "next/server";
import { requireAuth, requireProject } from "@/lib/auth";
import { buildStudyBundle } from "@/lib/engine/study";

export const maxDuration = 120;

/** Download the full study bundle (zip) for a tracker. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth);
  if (project instanceof NextResponse) return project;

  const bundle = await buildStudyBundle(project);
  if (!bundle) {
    return NextResponse.json(
      { error: "a completed run is required before a study can be exported" },
      { status: 409 }
    );
  }
  return new NextResponse(new Uint8Array(bundle.buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${bundle.filename}"`,
    },
  });
}
