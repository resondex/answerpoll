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

  if (!loaded) return <p className="text-sm text-[#898781]">Loading…</p>;
  if (!metrics || !project)
    return <p className="text-sm text-[#d03b3b]">Run not found.</p>;

  const target = metrics.brands.find((b) => b.isTarget)!;
  const leaderboard = metrics.brands.slice(0, 10);
  const maxRate = Math.max(...leaderboard.map((b) => b.mentionRate), 0.01);
  const targetPos =
    metrics.brands.findIndex((b) => b.isTarget) + 1;

  return (
    <div className="grid gap-8">
      <div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.brand} — LLM visibility
          </h1>
          <Link
            href={`/projects/${id}`}
            className="text-sm text-[#2a78d6] dark:text-[#3987e5]"
          >
            ← back to tracker
          </Link>
        </div>
        <p className="text-sm text-[#52514e] dark:text-[#c3c2b7] mt-1">
          {metrics.model}
          {metrics.mock ? " (mock data)" : ""} · {metrics.unbrandedResponses}{" "}
          unbranded answers sampled · category: {project.category}
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Mention rate"
          value={pct(target.mentionRate)}
          detail={`95% CI ${pct(target.ciLow)}–${pct(target.ciHigh)}`}
          hint="Share of unbranded answers that mention you at all"
        />
        <StatTile
          label="Average position"
          value={target.avgRank ? `#${target.avgRank.toFixed(1)}` : "—"}
          detail={
            target.avgRank
              ? `when mentioned (${target.mentionCount}×)`
              : "never mentioned"
          }
          hint="Where you sit in the answer when you do appear"
        />
        <StatTile
          label="Share of voice"
          value={pct(target.shareOfVoice)}
          detail={`#${targetPos} of ${metrics.brands.length} brands seen`}
          hint="Your mentions as a share of all brand mentions"
        />
      </section>

      <section className="rounded-lg border border-black/10 dark:border-white/10 bg-[#fcfcfb] dark:bg-[#1a1a19] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#898781] mb-1">
          Brand leaderboard
        </h2>
        <p className="text-xs text-[#898781] mb-4">
          Mention rate across unbranded answers. Includes brands the model
          brought up on its own.
        </p>
        <div className="grid gap-2">
          {leaderboard.map((b) => (
            <div
              key={b.brand}
              className="group grid grid-cols-[9rem_1fr_7rem] items-center gap-3"
              title={`${b.brand}: mentioned in ${b.mentionCount} of ${metrics.unbrandedResponses} answers (95% CI ${pct(b.ciLow)}–${pct(b.ciHigh)}) · avg position ${b.avgRank ? b.avgRank.toFixed(1) : "—"} · recommended ${b.framing.recommended}× / negative ${b.framing.negative}×`}
            >
              <span
                className={`truncate text-sm text-right ${b.isTarget ? "font-semibold" : ""}`}
              >
                {b.brand}
                {b.isTarget ? " ●" : ""}
              </span>
              <div className="h-5 relative">
                <div
                  className={`absolute inset-y-0.5 left-0 rounded-r-[4px] ${
                    b.isTarget
                      ? "bg-[#2a78d6] dark:bg-[#3987e5]"
                      : b.isCompetitor
                        ? "bg-[#898781]"
                        : "bg-[#c3c2b7] dark:bg-[#52514e]"
                  }`}
                  style={{ width: `${(b.mentionRate / maxRate) * 100}%` }}
                />
              </div>
              <span className="text-sm tabular-nums text-[#52514e] dark:text-[#c3c2b7]">
                {pct(b.mentionRate)}
                <span className="text-xs text-[#898781]">
                  {" "}
                  · {b.avgRank ? `#${b.avgRank.toFixed(1)}` : "—"}
                </span>
              </span>
            </div>
          ))}
        </div>
        <div className="flex gap-4 mt-4 text-xs text-[#898781]">
          <LegendSwatch color="bg-[#2a78d6] dark:bg-[#3987e5]" label={`${project.brand} (you)`} />
          <LegendSwatch color="bg-[#898781]" label="named competitor" />
          <LegendSwatch color="bg-[#c3c2b7] dark:bg-[#52514e]" label="emerged in answers" />
        </div>
      </section>

      <section className="rounded-lg border border-black/10 dark:border-white/10 bg-[#fcfcfb] dark:bg-[#1a1a19] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#898781] mb-4">
          Where you show up — by prompt
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-[#898781] border-b border-black/10 dark:border-white/10">
                <th className="py-2 pr-4 font-medium">Prompt</th>
                <th className="py-2 pr-4 font-medium">Theme</th>
                <th className="py-2 pr-4 font-medium text-right">You appear</th>
                <th className="py-2 font-medium text-right">Avg position</th>
              </tr>
            </thead>
            <tbody>
              {metrics.prompts.map((p) => (
                <tr
                  key={p.promptId}
                  className="border-b border-black/5 dark:border-white/5"
                >
                  <td className="py-2 pr-4">{p.text}</td>
                  <td className="py-2 pr-4 text-xs text-[#898781]">
                    {p.theme.replace("_", " ")}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {p.targetMentions}/{p.responses}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {p.targetAvgRank ? `#${p.targetAvgRank.toFixed(1)}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#898781] mb-3">
          Sample answers
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          {metrics.verbatims.map((v, i) => (
            <div
              key={i}
              className="rounded-lg border border-black/10 dark:border-white/10 bg-[#fcfcfb] dark:bg-[#1a1a19] p-4"
            >
              <p className="text-xs font-medium text-[#898781] mb-2">
                “{v.promptText}”
                <span
                  className={
                    v.mentionsTarget
                      ? "ml-2 text-[#006300] dark:text-[#0ca30c]"
                      : "ml-2 text-[#d03b3b]"
                  }
                >
                  {v.mentionsTarget ? "mentions you" : "you're absent"}
                </span>
              </p>
              <p className="text-sm whitespace-pre-wrap text-[#52514e] dark:text-[#c3c2b7]">
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
    <div
      className="rounded-lg border border-black/10 dark:border-white/10 bg-[#fcfcfb] dark:bg-[#1a1a19] p-5"
      title={hint}
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-[#898781]">
        {label}
      </div>
      <div className="text-3xl font-semibold mt-1">{value}</div>
      <div className="text-xs text-[#52514e] dark:text-[#c3c2b7] mt-1">
        {detail}
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${color}`} />
      {label}
    </span>
  );
}
