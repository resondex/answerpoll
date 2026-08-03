"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { Project, RunMetrics } from "@/lib/types";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function DashboardPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`/api/runs/${runId}/metrics`)
      .then((r) => r.json())
      .then((d) => {
        setMetrics(d.metrics);
        setProject(d.project);
      })
      .finally(() => setLoaded(true));
  }, [runId]);

  if (!loaded) {
    return (
      <div className="grid gap-4">
        <div className="card h-24 animate-pulse" />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="card h-28 animate-pulse" />
          <div className="card h-28 animate-pulse" />
          <div className="card h-28 animate-pulse" />
        </div>
      </div>
    );
  }
  if (!metrics || !project)
    return <p className="text-sm text-danger">Run not found.</p>;

  const target = metrics.brands.find((b) => b.isTarget)!;
  // The target brand is always on the board — pinned to the bottom when it
  // sits outside the top ten, so "where you stand" is never off-screen.
  const leaderboard = metrics.brands.slice(0, 10);
  if (!leaderboard.some((b) => b.isTarget)) {
    leaderboard[9] = target;
  }
  const maxRate = Math.max(...leaderboard.map((b) => b.mentionRate), 0.01);
  const targetPos = metrics.brands.findIndex((b) => b.isTarget) + 1;

  return (
    <div className="grid gap-8">
      <div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.brand} — LLM visibility
          </h1>
          <Link
            href={`/projects/${id}`}
            className="text-sm font-medium text-primary hover:opacity-80"
          >
            ← back to tracker
          </Link>
        </div>
        <p className="text-sm text-ink-2 mt-1.5">
          {metrics.model}
          {metrics.mock ? " · mock data" : ""} · {metrics.unbrandedResponses}{" "}
          unbranded answers sampled · {project.category}
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Mention rate"
          value={pct(target.mentionRate)}
          detail={`95% CI ${pct(target.ciLow)}–${pct(target.ciHigh)}`}
          hint="Share of unbranded answers that name you at all"
        />
        <StatTile
          label="Average position"
          value={target.avgRank ? `#${target.avgRank.toFixed(1)}` : "—"}
          detail={
            target.avgRank
              ? `across ${target.mentionCount} appearances`
              : "awaiting a first appearance"
          }
          hint="Where you sit in the answer when you appear"
        />
        <StatTile
          label="Share of voice"
          value={pct(target.shareOfVoice)}
          detail={`#${targetPos} of ${metrics.brands.length} brands named`}
          hint="Your mentions as a share of all brand mentions"
        />
      </section>

      <section className="card p-6">
        <h2 className="section-label mb-1">Brand leaderboard</h2>
        <p className="text-[13px] text-ink-3 mb-5">
          Mention rate across unbranded answers — named competitors and brands
          the model volunteered on its own.
        </p>
        <div className="grid gap-2.5">
          {leaderboard.map((b) => (
            <div
              key={b.brand}
              className="group grid grid-cols-[9rem_1fr_7rem] items-center gap-3"
              title={`${b.brand}: named in ${b.mentionCount} of ${metrics.unbrandedResponses} answers (95% CI ${pct(b.ciLow)}–${pct(b.ciHigh)}) · avg position ${b.avgRank ? b.avgRank.toFixed(1) : "—"} · recommended ${b.framing.recommended}× · negative ${b.framing.negative}×`}
            >
              <span
                className={`truncate text-sm text-right ${
                  b.isTarget ? "font-semibold text-primary" : "text-ink-2"
                }`}
              >
                {b.brand}
              </span>
              <div className="h-4 relative">
                <div
                  className={`absolute inset-y-0 left-0 rounded-r-[4px] transition-opacity group-hover:opacity-85 ${
                    b.isTarget
                      ? "bg-primary"
                      : b.isCompetitor
                        ? "bg-ink-3"
                        : "bg-neutral-bar"
                  }`}
                  style={{ width: `${(b.mentionRate / maxRate) * 100}%` }}
                />
              </div>
              <span className="text-sm tabular-nums text-ink-2">
                {pct(b.mentionRate)}
                <span className="text-xs text-ink-3">
                  {" "}
                  · {b.avgRank ? `#${b.avgRank.toFixed(1)}` : "—"}
                </span>
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 mt-5 text-xs text-ink-3">
          <LegendSwatch color="bg-primary" label={`${project.brand} (you)`} />
          <LegendSwatch color="bg-ink-3" label="named competitor" />
          <LegendSwatch color="bg-neutral-bar" label="volunteered by the model" />
        </div>
      </section>

      <section className="card p-6">
        <h2 className="section-label mb-4">Where you show up — by prompt</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
                <th className="py-2.5 pr-4 font-semibold">Prompt</th>
                <th className="py-2.5 pr-4 font-semibold">Theme</th>
                <th className="py-2.5 pr-4 font-semibold text-right">
                  You appear
                </th>
                <th className="py-2.5 font-semibold text-right">
                  Avg position
                </th>
              </tr>
            </thead>
            <tbody>
              {metrics.prompts.map((p) => (
                <tr key={p.promptId} className="border-b border-line/60">
                  <td className="py-2.5 pr-4 text-ink-2">{p.text}</td>
                  <td className="py-2.5 pr-4 text-xs text-ink-3 whitespace-nowrap">
                    {p.theme.replace("_", " ")}
                  </td>
                  <td
                    className={`py-2.5 pr-4 text-right tabular-nums ${
                      p.targetMentions > 0
                        ? "font-medium"
                        : "text-ink-3"
                    }`}
                  >
                    {p.targetMentions}/{p.responses}
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-ink-2">
                    {p.targetAvgRank ? `#${p.targetAvgRank.toFixed(1)}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="section-label mb-3">Sample answers</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {metrics.verbatims.map((v, i) => (
            <div key={i} className="card p-5">
              <p className="text-[13px] font-medium text-ink-3 mb-2.5">
                “{v.promptText}”
                <span
                  className={`ml-2 font-semibold ${
                    v.mentionsTarget ? "text-success" : "text-danger"
                  }`}
                >
                  {v.mentionsTarget ? "names you" : "you're absent"}
                </span>
              </p>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-2 border-l-2 border-line pl-4">
                {v.text}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function StatTile({
  label,
  value,
  detail,
  hint,
}: {
  label: string;
  value: string;
  detail: string;
  hint: string;
}) {
  return (
    <div className="card p-5" title={hint}>
      <div className="section-label">{label}</div>
      <div className="text-[2rem] leading-tight font-semibold tabular-nums mt-1.5">
        {value}
      </div>
      <div className="text-[13px] text-ink-2 mt-1">{detail}</div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-[3px] ${color}`} />
      {label}
    </span>
  );
}
