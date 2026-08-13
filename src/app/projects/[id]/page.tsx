"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import TrendChart from "./trend_chart";
import RunResults from "./run_results";
import IdentifyTab from "./identify_tab";
import ParentsTab from "./parents_tab";
import {
  EnginePicker,
  type EngineOption,
} from "@/app/components/engine_picker";
import type {
  DictionaryEntry,
  Project,
  ProjectTrend,
  Prompt,
  Run,
  RunSchedule,
} from "@/lib/types";

interface Detail {
  project: Project;
  prompts: Prompt[];
  runs: Run[];
}

interface Progress {
  completed: number;
  total: number;
}

type OpenModal =
  | "run"
  | "schedule"
  | "history"
  | "dictionary"
  | "health"
  | null;

export default function ProjectPage() {
  return (
    <Suspense>
      <ProjectDashboard />
    </Suspense>
  );
}

function ProjectDashboard() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [trend, setTrend] = useState<ProjectTrend | null>(null);
  const [dict, setDict] = useState<DictionaryEntry[]>([]);
  const [engines, setEngines] = useState<EngineOption[]>([]);
  const [chosenEngines, setChosenEngines] = useState<string[]>([]);
  const [repeats, setRepeats] = useState(5);
  const [launching, setLaunching] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [openModal, setOpenModal] = useState<OpenModal>(null);
  const [dictTab, setDictTab] = useState<"identify" | "parents" | "analyze">(
    "identify"
  );
  // Example answers revealed per prompt in the prompt-health view.
  const [examples, setExamples] = useState<
    Record<string, string[] | "loading">
  >({});
  // Which run's results are shown. null = follow the latest complete run;
  // set explicitly when the user picks a run (or arrives via ?run=).
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    searchParams.get("run")
  );
  // Bumped after dictionary edits so RunResults refetches — dictionary
  // decisions apply retroactively at read time.
  const [dictVersion, setDictVersion] = useState(0);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/projects/${id}`);
    if (!res.ok) return;
    const d: Detail = await res.json();
    setDetail(d);
    const active = d.runs.find(
      (r) => r.status === "pending" || r.status === "running"
    );
    if (active) {
      const pr = await fetch(`/api/runs/${active.id}`);
      if (pr.ok) {
        const pd = await pr.json();
        setProgress({ completed: pd.completed, total: pd.total });
      }
    } else {
      setProgress(null);
    }
    if (d.runs.filter((r) => r.status === "complete").length >= 2) {
      const tr = await fetch(`/api/projects/${id}/trend`);
      if (tr.ok) setTrend((await tr.json()).trend);
    }
    const dr = await fetch(`/api/projects/${id}/dictionary`);
    if (dr.ok) setDict((await dr.json()).entries ?? []);
    // Runs default to the tracker's core engine panel.
    setChosenEngines((prev) =>
      prev.length > 0 ? prev : (d.project.engine_set ?? [])
    );
  }, [id]);

  async function refreshDict() {
    const dr = await fetch(`/api/projects/${id}/dictionary`);
    if (dr.ok) setDict((await dr.json()).entries ?? []);
    setDictVersion((v) => v + 1);
  }

  async function dictAction(entryId: string, action: "approve" | "reject") {
    await fetch(`/api/projects/${id}/dictionary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId, action }),
    });
    await refreshDict();
  }

  async function setSchedule(schedule: RunSchedule) {
    setDetail((d) => (d ? { ...d, project: { ...d.project, schedule } } : d));
    await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule }),
    });
  }

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Engine roster: which assistants this deployment can actually reach.
  useEffect(() => {
    fetch("/api/engines")
      .then((r) => r.json())
      .then((d) => {
        const list: EngineOption[] = d.engines ?? [];
        setEngines(list);
      })
      .catch(() => {});
  }, []);

  const hasActiveRun = detail?.runs.some(
    (r) => r.status === "pending" || r.status === "running"
  );
  const activeRunId =
    detail?.runs.find((r) => r.status === "pending" || r.status === "running")
      ?.id ?? null;

  // Live progress is a LIGHT poll: one tiny request for the counter. The
  // heavy refresh (dictionary included) runs on load, on completion, and
  // after edits — never on the tick, so an open Identify board can't have
  // its in-progress layout reset by background polling.
  useEffect(() => {
    if (!activeRunId) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/runs/${activeRunId}`);
        if (!res.ok) return;
        const d = await res.json();
        setProgress({ completed: d.completed, total: d.total });
        if (d.run.status !== "pending" && d.run.status !== "running") {
          await refresh();
        }
      } catch {
        // transient network noise — the next tick retries
      }
    }, 2500);
    return () => clearInterval(t);
  }, [activeRunId, refresh]);

  async function launchRun() {
    if (launching || hasActiveRun) return;
    setLaunching(true);
    setRunError(null);
    try {
      const res = await fetch(`/api/projects/${id}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: chosenEngines[0] ?? "gpt-5-mini",
          models: chosenEngines,
          repeats,
        }),
      });
      // A rejected run used to fail silently: the button re-enabled and
      // nothing happened, which is indistinguishable from a click that
      // never registered. Say what went wrong instead.
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setRunError(
          body?.error ??
            `The run could not start (${res.status}). Try again, or check that the engines you picked have API keys.`
        );
        return;
      }
      // Stay in the launching state until the refreshed run list shows the
      // active run — otherwise the button re-enables for a beat in between.
      await refresh();
      setOpenModal(null);
    } catch {
      setRunError(
        "Could not reach the server to start the run. Check your connection and try again."
      );
    } finally {
      setLaunching(false);
    }
  }

  if (!detail) {
    return (
      <div className="grid gap-4">
        <div className="card h-24 animate-pulse" />
        <div className="card h-48 animate-pulse" />
      </div>
    );
  }
  const { project, prompts, runs } = detail;
  const activePromptCount = prompts.filter((p) => p.retired === 0).length;
  const totalCalls =
    activePromptCount * repeats * Math.max(chosenEngines.length, 1);
  const completeRuns = runs.filter((r) => r.status === "complete");
  // Selected run must still exist and be complete; otherwise show latest.
  const shownRun =
    completeRuns.find((r) => r.id === selectedRunId) ?? completeRuns[0] ?? null;
  const activeRun = runs.find(
    (r) => r.status === "pending" || r.status === "running"
  );
  const pendingDict = dict.filter((e) => e.status === "pending").length;
  const flaggedPrompts = prompts.filter(
    (p) => p.flagged === 1 && p.retired === 0
  );
  // The Run button's task bubble: nothing measured yet and nothing running.
  const needsFirstRun = completeRuns.length === 0 && !activeRun;

  return (
    <div className="grid gap-8">
      <div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.name} — LLM visibility
          </h1>
          <Link
            href="/"
            className="text-sm font-medium text-primary hover:opacity-80"
          >
            ← all trackers
          </Link>
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap mt-1.5">
          <span className="flex items-center gap-4">
            <ShareButton projectId={id} />
            <button
              type="button"
              onClick={async () => {
                if (
                  !confirm(
                    `Delete the "${project.name}" tracker and all its runs? This cannot be undone.`
                  )
                )
                  return;
                await fetch(`/api/projects/${id}`, { method: "DELETE" });
                window.location.href = "/app";
              }}
              className="text-[13px] font-medium text-ink-3 hover:text-danger"
            >
              Delete tracker
            </button>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <TaskButton
          label={
            activeRun
              ? "Run in progress…"
              : "Run"
          }
          primary
          bubble={needsFirstRun ? "dot" : null}
          onClick={() => setOpenModal("run")}
        />
        <TaskButton
          label="Schedule"
          bubble={null}
          onClick={() => setOpenModal("schedule")}
        />
        <TaskButton
          label="Run history"
          bubble={null}
          onClick={() => setOpenModal("history")}
        />
        <TaskButton
          label="Brand dictionary"
          bubble={pendingDict > 0 ? pendingDict : null}
          onClick={() => {
            setDictTab("identify");
            setOpenModal("dictionary");
          }}
        />
        <TaskButton
          label="Prompt health"
          bubble={flaggedPrompts.length > 0 ? flaggedPrompts.length : null}
          onClick={() => setOpenModal("health")}
        />
        {activeRun && progress && (
          <div className="flex items-center gap-3 ml-1">
            <ProgressBar
              completed={progress.completed}
              total={progress.total}
            />
          </div>
        )}
      </div>

      {shownRun ? (
        <>
          {completeRuns.length > 1 && (
            <div className="flex items-center gap-3 -mb-2">
              <span className="section-label">Results</span>
              <select
                className="input w-auto text-[13px]"
                value={shownRun.id}
                onChange={(e) => setSelectedRunId(e.target.value)}
              >
                {completeRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.created_at.slice(0, 10)} · {r.model} · {r.repeats}{" "}
                    repeats
                  </option>
                ))}
              </select>
            </div>
          )}
          <RunResults
            key={shownRun.id}
            runId={shownRun.id}
            refreshToken={dictVersion}
          />
        </>
      ) : (
        !activeRun && (
          <div className="card px-5 py-10 text-center text-sm text-ink-3">
            Launch your first run to start measuring — results land here.
          </div>
        )
      )}

      {trend && trend.runs.length >= 2 && (
        <section className="card p-6">
          <h2 className="section-label mb-1">Trend</h2>
          <p className="text-[13px] text-ink-3 mb-4">
            {project.brand} vs. named competitors across {trend.runs.length}{" "}
            completed runs.
          </p>
          <TrendChart trend={trend} />
        </section>
      )}



      {openModal === "run" && (
        <Modal title="Run the battery" onClose={() => setOpenModal(null)}>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <span className="text-sm font-medium">Engines to measure</span>
              <p className="text-[13px] text-ink-3 -mt-1">
                Pre-checked = the tracker&apos;s core panel: headline numbers
                and the trend always compute over it, and scheduled runs
                sample exactly it. Extra engines you add here are bonus views
                — shown in the by-engine table, kept out of the headline so
                the trend stays comparable.
              </p>
              <EnginePicker
                options={engines}
                selected={chosenEngines}
                onToggle={(engId, checked) =>
                  setChosenEngines((prev) =>
                    checked
                      ? [...prev, engId]
                      : prev.filter((m) => m !== engId)
                  )
                }
                onPreset={(list) => setChosenEngines(list)}
                badge={(engId) =>
                  (detail?.project.engine_set ?? []).includes(engId) ? (
                    <span className="rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                      core
                    </span>
                  ) : null
                }
              />
            </div>
            {runError && (
              <p className="rounded-lg border border-danger/40 bg-danger/5 px-3.5 py-2.5 text-[13px] text-danger">
                {runError}
              </p>
            )}
            <div className="flex flex-wrap items-end gap-4">
              <label className="grid gap-1.5 text-sm font-medium">
                Repeats per prompt
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={repeats}
                  onChange={(e) => setRepeats(Number(e.target.value))}
                  className="input w-24"
                />
              </label>
              <button
                onClick={async () => {
                  await launchRun();
                  setOpenModal(null);
                }}
                disabled={launching || hasActiveRun || chosenEngines.length === 0}
                className="btn-primary inline-flex items-center gap-2"
              >
                {launching && (
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin"
                  />
                )}
                {launching
                  ? "Starting…"
                  : hasActiveRun
                    ? "Run in progress…"
                    : `Run ${totalCalls} queries`}
              </button>
            </div>
            <p className="text-[13px] text-ink-3">
              {activePromptCount} prompts × {repeats} repeats ×{" "}
              {chosenEngines.length || 0} engine
              {chosenEngines.length === 1 ? "" : "s"} = {totalCalls} answers.
              More repeats tighten the confidence intervals; more engines widen
              the coverage.
            </p>
          </div>
        </Modal>
      )}

      {openModal === "schedule" && (
        <Modal title="Automatic runs" onClose={() => setOpenModal(null)}>
          <div className="grid gap-3">
            <label className="grid gap-1.5 text-sm font-medium max-w-48">
              Cadence
              <select
                value={project.schedule}
                onChange={(e) => setSchedule(e.target.value as RunSchedule)}
                className="input"
              >
                <option value="none">off</option>
                <option value="weekly">weekly</option>
                <option value="monthly">monthly</option>
              </select>
            </label>
            <p className="text-[13px] text-ink-3">
              {project.schedule === "none"
                ? "Off — runs only fire when you launch them."
                : `Automatic ${project.schedule} runs fire at the daily 06:00 UTC check, using the latest battery and 5 repeats.`}{" "}
              Scheduled runs sample the core engine panel below — same
              prompts, same engines, comparable over time.
            </p>
            <div className="border-t border-line pt-4 grid gap-2">
              <span className="text-sm font-medium">Core engine panel</span>
              <p className="text-[13px] text-ink-3 -mt-1">
                The instrument&apos;s engine set: headline numbers and the
                trend compute over exactly these. Changing it starts a new
                trend epoch — earlier runs stay, but the line breaks there.
              </p>
              <EnginePicker
                options={engines}
                selected={project.engine_set ?? []}
                onToggle={async (engId, checked) => {
                  const next = checked
                    ? [...(project.engine_set ?? []), engId]
                    : (project.engine_set ?? []).filter((m) => m !== engId);
                  if (next.length === 0) return;
                  setDetail((d) =>
                    d
                      ? { ...d, project: { ...d.project, engine_set: next } }
                      : d
                  );
                  setChosenEngines(next);
                  await fetch(`/api/projects/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ engines: next }),
                  });
                }}
              />
            </div>
          </div>
        </Modal>
      )}

      {openModal === "history" && (
        <Modal title="Run history" onClose={() => setOpenModal(null)}>

          <ul className="grid gap-2">
            {runs.map((r) => {
              const active = r.status === "pending" || r.status === "running";
              const shown = shownRun?.id === r.id;
              return (
                <li
                  key={r.id}
                  className={`card flex items-center justify-between gap-4 px-5 py-3.5 ${
                    shown ? "border-primary/40" : ""
                  }`}
                >
                  <div className="text-sm min-w-0">
                    <span className="font-semibold">{r.model}</span>
                    <span className="text-ink-3">
                      {" "}
                      · {r.repeats} repeats · {r.created_at}
                    </span>
                    {r.error && (
                      <span className="text-danger"> · {r.error}</span>
                    )}
                    {active && progress && (
                      <ProgressBar
                        completed={progress.completed}
                        total={progress.total}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <StatusBadge status={r.status} />
                    {r.status === "complete" &&
                      (shown ? (
                        <span className="text-xs font-semibold uppercase tracking-wide text-primary">
                          shown above
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedRunId(r.id);
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          }}
                          className="text-sm font-semibold text-primary hover:opacity-80"
                        >
                          View results ↑
                        </button>
                      ))}
                    {!active && (
                      <button
                        type="button"
                        aria-label="delete run"
                        onClick={async () => {
                          if (!confirm("Delete this run and its data?")) return;
                          await fetch(`/api/runs/${r.id}`, {
                            method: "DELETE",
                          });
                          refresh();
                        }}
                        className="text-ink-3 hover:text-danger text-lg leading-none"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Modal>
      )}

      {openModal === "dictionary" && (
        <Modal
          title="Brand dictionary"
          wide
          tall
          onClose={() => setOpenModal(null)}
          subheader={
            <div className="flex gap-1 border-b border-line">
              {(
                [
                  [
                    "identify",
                    `Identify${pendingDict > 0 ? ` (${pendingDict})` : ""}`,
                  ],
                  ["parents", "Parents"],
                  ["analyze", "Analyze"],
                ] as const
              ).map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setDictTab(tab)}
                  className={`px-3 py-2 text-sm font-semibold -mb-px border-b-2 ${
                    dictTab === tab
                      ? "border-primary text-ink"
                      : "border-transparent text-ink-3 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        >
          {dictTab === "identify" && (
            <IdentifyTab projectId={id} dict={dict} onApplied={refreshDict} />
          )}
          {dictTab === "parents" && (
            <ParentsTab projectId={id} dict={dict} onApplied={refreshDict} />
          )}
          {dictTab === "analyze" && (
            <>
              <p className="text-[13px] text-ink-3 mb-4 -mt-1">
                Every grouping and whether it counts in the analysis, filed
                under its parent company. Excluded groupings stay in the raw
                data and can be re-included at any time — the metrics
                recompute retroactively.
              </p>
              {(() => {
                // Merge remnants live on as aliases of an active grouping —
                // they are not their own row anymore.
                const rows = dict
                  .filter((e) => e.status !== "pending")
                  .filter((e) => {
                    if (e.status !== "rejected") return true;
                    const n = e.canonical.trim().toLowerCase();
                    return !dict.some(
                      (x) => x.status === "active" && x.aliases.includes(n)
                    );
                  })
                  .sort((a, b) => a.canonical.localeCompare(b.canonical));
                const active = rows.filter((e) => e.status === "active");
                const excluded = rows.filter((e) => e.status === "rejected");
                const parents = [
                  ...new Set(
                    active
                      .map((e) => e.parent)
                      .filter((p): p is string => !!p)
                  ),
                ].sort((a, b) => a.localeCompare(b));
                const brandNorm = project.brand.trim().toLowerCase();
                const legacyComp = new Set(
                  project.competitors.map((c) => c.trim().toLowerCase())
                );
                const isTargetEntry = (e: DictionaryEntry) =>
                  e.canonical.trim().toLowerCase() === brandNorm ||
                  e.aliases.includes(brandNorm);
                const isCompetitor = (e: DictionaryEntry) =>
                  e.role
                    ? e.role === "competitor"
                    : legacyComp.has(e.canonical.trim().toLowerCase());
                const row = (e: DictionaryEntry, indent = false) => (
                  <div
                    key={e.id}
                    className={`flex items-center gap-3 text-sm border-b border-line/60 py-2 ${indent ? "ml-5" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={e.status === "active"}
                      onChange={() =>
                        dictAction(
                          e.id,
                          e.status === "active" ? "reject" : "approve"
                        )
                      }
                      className="h-4 w-4 accent-[var(--color-primary)] cursor-pointer"
                    />
                    <span
                      className={`font-medium ${e.status === "active" ? "" : "text-ink-3 line-through"}`}
                    >
                      {e.display_name ?? e.canonical}
                    </span>
                    {isTargetEntry(e) ? (
                      <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                        you
                      </span>
                    ) : (
                      e.status === "active" &&
                      e.canonical !== "Other" && (
                        <button
                          type="button"
                          title={
                            isCompetitor(e)
                              ? "Tracked competitor — click to demote to discovered"
                              : "Discovered by the model — click to track as a competitor"
                          }
                          onClick={async () => {
                            await fetch(`/api/projects/${id}/dictionary`, {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                              },
                              body: JSON.stringify({
                                entryId: e.id,
                                action: "set_role",
                                role: isCompetitor(e)
                                  ? "emerged"
                                  : "competitor",
                              }),
                            });
                            await refreshDict();
                          }}
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                            isCompetitor(e)
                              ? "bg-ink/10 text-ink"
                              : "border border-line text-ink-3 hover:text-ink hover:border-ink-3"
                          }`}
                        >
                          {isCompetitor(e) ? "competitor" : "discovered"}
                        </button>
                      )
                    )}
                    {e.aliases.length > 0 && (
                      <span className="text-xs text-ink-3 truncate flex-1">
                        groups: {e.aliases.join(", ")}
                      </span>
                    )}
                  </div>
                );
                return (
                  <div className="grid gap-4">
                    {parents.map((p) => (
                      <div key={p}>
                        <p className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-1">
                          {p}
                        </p>
                        <div className="grid gap-1">
                          {active
                            .filter((e) => e.parent === p)
                            .map((e) => row(e, true))}
                        </div>
                      </div>
                    ))}
                    <div>
                      {parents.length > 0 && (
                        <p className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-1">
                          Independent — each its own parent company
                        </p>
                      )}
                      <div className="grid gap-1">
                        {active
                          .filter((e) => !e.parent)
                          .map((e) => row(e, parents.length > 0))}
                      </div>
                    </div>
                    {excluded.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-1">
                          Excluded from analysis
                        </p>
                        <div className="grid gap-1">
                          {excluded.map((e) => row(e, parents.length > 0))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </>
          )}
          <p className="text-xs text-ink-3 mt-4">
            {pendingDict} pending ·{" "}
            {dict.filter((e) => e.status === "active").length} in analysis ·{" "}
            {dict.filter((e) => e.status === "rejected").length} excluded ·
            dictionary v{project.dictionary_version}
          </p>
        </Modal>
      )}

      {openModal === "health" && (
        <Modal title="Prompt health" wide onClose={() => setOpenModal(null)}>
          <p className="text-[13px] text-ink-3 mb-4 -mt-1">
            {flaggedPrompts.length > 0
              ? `The health check flagged ${flaggedPrompts.length} prompt${flaggedPrompts.length === 1 ? "" : "s"} whose answers drifted off-category. Refield with a suggested alternative — history is preserved, and the replacement fields on the next run.`
              : "All prompts passed the health check."}
          </p>
          <div className="grid gap-3">
            <details open={flaggedPrompts.length > 0} className="group">
              <summary className="cursor-pointer list-none flex items-center gap-2 text-sm font-semibold py-1 select-none">
                <span className="text-ink-3 transition-transform group-open:rotate-90">
                  ▸
                </span>
                Flagged ({flaggedPrompts.length})
              </summary>
              {flaggedPrompts.length > 0 ? (
                <div className="card divide-y divide-line mt-2">
                  {flaggedPrompts.map((p) => (
                    <div key={p.id} className="px-5 py-2.5">
                      <div className="flex items-baseline gap-4 text-sm">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-3 w-28 shrink-0">
                          {p.theme.replace("_", " ")}
                        </span>
                        <span className="text-ink-2">{p.text}</span>
                      </div>
                      <div className="mt-2 ml-32 border-l-2 border-warning/40 pl-3 grid gap-1.5">
                        {p.flag_reason && (
                          <p className="text-[13px] text-ink-3">
                            {p.flag_reason}
                          </p>
                        )}
                        {p.suggested_alternatives.map((alt, i) => (
                          <div
                            key={i}
                            className="flex items-baseline gap-2 text-[13px]"
                          >
                            <span className="text-ink-2 flex-1">“{alt}”</span>
                            <button
                              type="button"
                              onClick={async () => {
                                await fetch(`/api/projects/${id}/prompts`, {
                                  method: "POST",
                                  headers: {
                                    "Content-Type": "application/json",
                                  },
                                  body: JSON.stringify({
                                    action: "replace",
                                    promptId: p.id,
                                    text: alt,
                                  }),
                                });
                                refresh();
                              }}
                              className="shrink-0 font-medium text-primary hover:opacity-80"
                            >
                              Refield with this →
                            </button>
                          </div>
                        ))}
                        {shownRun && (
                          <div>
                            {examples[p.id] === undefined && (
                              <button
                                type="button"
                                onClick={async () => {
                                  setExamples((x) => ({
                                    ...x,
                                    [p.id]: "loading",
                                  }));
                                  const res = await fetch(
                                    `/api/runs/${shownRun.id}/responses?promptId=${p.id}`
                                  );
                                  const d = res.ok
                                    ? await res.json()
                                    : { responses: [] };
                                  setExamples((x) => ({
                                    ...x,
                                    [p.id]: d.responses
                                      .slice(0, 3)
                                      .map(
                                        (r: { text: string }) => r.text
                                      ),
                                  }));
                                }}
                                className="text-[13px] font-medium text-primary hover:opacity-80"
                              >
                                Show example answers
                              </button>
                            )}
                            {examples[p.id] === "loading" && (
                              <span className="text-[13px] text-ink-3">
                                loading…
                              </span>
                            )}
                            {Array.isArray(examples[p.id]) && (
                              <div className="grid gap-2 mt-1">
                                {(examples[p.id] as string[]).map((t, i) => (
                                  <p
                                    key={i}
                                    className="text-[13px] leading-relaxed text-ink-2 whitespace-pre-wrap border-l-2 border-line pl-3 max-h-40 overflow-y-auto"
                                  >
                                    {t}
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-ink-3 mt-2 ml-6">
                  Nothing flagged.
                </p>
              )}
            </details>
            <details className="group">
              <summary className="cursor-pointer list-none flex items-center gap-2 text-sm font-semibold py-1 select-none">
                <span className="text-ink-3 transition-transform group-open:rotate-90">
                  ▸
                </span>
                Healthy (
                {prompts.filter((p) => p.retired === 0 && p.flagged !== 1)
                  .length}
                )
              </summary>
              <div className="card divide-y divide-line mt-2">
                {prompts
                  .filter((p) => p.retired === 0 && p.flagged !== 1)
                  .map((p) => (
                    <div
                      key={p.id}
                      className="flex items-baseline gap-4 px-5 py-2.5 text-sm"
                    >
                      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-3 w-28 shrink-0">
                        {p.theme.replace("_", " ")}
                      </span>
                      <span className="text-ink-2">{p.text}</span>
                    </div>
                  ))}
              </div>
            </details>
          </div>
          <p className="text-[13px] text-ink-3 mt-3">
            Headline rates come from the unbranded prompts — the branded
            probes are reported separately, since naming the brand guarantees
            a mention.
          </p>
        </Modal>
      )}
    </div>
  );
}

function TaskButton({
  label,
  bubble,
  primary,
  onClick,
}: {
  label: string;
  bubble: number | "dot" | null;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative ${
        primary
          ? "btn-primary"
          : "card px-4 py-2 text-sm font-semibold text-ink-2 hover:border-primary/40 hover:text-ink"
      }`}
    >
      {label}
      {bubble !== null && (
        <span
          className={`absolute -top-1.5 -right-1.5 rounded-full bg-danger text-white ${
            bubble === "dot"
              ? "h-2.5 w-2.5"
              : "h-4.5 min-w-4.5 px-1 text-[10px] font-bold leading-[1.125rem] text-center"
          }`}
        >
          {bubble === "dot" ? "" : bubble}
        </span>
      )}
    </button>
  );
}

function Modal({
  title,
  wide,
  tall,
  onClose,
  subheader,
  children,
}: {
  title: string;
  wide?: boolean;
  /** Fixed height (vs. content-sized) — keeps tabbed modals from resizing
   * as the user switches tabs. */
  tall?: boolean;
  onClose: () => void;
  /** Pinned below the title, above the scroll area — e.g. a tab bar. */
  subheader?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className={`card flex w-full ${wide ? "max-w-3xl" : "max-w-xl"} ${tall ? "h-[calc(100vh-3rem)]" : "max-h-[calc(100vh-3rem)]"} flex-col bg-white`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 p-6 pb-4">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <button
            type="button"
            aria-label="close"
            onClick={onClose}
            className="text-ink-3 hover:text-ink text-xl leading-none"
          >
            ×
          </button>
        </div>
        {subheader && <div className="shrink-0 px-6">{subheader}</div>}
        <div className="overflow-y-auto px-6 pb-6 pt-4">{children}</div>
      </div>
    </div>
  );
}

function ProgressBar({
  completed,
  total,
}: {
  completed: number;
  total: number;
}) {
  const pct = total > 0 ? (completed / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-44 rounded-full bg-line overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-ink-3">
        {completed}/{total}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: Run["status"] }) {
  if (status === "running" || status === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary">
        <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-primary" />
        {status === "running" ? "running" : "queued"}
      </span>
    );
  }
  const styles: Record<"complete" | "failed", string> = {
    complete: "bg-success/12 text-success",
    failed: "bg-danger/12 text-danger",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${styles[status]}`}
    >
      {status}
    </span>
  );
}

/** Create a public, expiring, read-only link to this dashboard. */
function ShareButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const create = async (ttl: "48h" | "7d") => {
    setBusy(true);
    const res = await fetch(`/api/projects/${projectId}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl }),
    });
    setBusy(false);
    if (!res.ok) return;
    const d = await res.json();
    setLink(`${window.location.origin}${d.path}`);
  };
  return (
    <span className="relative inline-block">
      <button type="button"
        onClick={() => {
          setOpen((o) => !o);
          setLink(null);
          setCopied(false);
        }}
        className="text-sm font-semibold text-primary hover:opacity-80">
        Share
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <span className="absolute right-0 top-full z-40 mt-1 block w-72 rounded-xl border border-line bg-surface p-4 shadow-lg">
            {!link ? (
              <>
                <span className="block text-sm font-semibold mb-1">
                  Share this dashboard
                </span>
                <span className="block text-[12px] text-ink-3 mb-3">
                  Anyone with the link can view results — running, editing,
                  and deleting stay disabled. The link expires on its own.
                </span>
                <span className="flex gap-2">
                  <button type="button" disabled={busy}
                    onClick={() => create("48h")}
                    className="btn-primary flex-1 text-sm disabled:opacity-50">
                    48 hours
                  </button>
                  <button type="button" disabled={busy}
                    onClick={() => create("7d")}
                    className="btn-primary flex-1 text-sm disabled:opacity-50">
                    7 days
                  </button>
                </span>
              </>
            ) : (
              <>
                <span className="block text-sm font-semibold mb-2">
                  Link ready
                </span>
                <input readOnly value={link}
                  onFocus={(e) => e.target.select()}
                  className="input w-full text-[12px] mb-2" />
                <button type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(link);
                    setCopied(true);
                  }}
                  className="btn-primary w-full text-sm">
                  {copied ? "Copied" : "Copy link"}
                </button>
              </>
            )}
          </span>
        </>
      )}
    </span>
  );
}
