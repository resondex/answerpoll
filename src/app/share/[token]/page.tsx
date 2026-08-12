"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import RunResults from "@/app/projects/[id]/run_results";

/**
 * The public face of a shared dashboard: same results surface the owner
 * sees, read-only — running, deleting, scheduling, and dictionary editing
 * are absent here and their APIs reject share sessions anyway.
 */
export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; brand: string; runId: string | null; expiresAt: string }
  >({ status: "loading" });

  useEffect(() => {
    fetch("/api/share/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "This link didn't work.");
        setState({
          status: "ready",
          brand: d.brand,
          runId: d.runId,
          expiresAt: d.expiresAt,
        });
      })
      .catch((e) =>
        setState({ status: "error", message: (e as Error).message })
      );
  }, [token]);

  if (state.status === "loading") {
    return (
      <main className="mx-auto max-w-6xl px-6 py-16">
        <p className="text-sm text-ink-3">Opening the shared dashboard…</p>
      </main>
    );
  }
  if (state.status === "error") {
    return (
      <main className="mx-auto max-w-6xl px-6 py-16">
        <h1 className="text-xl font-semibold mb-2">Link unavailable</h1>
        <p className="text-sm text-ink-2">{state.message}</p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-6xl px-6 py-10 grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {state.brand} — LLM visibility
        </h1>
        <p className="text-[13px] text-ink-3 mt-1">
          Shared read-only dashboard · link expires{" "}
          {new Date(state.expiresAt).toLocaleString()}
        </p>
      </div>
      {state.runId ? (
        <RunResults runId={state.runId} />
      ) : (
        <p className="text-sm text-ink-3">
          This tracker has no completed runs yet.
        </p>
      )}
    </main>
  );
}
