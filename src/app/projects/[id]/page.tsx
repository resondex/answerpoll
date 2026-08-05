"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import TrendChart from "./trend_chart";
import type {
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
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [trend, setTrend] = useState<ProjectTrend | null>(null);
  const [model, setModel] = useState(MODELS[0]);
  const [repeats, setRepeats] = useState(5);
  const [launching, setLaunching] = useState(false);

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
  }, [id]);

  async function setSchedule(schedule: RunSchedule) {
    setDetail((d) =>
      d ? { ...d, project: { ...d.project, schedule } } : d
    );
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
    setLaunching(true);
    await fetch(`/api/projects/${id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, repeats }),
    });
    setLaunching(false);
    refresh();
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

  return (
    <div className="grid gap-8">
      <div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.name}
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
          {runs.some((r) => r.status === "complete") && (
            <a
              href={`/api/projects/${id}/study`}
              className="text-sm font-semibold text-primary hover:opacity-80"
              title="Complete deliverable: executive summary, scorecard, analysis tables, coded dataset, response library, methodology"
            >
              Download study (.zip) ↓
            </a>
          )}
        </div>
      </div>

      <section className="card p-6">
        <h2 className="section-label mb-4">New run</h2>
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
            className="btn-primary"
          >
            {hasActiveRun ? "Run in progress…" : `Run ${totalCalls} queries`}
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
        <p className="text-[13px] text-ink-3 mt-3">
          {prompts.length} prompts × {repeats} repeats — more repeats, tighter
          confidence intervals.
          {project.schedule !== "none" &&
            ` Automatic ${project.schedule} runs fire at the daily 06:00 UTC check.`}
        </p>
      </section>

      <section className="card p-6">
        <h2 className="section-label mb-1">Trend</h2>
        {trend && trend.runs.length >= 2 ? (
          <>
            <p className="text-[13px] text-ink-3 mb-4">
              {project.brand} vs. named competitors across {trend.runs.length}{" "}
              completed runs.
            </p>
            <TrendChart trend={trend} />
          </>
        ) : (
          <p className="text-sm text-ink-3 py-4">
            The trend line starts with your second completed run — schedule
            automatic runs and the history builds itself.
          </p>
        )}
      </section>

      <section>
        <h2 className="section-label mb-3">Runs</h2>
        {runs.length === 0 ? (
          <div className="card px-5 py-8 text-center text-sm text-ink-3">
            Launch your first run to start measuring.
          </div>
        ) : (
          <ul className="grid gap-2">
            {runs.map((r) => {
              const active = r.status === "pending" || r.status === "running";
              return (
                <li
                  key={r.id}
                  className="card flex items-center justify-between gap-4 px-5 py-3.5"
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
                    {r.status === "complete" && (
                      <Link
                        href={`/projects/${id}/runs/${r.id}`}
                        className="text-sm font-semibold text-primary hover:opacity-80"
                      >
                        Dashboard →
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 className="section-label mb-3">Prompt battery</h2>
        <div className="card divide-y divide-line">
          {prompts.map((p) => (
            <div
              key={p.id}
              className="flex items-baseline gap-4 text-sm px-5 py-2.5"
            >
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-3 w-28 shrink-0">
                {p.theme.replace("_", " ")}
              </span>
              <span className="text-ink-2">{p.text}</span>
            </div>
          ))}
        </div>
        <p className="text-[13px] text-ink-3 mt-2.5">
          Headline rates come from the unbranded prompts — the branded probes
          are reported separately, since naming the brand guarantees a mention.
        </p>
      </section>
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
