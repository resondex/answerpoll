"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Project, Run, SetupDraft } from "@/lib/types";
import type { EngineOption } from "@/app/components/engine_picker";
import { SetupWizard, STEP_LABEL, type SetupMode } from "./setup_wizard";

type ProjectWithRun = Project & { latestRun: Run | null };

export default function AppHomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectWithRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [brand, setBrand] = useState("");
  const [drafts, setDrafts] = useState<SetupDraft[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [engineOptions, setEngineOptions] = useState<EngineOption[]>([]);
  // The open setup, if any: which question set, which brand, resuming what.
  const [wizard, setWizard] = useState<{ mode: SetupMode; brand: string; draft: SetupDraft | null } | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .finally(() => setLoaded(true));
    void refreshDrafts();
    fetch("/api/admin").then((r) => setIsAdmin(r.ok)).catch(() => {});
    fetch("/api/engines")
      .then((r) => r.json())
      .then((d) => setEngineOptions((d.engines ?? []) as EngineOption[]))
      .catch(() => {});
  }, []);

  async function refreshDrafts() {
    const res = await fetch("/api/drafts");
    if (res.ok) setDrafts((await res.json()).drafts ?? []);
  }

  function start(mode: SetupMode) {
    if (!brand.trim()) return;
    setWizard({ mode, brand: brand.trim(), draft: null });
  }

  function resumeDraft(d: SetupDraft) {
    const mode = ((d.wizard as { mode?: SetupMode } | null)?.mode ?? "classic") as SetupMode;
    setWizard({ mode, brand: d.brand, draft: d });
  }

  async function deleteDraft(id: string) {
    await fetch(`/api/drafts/${id}`, { method: "DELETE" });
    setDrafts(drafts.filter((d) => d.id !== id));
  }

  function draftStatus(d: SetupDraft): string {
    const w = d.wizard as { mode?: SetupMode; step?: keyof typeof STEP_LABEL } | null;
    const set = w?.mode === "grid" ? "Buyer Landscape" : "Visibility scan";
    const at = w?.step ? STEP_LABEL[w.step] : d.prompts ? "prompts written" : "setup in progress";
    return `${set} · ${at}`;
  }

  return (
    <div className="grid gap-10 max-w-2xl">
      <section>
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">Your trackers</h1>
          {isAdmin && (
            <Link href="/admin" className="text-sm font-medium text-primary hover:opacity-80">
              Admin →
            </Link>
          )}
        </div>
        <p className="text-[15px] text-ink-2 mb-8 leading-relaxed max-w-lg">
          One tracker per brand and category - every run samples the questions
          your buyers ask and scores who gets named.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            start("grid");
          }}
          className="card p-6 grid gap-4"
        >
          <div className="section-label">New tracker</div>
          <label className="grid gap-1.5 text-sm font-medium">
            Your brand
            <input
              className="input w-full"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="e.g. Resondex"
              required
            />
            <span className="text-xs font-normal text-ink-3">
              We&apos;ll estimate your market - you review everything before it runs.
            </span>
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => start("grid")}
              disabled={!brand.trim()}
              className="btn-primary text-left px-4 py-3"
            >
              <span className="flex flex-col items-start gap-0.5">
                <span>Start Buyer Landscape</span>
                <span className="text-[11px] font-normal opacity-80">
                  every stage of your buyer&apos;s decision, composed for your category
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => start("classic")}
              disabled={!brand.trim()}
              className="rounded-lg border border-line px-4 py-3 text-left grid gap-0.5 text-sm font-medium text-ink hover:border-primary disabled:opacity-50"
            >
              <span>Start Visibility scan</span>
              <span className="text-[11px] font-normal text-ink-3">
                the standard GEO battery, running in minutes
              </span>
            </button>
          </div>
        </form>
      </section>

      {drafts.length > 0 && (
        <section>
          <h2 className="section-label mb-3">Saved setups</h2>
          <ul className="grid gap-2">
            {drafts.map((d) => (
              <li key={d.id} className="card flex items-center justify-between gap-4 px-5 py-3.5">
                <div className="min-w-0">
                  <span className="font-semibold text-[15px]">{d.brand}</span>
                  <span className="text-[13px] text-ink-2"> · {draftStatus(d)}</span>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <button
                    type="button"
                    onClick={() => resumeDraft(d)}
                    className="text-sm font-semibold text-primary hover:opacity-80"
                  >
                    Continue →
                  </button>
                  <button
                    type="button"
                    aria-label={`delete ${d.brand} setup`}
                    onClick={() => deleteDraft(d.id)}
                    className="text-ink-3 hover:text-danger text-lg leading-none"
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="section-label mb-3">Trackers</h2>
        {!loaded ? (
          <div className="grid gap-2">
            <div className="card h-[72px] animate-pulse" />
            <div className="card h-[72px] animate-pulse" />
          </div>
        ) : projects.length === 0 ? (
          <div className="card px-5 py-8 text-center text-sm text-ink-3">
            Your first tracker will appear here.
          </div>
        ) : (
          <ul className="grid gap-2">
            {projects.map((p) => (
              <li key={p.id}>
                <Link href={`/projects/${p.id}`} className="card block px-5 py-4 transition-colors hover:border-primary">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-semibold text-[15px]">{p.name}</span>
                    <RunHint run={p.latestRun} />
                  </div>
                  <div className="text-[13px] text-ink-2 mt-1">
                    {p.brand} · {p.category}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The setup sheet: a large dialog over the trackers. Clicking outside
          does nothing on purpose - closing saves, and only the × or Escape
          closes, so minutes of generation can't be lost to a stray click. */}
      {wizard && (
        <div className="fixed inset-0 z-50 bg-black/40 p-[3vh_3vw]">
          <div
            role="dialog"
            aria-modal="true"
            className="card mx-auto h-full w-full max-w-[1200px] overflow-hidden bg-surface"
          >
            <SetupWizard
              key={wizard.draft?.id ?? `${wizard.mode}:${wizard.brand}`}
              mode={wizard.mode}
              brand={wizard.brand}
              draft={wizard.draft}
              engineOptions={engineOptions}
              onClose={() => setWizard(null)}
              onCreated={(id) => router.push(`/projects/${id}`)}
              onDraftsChanged={() => void refreshDrafts()}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function RunHint({ run }: { run: Run | null }) {
  if (!run) return <span className="text-xs text-ink-3">ready to run</span>;
  const map: Record<Run["status"], { label: string; cls: string }> = {
    pending: { label: "queued", cls: "text-ink-3" },
    running: { label: "running", cls: "text-primary" },
    complete: { label: "measured", cls: "text-success" },
    failed: { label: "run failed", cls: "text-danger" },
  };
  const s = map[run.status];
  return <span className={`text-xs font-medium ${s.cls}`}>{s.label}</span>;
}
