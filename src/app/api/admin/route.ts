import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";
import { isStaff, requireAuth } from "@/lib/auth";
import type { Org, OrgMember } from "@/lib/types";

/**
 * Admin surface. Two privilege levels:
 * - Procerno staff (staff_users / STAFF_EMAILS): everything — all orgs,
 *   all trackers, org assignment, staff management.
 * - Org admins: member management for the orgs they administer.
 * Everyone else: 404 (no existence leak).
 */

async function adminContext(auth: { userId: string | null; email: string | null }) {
  const staff = auth.userId === null ? true : await isStaff(auth);
  const memberships = auth.email
    ? await store.listMembershipsForEmail(auth.email)
    : [];
  const adminOrgIds = memberships
    .filter((m) => m.role === "admin")
    .map((m) => m.org_id);
  return { staff, adminOrgIds };
}

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { staff, adminOrgIds } = await adminContext(auth);
  if (!staff && adminOrgIds.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const allOrgs = await store.listOrgs();
  const orgs: (Org & { members: OrgMember[] })[] = [];
  for (const org of allOrgs) {
    if (!staff && !adminOrgIds.includes(org.id)) continue;
    orgs.push({ ...org, members: await store.listOrgMembers(org.id) });
  }

  const projects = staff
    ? await store.listProjects()
    : await store.listProjectsByOrgIds(adminOrgIds);

  return NextResponse.json({
    staff,
    orgs,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      category: p.category,
      org_id: p.org_id,
      user_id: p.user_id,
      created_at: p.created_at,
    })),
    staffEmails: staff ? await store.listStaff() : [],
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_org"), name: z.string().trim().min(1).max(80) }),
  z.object({
    action: z.literal("upsert_member"),
    orgId: z.string().min(1),
    email: z.string().trim().email(),
    role: z.enum(["admin", "editor", "viewer"]),
  }),
  z.object({
    action: z.literal("remove_member"),
    orgId: z.string().min(1),
    email: z.string().trim().email(),
  }),
  z.object({
    action: z.literal("assign_project"),
    projectId: z.string().min(1),
    orgId: z.string().min(1).nullable(),
  }),
  z.object({ action: z.literal("add_staff"), email: z.string().trim().email() }),
  z.object({ action: z.literal("remove_staff"), email: z.string().trim().email() }),
]);

export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { staff, adminOrgIds } = await adminContext(auth);
  if (!staff && adminOrgIds.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  const a = parsed.data;

  // Org admins may only manage members of their own orgs.
  const orgAllowed = (orgId: string) => staff || adminOrgIds.includes(orgId);

  switch (a.action) {
    case "create_org": {
      if (!staff) return NextResponse.json({ error: "staff only" }, { status: 403 });
      const org = await store.createOrg(a.name);
      return NextResponse.json({ ok: true, org });
    }
    case "upsert_member": {
      if (!orgAllowed(a.orgId)) {
        return NextResponse.json({ error: "not your org" }, { status: 403 });
      }
      await store.upsertOrgMember(a.orgId, a.email, a.role);
      return NextResponse.json({ ok: true });
    }
    case "remove_member": {
      if (!orgAllowed(a.orgId)) {
        return NextResponse.json({ error: "not your org" }, { status: 403 });
      }
      await store.removeOrgMember(a.orgId, a.email);
      return NextResponse.json({ ok: true });
    }
    case "assign_project": {
      if (!staff) return NextResponse.json({ error: "staff only" }, { status: 403 });
      await store.setProjectOrg(a.projectId, a.orgId);
      return NextResponse.json({ ok: true });
    }
    case "add_staff": {
      if (!staff) return NextResponse.json({ error: "staff only" }, { status: 403 });
      await store.addStaff(a.email);
      return NextResponse.json({ ok: true });
    }
    case "remove_staff": {
      if (!staff) return NextResponse.json({ error: "staff only" }, { status: 403 });
      if (a.email.toLowerCase() === auth.email?.toLowerCase()) {
        return NextResponse.json(
          { error: "you cannot remove your own staff access" },
          { status: 400 }
        );
      }
      await store.removeStaff(a.email);
      return NextResponse.json({ ok: true });
    }
  }
}
