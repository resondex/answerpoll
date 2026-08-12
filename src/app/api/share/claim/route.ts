import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { shareLinkFor } from "@/lib/auth";

/** Exchange a share token for a scoped read-only session cookie, plus the
 * ids the shared dashboard needs to render. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { token?: string } | null;
  const token = body?.token ?? "";
  const link = await shareLinkFor(token);
  if (!link) {
    return NextResponse.json(
      { error: "This share link is invalid or has expired." },
      { status: 404 }
    );
  }
  const project = await store.getProject(link.projectId);
  if (!project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const runs = await store.listRuns(project.id);
  const latest = runs.find((r) => r.status === "complete");
  const res = NextResponse.json({
    projectId: project.id,
    projectName: project.name,
    brand: project.brand,
    runId: latest?.id ?? null,
    expiresAt: link.expiresAt,
  });
  res.cookies.set("ap_share_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(link.expiresAt),
    path: "/",
  });
  return res;
}
