import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { store } from "./store";
import type { Plan, Project, Run } from "./types";

/**
 * Auth is active only when the Supabase env vars exist. Without them the app
 * runs open (single-tenant dev mode) — same behavior it had before auth.
 */
export function authEnabled(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export async function createSupabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Components can't set cookies; middleware refreshes them.
          }
        },
      },
    }
  );
}

export interface AuthContext {
  /** null means auth is disabled — unscoped single-tenant mode. */
  userId: string | null;
  email: string | null;
}

/** Current auth context, or null when auth is on and nobody is signed in. */
export async function getAuth(): Promise<AuthContext | null> {
  if (!authEnabled()) return { userId: null, email: null };
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { userId: user.id, email: user.email ?? null };
}

export function canAccessProject(
  project: Project,
  auth: AuthContext
): boolean {
  // Unowned (legacy) projects stay reachable; claim them via SQL.
  return (
    auth.userId === null ||
    project.user_id === null ||
    project.user_id === auth.userId
  );
}

export async function getPlanFor(auth: AuthContext): Promise<Plan> {
  if (auth.userId === null) return "enterprise"; // dev mode: no limits
  return store.getPlan(auth.userId);
}

export const PLAN_TRACKER_LIMITS: Record<Plan, number> = {
  free: 1,
  pro: 5,
  enterprise: Number.POSITIVE_INFINITY,
};

/** Auth context, or a ready-to-return 401 when auth is on and nobody's in. */
export async function requireAuth(): Promise<AuthContext | NextResponse> {
  const auth = await getAuth();
  if (!auth) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  return auth;
}

/** Load a project the caller may access, or a 404 (no existence leaks). */
export async function requireProject(
  id: string,
  auth: AuthContext
): Promise<Project | NextResponse> {
  const project = await store.getProject(id);
  if (!project || !canAccessProject(project, auth)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return project;
}

/** Load a run whose project the caller may access, or a 404. */
export async function requireRun(
  id: string,
  auth: AuthContext
): Promise<{ run: Run; project: Project } | NextResponse> {
  const run = await store.getRun(id);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = await requireProject(run.project_id, auth);
  if (project instanceof NextResponse) return project;
  return { run, project };
}
