"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import TrendChart from "./trend_chart";
import RunResults from "./run_results";
import type {
  DictionaryEntry,
  Project,
  ProjectTrend,
  Prompt,
  Run,
  RunSchedule,
} from "@/lib/types";

const MODELS = ["gpt-5-mini", "gpt-5", "gpt-4o"];

interface Detail {
  project: Project;
  prompts: Prompt[];
  runs: Run[];
}

interface Progress {
  completed: number;
  total: number;
}

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
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<
    | {
        entryId: string;
        name: string;
        action: "merge" | "approve" | "ignore";
        mergeIntoId: string | null;
        mergeIntoName: string | null;
        rationale: string;
      }[]
    | null
  >(null);
  const [suggesting2, setSuggesting2] = useState(false);
  const [applying, setApplying] = useState(false);
  const [model, setModel] = useState(MODELS[0]);
  const [repeats, setRepeats] = useState(5);
  const [launching, setLaunching] = useState(false);
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
  }, [id]);

  async function refreshDict() {
    const dr = await fetch(`/api/projects/${id}/dictionary`);
    if (dr.ok) setDict((await dr.json()).entries ?? []);
    setDictVersion((v) => v + 1);
  }

  async function suggestDispositions() {
    setSuggesting2(true);
    const res = await fetch(`/api/projects/${id}/dictionary/suggest`, {
      method: "POST",
    });
    setSuggesting2(false);
    if (res.ok) setSuggestions((await res.json()).suggestions);
  }

  async function applySuggestions() {
    if (!suggestions) return;
    setApplying(true);
    const actions = suggestions.map((s) =>
      s.action === "merge" && s.mergeIntoId
        ? { entryId: s.entryId, action: "merge", mergeIntoId: s.mergeIntoId }
        : s.action === "approve"
          ? { entryId: s.entryId, action: "approve" }
          : { entryId: s.entryId, action: "reject" }
    );
    await fetch(`/api/projects/${id}/dictionary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actions }),
    });
    setApplying(false);
    setSuggestions(null);
    await refreshDict();
  }

  async function dictAction(
    entryId: string,
    action: "approve" | "reject" | "merge"
  ) {
    await fetch(`/api/projects/${id}/dictionary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryId,
        action,
        mergeIntoId: action === "merge" ? mergeTargets[entryId] : undefined,
      }),
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

  const hasActiveRun = detail?.runs.some(
    (r) => r.status === "pending" || r.status === "running"
  );

  useEffect(() => {
    if (!hasActiveRun) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [hasActiveRun, refresh]);

  async function launchRun() {
    if (launching || hasActiveRun) return;
    setLaunching(true);
    try {
      await fetch(`/api/projects/${id}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, repeats }),
      });
      // Stay in the launching state until the refreshed run list shows the
      // active run — otherwise the button re-enables for a beat in between.
      await refresh();
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
  const totalCalls = prompts.length * repeats;
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
  ).length;

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
          <p className="text-sm text-ink-2">
            <span className="font-medium text-ink">{project.brand}</span>
            {project.competitors.length > 0 && (
              <> vs. {project.competitors.join(", ")}</>
            )}{" "}
            · {project.category}
            {project.audience ? ` · ${project.audience}` : ""}
          </p>
          <span className="flex items-center gap-4">
            {completeRuns.length > 0 && (
              <a
                href={`/api/projects/${id}/study`}
                className="text-sm font-semibold text-primary hover:opacity-80"
                title="Complete deliverable: executive summary, scorecard, analysis tables, coded dataset, response library, methodology"
              >
                Download study (.zip) ↓
              </a>
            )}
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

      <section className="card p-6">
        <div className="flex flex-wrap items-end gap-4">
          <label className="grid gap-1.5 text-sm font-medium">
            Model
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="input w-44"
            >
              {MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
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
            onClick={launchRun}
            disabled={launching || hasActiveRun}
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
          <label className="grid gap-1.5 text-sm font-medium sm:ml-auto">
            Automatic runs
            <select
              value={project.schedule}
              onChange={(e) => setSchedule(e.target.value as RunSchedule)}
              className="input w-36"
            >
              <option value="none">off</option>
              <option value="weekly">weekly</option>
              <option value="monthly">monthly</option>
            </select>
          </label>
        </div>
        {activeRun && progress ? (
          <div className="mt-4 flex items-center gap-4">
            <StatusBadge status={activeRun.status} />
            <ProgressBar
              completed={progress.completed}
              total={progress.total}
            />
            <span className="text-[13px] text-ink-3">
              {activeRun.model} · {activeRun.repeats} repeats — results appear
              below the moment it completes.
            </span>
          </div>
        ) : (
          <p className="text-[13px] text-ink-3 mt-3">
            {prompts.length} prompts × {repeats} repeats — more repeats,
            tighter confidence intervals.
            {project.schedule !== "none" &&
              ` Automatic ${project.schedule} runs fire at the daily 06:00 UTC check.`}
          </p>
        )}
      </section>

      {(pendingDict > 0 || flaggedPrompts > 0) && (
        <div className="card border-warning/40 bg-warning/8 px-5 py-3.5 text-sm grid gap-1">
          {pendingDict > 0 && (
            <p>
              <span className="font-semibold">
                {pendingDict} new brand name{pendingDict === 1 ? "" : "s"}
              </span>{" "}
              surfaced in the answers — the metrics below count them as
              separate brands until you review them.{" "}
              <a
                href="#dictionary"
                className="font-semibold text-primary hover:opacity-80"
              >
                Review the dictionary ↓
              </a>
            </p>
          )}
          {flaggedPrompts > 0 && (
            <p>
              <span className="font-semibold">Health check:</span> the first
              run flagged {flaggedPrompts} prompt
              {flaggedPrompts === 1 ? "" : "s"} whose answers drifted
              off-category.{" "}
              <a
                href="#battery"
                className="font-semibold text-primary hover:opacity-80"
              >
                Review the battery ↓
              </a>
            </p>
          )}
        </div>
      )}

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
          <RunResults key={`${shownRun.id}:${dictVersion}`} runId={shownRun.id} />
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

      {dict.some((e) => e.status === "pending") && (
        <section id="dictionary" className="card p-6 scroll-mt-6">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="section-label mb-1">
              Brand dictionary — review queue
            </h2>
            <button
              type="button"
              onClick={suggestDispositions}
              disabled={suggesting2}
              className="text-[13px] font-medium text-primary hover:opacity-80"
            >
              {suggesting2 ? "Reviewing…" : "Suggest dispositions"}
            </button>
          </div>
          <p className="text-[13px] text-ink-3 mb-4">
            New names the answers surfaced. Approve as a distinct brand, merge
            as an alias of a known one, or reject. Decisions apply
            retroactively to every run - the raw extracted names are never
            changed, so everything is reversible.
          </p>
          {suggestions && (
            <div className="mb-5 rounded-lg border border-primary/30 bg-primary-soft/40 p-4">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-sm font-semibold">
                  Proposed dispositions ({suggestions.length})
                </span>
                <span className="flex gap-4">
                  <button
                    type="button"
                    onClick={applySuggestions}
                    disabled={applying}
                    className="btn-primary px-3 py-1.5 text-[13px]"
                  >
                    {applying ? "Applying…" : "Apply all"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSuggestions(null)}
                    className="text-[13px] text-ink-3 hover:text-ink"
                  >
                    Discard
                  </button>
                </span>
              </div>
              <div className="grid gap-1 max-h-72 overflow-y-auto text-[13px]">
                {suggestions.map((s, i) => (
                  <div key={s.entryId} className="flex items-center gap-2">
                    <span className="font-medium w-44 truncate">{s.name}</span>
                    <select
                      className="input w-28 text-xs"
                      value={s.action}
                      onChange={(e) =>
                        setSuggestions(
                          suggestions.map((x, j) =>
                            j === i
                              ? {
                                  ...x,
                                  action: e.target.value as typeof x.action,
                                }
                              : x
                          )
                        )
                      }
                    >
                      <option value="merge">merge</option>
                      <option value="approve">approve</option>
                      <option value="ignore">ignore</option>
                    </select>
                    <span className="text-ink-3 truncate flex-1">
                      {s.action === "merge" && s.mergeIntoName
                        ? `→ ${s.mergeIntoName} · `
                        : ""}
                      {s.rationale}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-2">
            {dict
              .filter((e) => e.status === "pending")
              .slice(0, 15)
              .map((e) => (
                <div
                  key={e.id}
                  className="flex flex-wrap items-center gap-2 text-sm border-b border-line/60 pb-2"
                >
                  <span className="font-medium min-w-40">{e.canonical}</span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => dictAction(e.id, "approve")}
                    className="text-[13px] font-medium text-success hover:opacity-80"
                  >
                    Approve as brand
                  </button>
                  <select
                    className="input w-40 text-xs"
                    value={mergeTargets[e.id] ?? ""}
                    onChange={(ev) =>
                      setMergeTargets({
                        ...mergeTargets,
                        [e.id]: ev.target.value,
                      })
                    }
                  >
                    <option value="">merge into…</option>
                    {dict
                      .filter((x) => x.status === "active")
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.canonical}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => dictAction(e.id, "merge")}
                    disabled={!mergeTargets[e.id]}
                    className="text-[13px] font-medium text-primary hover:opacity-80 disabled:opacity-40"
                  >
                    Merge
                  </button>
                  <button
                    type="button"
                    onClick={() => dictAction(e.id, "reject")}
                    className="text-[13px] font-medium text-ink-3 hover:text-danger"
                  >
                    Reject
                  </button>
                </div>
              ))}
          </div>
          <p className="text-xs text-ink-3 mt-3">
            {pendingDict} pending ·{" "}
            {dict.filter((e) => e.status === "active").length} active brands ·
            dictionary v{project.dictionary_version}
          </p>
        </section>
      )}

      <section id="battery" className="scroll-mt-6">
        <h2 className="section-label mb-3">Prompt battery</h2>
        <div className="card divide-y divide-line">
          {prompts
            .filter((p) => p.retired === 0)
            .map((p) => (
              <div key={p.id} className="px-5 py-2.5">
                <div className="flex items-baseline gap-4 text-sm">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-ink-3 w-28 shrink-0">
                    {p.theme.replace("_", " ")}
                  </span>
                  <span className="text-ink-2">{p.text}</span>
                  {p.flagged === 1 && (
                    <span className="ml-auto shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
                      flagged
                    </span>
                  )}
                </div>
                {p.flagged === 1 && (
                  <div className="mt-2 ml-32 border-l-2 border-warning/40 pl-3 grid gap-1.5">
                    {p.flag_reason && (
                      <p className="text-[13px] text-ink-3">{p.flag_reason}</p>
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
                              headers: { "Content-Type": "application/json" },
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
                  </div>
                )}
              </div>
            ))}
        </div>
        <p className="text-[13px] text-ink-3 mt-2.5">
          Headline rates come from the unbranded prompts — the branded probes
          are reported separately, since naming the brand guarantees a mention.
        </p>
      </section>

      {runs.length > 0 && (
        <section>
          <h2 className="section-label mb-3">Run history</h2>
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
        </section>
      )}
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
    <div className="flex items-center gap-3 mt-2">
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
