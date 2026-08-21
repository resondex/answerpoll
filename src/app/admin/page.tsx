"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { OrgRole } from "@/lib/types";

interface AdminData {
  staff: boolean;
  orgs: {
    id: string;
    name: string;
    members: { email: string; role: OrgRole }[];
  }[];
  projects: {
    id: string;
    name: string;
    brand: string;
    category: string;
    org_id: string | null;
    user_id: string | null;
    created_at: string;
  }[];
  staffEmails: string[];
}

const ROLES: OrgRole[] = ["admin", "editor", "viewer"];

/**
 * Admin portal. Staff see and manage everything; org admins see member
 * management for their orgs. Everyone else gets a 404-equivalent.
 */
export default function AdminPage() {
  const [data, setData] = useState<AdminData | null>(null);
  const [denied, setDenied] = useState(false);
  const [newOrg, setNewOrg] = useState("");
  const [invites, setInvites] = useState<Record<string, { email: string; role: OrgRole }>>({});
  const [newStaff, setNewStaff] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin");
    if (!res.ok) {
      setDenied(true);
      return;
    }
    setData(await res.json());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error ?? "action failed");
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (denied) {
    return (
      <div className="card px-6 py-10 text-center text-sm text-ink-3 max-w-lg mx-auto mt-16">
        Nothing to administer here.{" "}
        <Link href="/app" className="text-primary font-medium">
          Back to trackers →
        </Link>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid gap-4 max-w-4xl mx-auto mt-8">
        <div className="card h-24 animate-pulse" />
        <div className="card h-48 animate-pulse" />
      </div>
    );
  }

  const orgName = (id: string | null) =>
    data.orgs.find((o) => o.id === id)?.name ?? (id ? "(org)" : "—");

  return (
    <div className="grid gap-8 max-w-5xl mx-auto">
      <div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight">
            Admin{data.staff ? " — Procerno staff" : ""}
          </h1>
          <Link href="/app" className="text-sm font-medium text-primary hover:opacity-80">
            ← trackers
          </Link>
        </div>
        <p className="text-sm text-ink-2 mt-1.5">
          {data.staff
            ? `${data.orgs.length} orgs · ${data.projects.length} trackers · ${data.staffEmails.length} staff`
            : "Manage the members of your organizations."}
        </p>
      </div>

      {/* ---- Orgs ---- */}
      <section className="grid gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="section-label">Organizations</h2>
          {data.staff && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newOrg.trim()) return;
                void act({ action: "create_org", name: newOrg.trim() });
                setNewOrg("");
              }}
            >
              <input
                className="input w-56 text-sm"
                placeholder="new organization name"
                value={newOrg}
                onChange={(e) => setNewOrg(e.target.value)}
              />
              <button className="btn-primary px-3 py-1.5 text-[13px]" disabled={busy}>
                Create
              </button>
            </form>
          )}
        </div>
        {data.orgs.length === 0 && (
          <div className="card px-5 py-6 text-sm text-ink-3">
            No organizations yet{data.staff ? " — create one above, then assign trackers to it." : "."}
          </div>
        )}
        {data.orgs.map((org) => {
          const inv = invites[org.id] ?? { email: "", role: "viewer" as OrgRole };
          return (
            <div key={org.id} className="card p-5 grid gap-3">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{org.name}</span>
                <span className="text-xs text-ink-3">
                  {data.projects.filter((p) => p.org_id === org.id).length} trackers
                </span>
              </div>
              <div className="grid gap-1.5">
                {org.members.length === 0 && (
                  <span className="text-[13px] text-ink-3">No members yet.</span>
                )}
                {org.members.map((m) => (
                  <div key={m.email} className="flex items-center gap-3 text-sm">
                    <span className="min-w-56">{m.email}</span>
                    <select
                      className="input w-28 text-xs"
                      value={m.role}
                      onChange={(e) =>
                        act({
                          action: "upsert_member",
                          orgId: org.id,
                          email: m.email,
                          role: e.target.value,
                        })
                      }
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r === "editor" ? "read + write" : r === "viewer" ? "read only" : "admin"}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="text-ink-3 hover:text-danger text-sm"
                      onClick={() =>
                        act({ action: "remove_member", orgId: org.id, email: m.email })
                      }
                    >
                      remove
                    </button>
                  </div>
                ))}
              </div>
              <form
                className="flex gap-2 flex-wrap"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!inv.email.trim()) return;
                  void act({
                    action: "upsert_member",
                    orgId: org.id,
                    email: inv.email.trim(),
                    role: inv.role,
                  });
                  setInvites({ ...invites, [org.id]: { email: "", role: inv.role } });
                }}
              >
                <input
                  className="input w-64 text-sm"
                  placeholder="member email"
                  value={inv.email}
                  onChange={(e) =>
                    setInvites({ ...invites, [org.id]: { ...inv, email: e.target.value } })
                  }
                />
                <select
                  className="input w-32 text-sm"
                  value={inv.role}
                  onChange={(e) =>
                    setInvites({
                      ...invites,
                      [org.id]: { ...inv, role: e.target.value as OrgRole },
                    })
                  }
                >
                  <option value="admin">admin</option>
                  <option value="editor">read + write</option>
                  <option value="viewer">read only</option>
                </select>
                <button className="btn-primary px-3 py-1.5 text-[13px]" disabled={busy}>
                  Add member
                </button>
              </form>
            </div>
          );
        })}
        <p className="text-xs text-ink-3">
          Members are keyed by email and take effect the moment that person signs in — admins
          manage the org and its members, read + write runs studies and edits the dictionary,
          read only sees everything and changes nothing.
        </p>
      </section>

      {/* ---- Trackers ---- */}
      <section className="grid gap-3">
        <h2 className="section-label">Trackers</h2>
        <div className="card divide-y divide-line">
          {data.projects.map((p) => (
            <div key={p.id} className="flex items-center gap-4 px-5 py-3 text-sm flex-wrap">
              <Link
                href={`/projects/${p.id}`}
                className="font-semibold text-primary hover:opacity-80 min-w-40"
              >
                {p.name}
              </Link>
              <span className="text-ink-3 flex-1 truncate">
                {p.brand} · {p.category}
              </span>
              {data.staff ? (
                <label className="flex items-center gap-2 text-xs text-ink-3">
                  org
                  <select
                    className="input w-44 text-xs"
                    value={p.org_id ?? ""}
                    onChange={(e) =>
                      act({
                        action: "assign_project",
                        projectId: p.id,
                        orgId: e.target.value || null,
                      })
                    }
                  >
                    <option value="">— personal / unassigned —</option>
                    {data.orgs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="text-xs text-ink-3">{orgName(p.org_id)}</span>
              )}
            </div>
          ))}
          {data.projects.length === 0 && (
            <div className="px-5 py-6 text-sm text-ink-3">No trackers.</div>
          )}
        </div>
      </section>

      {/* ---- Staff (staff only) ---- */}
      {data.staff && (
        <section className="grid gap-3">
          <h2 className="section-label">Procerno staff</h2>
          <div className="card p-5 grid gap-2">
            {data.staffEmails.map((e) => (
              <div key={e} className="flex items-center gap-3 text-sm">
                <span className="min-w-56">{e}</span>
                <button
                  type="button"
                  className="text-ink-3 hover:text-danger"
                  onClick={() => act({ action: "remove_staff", email: e })}
                >
                  remove
                </button>
              </div>
            ))}
            <form
              className="flex gap-2 mt-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newStaff.trim()) return;
                void act({ action: "add_staff", email: newStaff.trim() });
                setNewStaff("");
              }}
            >
              <input
                className="input w-64 text-sm"
                placeholder="staff email"
                value={newStaff}
                onChange={(e) => setNewStaff(e.target.value)}
              />
              <button className="btn-primary px-3 py-1.5 text-[13px]" disabled={busy}>
                Add staff
              </button>
            </form>
            <p className="text-xs text-ink-3 mt-1">
              Staff have full access to every org, tracker, and this portal, and bypass plan
              limits.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
