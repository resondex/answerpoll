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
        <div className="flex items-baseline justify-between gap-4 flex-wrap mt-1.5">
          <p className="text-sm text-ink-2">
            {metrics.model} · {metrics.unbrandedResponses} unbranded answers
            sampled · {project.category}
          </p>
          <p className="text-[13px] text-ink-3">
            Export:{" "}
            {(
              [
                ["brands", "format=csv&table=brands"],
                ["prompts", "format=csv&table=prompts"],
                ["raw answers", "format=csv&table=responses"],
                ["raw mentions", "format=csv&table=mentions"],
                ["JSON", "format=json"],
              ] as const
            ).map(([label, qs], i) => (
              <span key={label}>
                {i > 0 && " · "}
                <a
                  href={`/api/runs/${runId}/export?${qs}`}
                  className="font-medium text-primary hover:opacity-80"
                >
                  {label}
                </a>
              </span>
            ))}
          </p>
        </div>
      </div>

      <section
        className={`grid gap-3 sm:grid-cols-2 ${metrics.coded ? "lg:grid-cols-4" : "sm:grid-cols-3"}`}
      >
        <StatTile
          label="Mention rate"
          value={pct(target.mentionRate)}
          detail={`95% CI ${pct(target.ciLow)}–${pct(target.ciHigh)}`}
          hint="Share of unbranded answers that name you at all"
        />
        {metrics.coded && metrics.firstPick && (
          <StatTile
            label="First pick"
            value={pct(metrics.firstPick.rate)}
            detail={`95% CI ${pct(metrics.firstPick.ciLow)}–${pct(metrics.firstPick.ciHigh)} · ${metrics.firstPick.count} of ${metrics.firstPick.of}`}
            hint="Answers that crown your brand as THE recommendation - being mentioned is representation, being picked is the win"
          />
        )}
        <StatTile
          label="Average position"
          value={target.avgRank ? `#${target.avgRank.toFixed(1)}` : "—"}
          detail={
            metrics.positionDist
              ? `#1 ×${metrics.positionDist.r1} · #2 ×${metrics.positionDist.r2} · #3 ×${metrics.positionDist.r3} · 4th+ ×${metrics.positionDist.r4plus}`
              : target.avgRank
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

      {metrics.coded && metrics.topPicks && metrics.topPicks.length > 0 && (
        <section className="card p-6">
          <h2 className="section-label mb-1">Who wins instead</h2>
          <p className="text-[13px] text-ink-3 mb-4">
            The brand each answer actually crowned - over the{" "}
            {metrics.outcomes?.pick ?? 0} answers that committed to a pick
            {metrics.outcomes
              ? ` (${metrics.outcomes.no_pick} explained without picking, ${metrics.outcomes.clarification} asked a question instead)`
              : ""}
            .
          </p>
          <div className="grid gap-2">
            {metrics.topPicks.slice(0, 10).map((t) => (
              <div
                key={t.brand}
                className="grid grid-cols-[10rem_1fr_8rem] items-center gap-3"
              >
                <span
                  className={`truncate text-sm text-right ${t.isTarget ? "font-semibold text-primary" : "text-ink-2"}`}
                >
                  {t.brand}
                </span>
                <div className="h-4 relative">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-r-[4px] ${
                      t.isTarget
                        ? "bg-primary"
                        : t.isCompetitor
                          ? "bg-ink-3"
                          : "bg-neutral-bar"
                    }`}
                    style={{
                      width: `${(t.shareOfDecided / (metrics.topPicks![0].shareOfDecided || 1)) * 100}%`,
                    }}
                  />
                </div>
                <span className="text-sm tabular-nums text-ink-2">
                  {t.picks} picks
                  <span className="text-xs text-ink-3">
                    {" "}
                    · {pct(t.shareOfDecided)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {metrics.coded && metrics.reasonLift && metrics.reasonLift.length > 0 && (
        <section className="card p-6">
          <h2 className="section-label mb-1">The arguments that decide it</h2>
          <p className="text-[13px] text-ink-3 mb-4">
            Which arguments travel with your wins - share of answers using each
            argument, in your first-pick wins vs overall. Positive lift =
            arguments to feed; negative = the conversations you're losing.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
                  <th className="py-2 pr-4 font-semibold">Argument</th>
                  <th className="py-2 pr-4 font-semibold text-right">
                    In all answers
                  </th>
                  <th className="py-2 pr-4 font-semibold text-right">
                    In your wins
                  </th>
                  <th className="py-2 font-semibold text-right">Lift</th>
                </tr>
              </thead>
              <tbody>
                {metrics.reasonLift.slice(0, 12).map((r) => (
                  <tr key={r.code} className="border-b border-line/60">
                    <td className="py-2 pr-4 text-ink-2">{r.code}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {pct(r.shareAll)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {pct(r.shareWins)}
                    </td>
                    <td
                      className={`py-2 text-right tabular-nums font-medium ${
                        r.lift > 0.02
                          ? "text-success"
                          : r.lift < -0.02
                            ? "text-danger"
                            : "text-ink-3"
                      }`}
                    >
                      {r.lift >= 0 ? "+" : ""}
                      {(r.lift * 100).toFixed(0)} pts
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
        <h2 className="section-label mb-1">Brand summary</h2>
        <p className="text-[13px] text-ink-3 mb-4">
          Every brand named in this run, with its full metrics
          {metrics.brands.length > 25
            ? ` — top 25 of ${metrics.brands.length} shown`
            : ""}
          .
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
                <th className="py-2.5 pr-4 font-semibold">Brand</th>
                <th className="py-2.5 pr-4 font-semibold">Type</th>
                <th className="py-2.5 pr-4 font-semibold text-right">
                  Mention rate
                </th>
                <th className="py-2.5 pr-4 font-semibold text-right">95% CI</th>
                <th className="py-2.5 pr-4 font-semibold text-right">
                  Avg position
                </th>
                <th className="py-2.5 pr-4 font-semibold text-right">
                  Share of voice
                </th>
                <th className="py-2.5 pr-4 font-semibold text-right">
                  Recommended
                </th>
                <th className="py-2.5 font-semibold text-right">Negative</th>
              </tr>
            </thead>
            <tbody>
              {metrics.brands.slice(0, 25).map((b) => (
                <tr
                  key={b.brand}
                  className={`border-b border-line/60 ${
                    b.isTarget ? "bg-primary-soft/50" : ""
                  }`}
                >
                  <td
                    className={`py-2.5 pr-4 ${
                      b.isTarget ? "font-semibold text-primary" : "text-ink-2"
                    }`}
                  >
                    {b.brand}
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-ink-3 whitespace-nowrap">
                    {b.isTarget
                      ? "you"
                      : b.isCompetitor
                        ? "competitor"
                        : "emerged"}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">
                    {pct(b.mentionRate)}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-ink-3 whitespace-nowrap">
                    {pct(b.ciLow)}–{pct(b.ciHigh)}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">
                    {b.avgRank ? `#${b.avgRank.toFixed(1)}` : "—"}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">
                    {pct(b.shareOfVoice)}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">
                    {b.framing.recommended}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">
                    {b.framing.negative}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-6">
        <h2 className="section-label mb-1">Where you show up — by topic</h2>
        <p className="text-[13px] text-ink-3 mb-5">
          Your visibility rolled up by prompt theme — the branded probes are
          reported on their own row, since naming you guarantees a mention.
        </p>
        <div className="grid gap-2.5">
          {metrics.themes.map((t) => (
            <div
              key={t.theme}
              className="grid grid-cols-[9rem_1fr_11rem] items-center gap-3"
              title={`${t.prompts} prompts · ${t.targetMentions} of ${t.responses} answers name ${project.brand} (95% CI ${pct(t.ciLow)}–${pct(t.ciHigh)})`}
            >
              <span
                className={`text-sm text-right ${
                  t.theme === "branded" ? "text-ink-3" : "text-ink-2"
                }`}
              >
                {t.theme.replace("_", " ")}
              </span>
              <div className="h-4 relative">
                <div
                  className={`absolute inset-y-0 left-0 rounded-r-[4px] ${
                    t.theme === "branded" ? "bg-neutral-bar" : "bg-primary"
                  }`}
                  style={{ width: `${t.targetRate * 100}%` }}
                />
              </div>
              <span className="text-sm tabular-nums text-ink-2 whitespace-nowrap">
                {pct(t.targetRate)}
                <span className="text-xs text-ink-3">
                  {" "}
                  · CI {pct(t.ciLow)}–{pct(t.ciHigh)} ·{" "}
                  {t.targetAvgRank ? `#${t.targetAvgRank.toFixed(1)}` : "—"}
                </span>
              </span>
            </div>
          ))}
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
                <th className="py-2.5 pr-4 font-semibold text-right">
                  Avg position
                </th>
                {metrics.coded && (
                  <>
                    <th className="py-2.5 pr-4 font-semibold">
                      Consensus pick
                    </th>
                    <th className="py-2.5 font-semibold">Status</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {metrics.prompts.map((p) => {
                const g = metrics.promptGrid?.find(
                  (x) => x.promptId === p.promptId
                );
                return (
                  <tr key={p.promptId} className="border-b border-line/60">
                    <td className="py-2.5 pr-4 text-ink-2">{p.text}</td>
                    <td className="py-2.5 pr-4 text-xs text-ink-3 whitespace-nowrap">
                      {p.theme.replace("_", " ")}
                    </td>
                    <td
                      className={`py-2.5 pr-4 text-right tabular-nums ${
                        p.targetMentions > 0 ? "font-medium" : "text-ink-3"
                      }`}
                    >
                      {p.targetMentions}/{p.responses}
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-ink-2">
                      {p.targetAvgRank ? `#${p.targetAvgRank.toFixed(1)}` : "—"}
                    </td>
                    {metrics.coded && (
                      <>
                        <td className="py-2.5 pr-4 text-ink-2 whitespace-nowrap">
                          {g?.modalPick ? (
                            <>
                              {g.modalPick}
                              <span className="text-xs text-ink-3">
                                {" "}
                                ({pct(g.modalShare ?? 0)} of {g.decided})
                              </span>
                            </>
                          ) : g && p.theme !== "branded" ? (
                            <span className="text-ink-3">split / no pick</span>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                        <td className="py-2.5">
                          {g ? <Badge badge={g.badge} /> : null}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {metrics.negatives && metrics.negatives.length > 0 && (
        <section className="card p-6">
          <h2 className="section-label mb-1">Where the answers push back</h2>
          <p className="text-[13px] text-ink-3 mb-4">
            {metrics.negatives.length} answer
            {metrics.negatives.length === 1 ? "" : "s"} framed {project.brand}{" "}
            negatively - verbatim, with the coder&apos;s reading.
          </p>
          <div className="grid gap-3">
            {metrics.negatives.slice(0, 8).map((n, i) => (
              <div key={i} className="border-l-2 border-danger/50 pl-4">
                <p className="text-[13px] text-ink-3 mb-1">“{n.promptText}”</p>
                {n.quote && (
                  <p className="text-sm text-ink-2 italic">“{n.quote}”</p>
                )}
                {n.interpretation && (
                  <p className="text-[13px] text-ink-3 mt-1">
                    {n.interpretation}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

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

function Badge({ badge }: { badge: "win" | "contested" | "absent" }) {
  const styles = {
    win: "bg-success/12 text-success",
    contested: "bg-warning/15 text-warning",
    absent: "bg-danger/10 text-danger",
  } as const;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${styles[badge]}`}
    >
      {badge}
    </span>
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
