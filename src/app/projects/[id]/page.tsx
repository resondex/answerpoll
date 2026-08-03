"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { Project, Prompt, Run } from "@/lib/types";

const MODELS = ["gpt-5-mini", "gpt-5", "gpt-4o"];

interface Detail {
  project: Project;
  prompts: Prompt[];
  runs: Run[];
  mockMode: boolean;
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [model, setModel] = useState(MODELS[0]);
  const [repeats, setRepeats] = useState(5);
  const [launching, setLaunching] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/projects/${id}`);
    if (res.ok) setDetail(await res.json());
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hasActiveRun = detail?.runs.some(
    (r) => r.status === "pending" || r.status === "running"
  );

  useEffect(() => {
    if (!hasActiveRun) return;
    const t = setInterval(refresh, 2000);
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

  if (!detail) return <p className="text-sm text-[#898781]">Loading…</p>;
  const { project, prompts, runs, mockMode } = detail;
  const totalCalls = prompts.length * repeats;

  return (
    <div className="grid gap-8">
      <div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.name}
          </h1>
          <Link href="/" className="text-sm text-[#2a78d6] dark:text-[#3987e5]">
            ← all trackers
          </Link>
        </div>
        <p className="text-sm text-[#52514e] dark:text-[#c3c2b7] mt-1">
          <span className="font-medium">{project.brand}</span> vs.{" "}
          {project.competitors.length > 0
            ? project.competitors.join(", ")
            : "no named competitors"}{" "}
          · {project.category}
          {project.audience ? ` · ${project.audience}` : ""}
        </p>
      </div>

      {mockMode && (
        <div className="rounded-lg border border-[#eda100]/40 bg-[#eda100]/10 px-4 py-3 text-sm">
          <span className="font-medium">Mock mode.</span> No OPENAI_API_KEY is
          set, so runs use a synthetic LLM — the full pipeline works, but the
          numbers are simulated. Add a key to <code>.env.local</code> for real
          measurements.
        </div>
      )}

      <section className="rounded-lg border border-black/10 dark:border-white/10 bg-[#fcfcfb] dark:bg-[#1a1a19] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#898781] mb-3">
          New run
        </h2>
        <div className="flex flex-wrap items-end gap-4">
          <label className="grid gap-1 text-sm font-medium">
            Model
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-md border border-black/15 dark:border-white/15 bg-white dark:bg-[#0d0d0d] px-3 py-2 text-sm"
            >
              {MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Repeats per prompt
            <input
              type="number"
              min={1}
              max={20}
              value={repeats}
              onChange={(e) => setRepeats(Number(e.target.value))}
              className="w-24 rounded-md border border-black/15 dark:border-white/15 bg-white dark:bg-[#0d0d0d] px-3 py-2 text-sm"
            />
          </label>
          <button
            onClick={launchRun}
            disabled={launching || hasActiveRun}
            className="rounded-md bg-[#2a78d6] dark:bg-[#3987e5] text-white px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {hasActiveRun ? "Run in progress…" : `Run ${totalCalls} queries`}
          </button>
        </div>
        <p className="text-xs text-[#898781] mt-2">
          {prompts.length} prompts × {repeats} repeats. More repeats → tighter
          confidence intervals on mention rates.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#898781] mb-3">
          Runs
        </h2>
        {runs.length === 0 ? (
          <p className="text-sm text-[#898781]">No runs yet.</p>
        ) : (
          <ul className="grid gap-2">
            {runs.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-black/10 dark:border-white/10 bg-[#fcfcfb] dark:bg-[#1a1a19] px-4 py-3"
              >
                <div className="text-sm">
                  <span className="font-medium">{r.model}</span>
                  <span className="text-[#898781]">
                    {" "}
                    · {r.repeats} repeats · {r.created_at}
                    {r.mock ? " · mock" : ""}
                  </span>
                  {r.error && (
                    <span className="text-[#d03b3b]"> · {r.error}</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={r.status} />
                  {r.status === "complete" && (
                    <Link
                      href={`/projects/${id}/runs/${r.id}`}
                      className="text-sm font-medium text-[#2a78d6] dark:text-[#3987e5]"
                    >
                      Dashboard →
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#898781] mb-3">
          Prompt battery
        </h2>
        <ul className="grid gap-1.5">
          {prompts.map((p) => (
            <li
              key={p.id}
              className="flex items-baseline gap-3 text-sm rounded-md bg-[#fcfcfb] dark:bg-[#1a1a19] border border-black/10 dark:border-white/10 px-3 py-2"
            >
              <span className="text-xs uppercase tracking-wide text-[#898781] w-28 shrink-0">
                {p.theme.replace("_", " ")}
              </span>
              <span>{p.text}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-[#898781] mt-2">
          Branded prompts are excluded from headline mention rates — asking
          about your brand by name guarantees a mention.
        </p>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: Run["status"] }) {
  const styles: Record<Run["status"], string> = {
    pending: "bg-[#898781]/15 text-[#52514e] dark:text-[#c3c2b7]",
    running: "bg-[#2a78d6]/15 text-[#2a78d6] dark:text-[#3987e5]",
    complete: "bg-[#0ca30c]/15 text-[#006300] dark:text-[#0ca30c]",
    failed: "bg-[#d03b3b]/15 text-[#d03b3b]",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {status === "running" ? "running…" : status}
    </span>
  );
}
