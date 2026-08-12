import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireAuth, requireProject } from "@/lib/auth";

/** Create a public share link for a tracker's dashboard: read-only, scoped
 * to this project, expiring after the chosen window. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const project = await requireProject(id, auth, { write: true });
  if (project instanceof NextResponse) return project;
  const body = (await req.json().catch(() => ({}))) as { ttl?: string };
  const hours = body.ttl === "48h" ? 48 : 7 * 24;
  const token = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  await store.cacheSet(
    `share:${token}`,
    JSON.stringify({ projectId: project.id, expiresAt })
  );
  return NextResponse.json({ token, expiresAt, path: `/share/${token}` });
}
