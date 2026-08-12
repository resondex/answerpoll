"use client";

import { useEffect, useMemo, useState } from "react";
import type { Project, RunMetrics } from "@/lib/types";
import type { InsightsBundle } from "@/lib/engine/insights";

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Everything a view needs — fetched once by the RunResults shell. */
export interface ViewProps {
  metrics: RunMetrics;
  project: Project;
  insights: InsightsBundle | null;
  brandSet: "all" | "competitors" | "discovered";
  /** Jump to the Workbench, opened on a specific cut. */
  openWorkbench: (tab: WorkbenchTab) => void;
}

export type WorkbenchTab =
  | "overview"
  | "engines"
  | "modes"
  | "prompts"
  | "arguments"
  | "sources"
  | "brands"
  | "risks";

function notesFor(insights: InsightsBundle | null, key: string): string[] {
  return insights?.sections.find((s) => s.key === key)?.insights ?? [];
}

function Note({ sentences }: { sentences: string[] }) {
  if (sentences.length === 0) return null;
  return (
    <div className="my-3 rounded-lg bg-primary-soft/40 px-3.5 py-2.5 grid gap-1">
      {sentences.map((t, i) => (
        <p key={i} className="text-[13px] leading-snug text-ink-2">
          <span className="font-semibold text-primary">
            {i === 0 ? "AI reading (verified): " : ""}
          </span>
          {t}
        </p>
      ))}
    </div>
  );
}

function BarRow({
  name,
  share,
  max,
  isTarget,
  right,
  tone = "primary",
}: {
  name: string;
  share: number;
  max: number;
  isTarget?: boolean;
  right: string;
  tone?: "primary" | "search" | "neutral";
}) {
  const fill =
    isTarget || tone === "primary"
      ? isTarget
        ? "bg-primary"
        : "bg-neutral-bar"
      : tone === "search"
        ? "bg-warning/70"
        : "bg-neutral-bar";
  return (
    <div className="grid grid-cols-[11rem_1fr_8rem] items-center gap-3">
      <span
        className={`truncate text-sm text-right ${isTarget ? "font-semibold text-primary" : "text-ink-2"}`}
      >
        {name}
      </span>
      <div className="h-4 relative">
        <div
          className={`absolute inset-y-0 left-0 rounded-r-[4px] ${fill}`}
          style={{ width: `${(share / (max || 1)) * 100}%` }}
        />
      </div>
      <span className="text-sm tabular-nums text-ink-2">{right}</span>
    </div>
  );
}

function inSet(
  brandSet: ViewProps["brandSet"],
  b: { isTarget: boolean; isCompetitor: boolean }
) {
  return (
    brandSet === "all" ||
    b.isTarget ||
    (brandSet === "competitors" ? b.isCompetitor : !b.isCompetitor)
  );
}

/* ================================================================== */
/* B — The Boardroom: the 90-second screen                             */
/* ================================================================== */

export function BoardroomView({
  metrics,
  project,
  insights,
  openWorkbench,
}: ViewProps) {
  const target = metrics.brands.find((b) => b.isTarget)!;
  const shortlisted = metrics.positionDist
    ? (metrics.positionDist.r1 +
        metrics.positionDist.r2 +
        metrics.positionDist.r3) /
      Math.max(metrics.unbrandedResponses, 1)
    : null;
  const decisions = insights?.plays.slice(0, 3) ?? [];
  return (
    <div className="grid gap-5">
      <section className="card p-8 border-l-4 border-l-[var(--color-primary)]">
        <div className="section-label mb-3">The verdict</div>
        <p className="text-xl leading-snug text-ink-2 max-w-[62ch]">
          When {metrics.unbrandedResponses} AI answers recommend{" "}
          {project.category},{" "}
          <span className="font-semibold text-ink">
            {project.brand} is in the room {pct(target.mentionRate)} of the
            time
            {metrics.firstPick
              ? ` — and wins it ${pct(metrics.firstPick.rate)}`
              : ""}
          </span>
          {metrics.firstPick
            ? ". The gap between those two numbers is the whole assignment."
            : "."}
        </p>
        <Note sentences={notesFor(insights, "scorecard").slice(0, 1)} />
      </section>

      <section className="card p-8">
        <div className="grid grid-cols-3 gap-4 text-center">
          {[
            {
              label: "Named",
              value: pct(target.mentionRate),
              sub: `${target.mentionCount} of ${metrics.unbrandedResponses} answers`,
            },
            {
              label: "Shortlisted",
              value: shortlisted !== null ? pct(shortlisted) : "—",
              sub: "top-3 in the answer",
            },
            {
              label: "Chosen",
              value: metrics.firstPick ? pct(metrics.firstPick.rate) : "—",
              sub: "the crowned pick",
            },
          ].map((s, i) => (
            <div key={s.label} className="relative">
              {i > 0 && (
                <span className="absolute -left-2 top-1/2 -translate-y-1/2 text-ink-3">
                  ›
                </span>
              )}
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                {s.label}
              </div>
              <div className="text-4xl font-semibold tabular-nums text-primary mt-1.5">
                {s.value}
              </div>
              <div className="text-[12px] text-ink-3 mt-1">{s.sub}</div>
            </div>
          ))}
        </div>
        <p className="text-[13px] text-ink-3 text-center mt-5">
          Named → shortlisted → chosen. The drop between stages says what kind
          of problem you have.
        </p>
      </section>

      {decisions.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-3">
          {decisions.map((d, i) => (
            <div key={d.title} className="card p-5 grid gap-1.5 content-start">
              <div className="section-label">Decision {i + 1}</div>
              <div className="text-[15px] font-semibold">{d.title}</div>
              <p className="text-[13px] text-ink-2 line-clamp-3" title={d.gap}>
                {d.gap}
              </p>
              <p className="text-[13px] text-ink-3 line-clamp-4" title={d.play}>
                {d.play}
              </p>
            </div>
          ))}
        </section>
      )}

      <button
        type="button"
        onClick={() => openWorkbench("overview")}
        className="card p-5 text-center text-sm font-semibold text-primary hover:opacity-80"
      >
        Open the full analysis →
      </button>
    </div>
  );
}

/* ================================================================== */
/* D — The Five Questions: templated by construction                   */
/* ================================================================== */

export function QuestionsView({
  metrics,
  project,
  insights,
  openWorkbench,
}: ViewProps) {
  const target = metrics.brands.find((b) => b.isTarget)!;
  const searchMode = metrics.modes?.find((m) => m.mode === "search");
  const instinctMode = metrics.modes?.find((m) => m.mode === "instinct");
  const rivals = metrics.topPicks?.filter((t) => !t.isTarget).slice(0, 4) ?? [];
  const you = metrics.topPicks?.find((t) => t.isTarget);
  const maxPick = metrics.topPicks?.[0]?.shareOfDecided ?? 1;
  const topLift = metrics.reasonLift
    ? [...metrics.reasonLift].sort((a, b) => b.lift - a.lift)
    : [];

  const Q = ({
    n,
    q,
    tab,
    children,
  }: {
    n: number;
    q: string;
    tab: WorkbenchTab;
    children: React.ReactNode;
  }) => (
    <section className="card p-6">
      <div className="grid md:grid-cols-[13rem_1fr] gap-4 items-start">
        <div>
          <div className="section-label">Question {n}</div>
          <h2 className="text-lg font-semibold leading-snug mt-1">{q}</h2>
          <button
            type="button"
            onClick={() => openWorkbench(tab)}
            className="mt-2 text-[13px] font-medium text-primary hover:opacity-80"
          >
            Go deeper →
          </button>
        </div>
        <div className="grid gap-2 min-w-0">{children}</div>
      </div>
    </section>
  );

  return (
    <div className="grid gap-4">
      <Q n={1} q="Do the AIs know you?" tab="overview">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-4xl font-semibold tabular-nums text-primary">
            {pct(target.mentionRate)}
          </span>
          <span className="text-[13px] text-ink-3">
            of {metrics.unbrandedResponses} unbranded answers name{" "}
            {project.brand} · CI {pct(target.ciLow)}–{pct(target.ciHigh)} ·
            average position{" "}
            {target.avgRank ? `#${target.avgRank.toFixed(1)}` : "—"}
          </span>
        </div>
        <Note sentences={notesFor(insights, "scorecard").slice(0, 2)} />
      </Q>

      <Q n={2} q="Do they choose you?" tab="modes">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-4xl font-semibold tabular-nums text-primary">
            {metrics.firstPick ? pct(metrics.firstPick.rate) : "—"}
          </span>
          <span className="text-[13px] text-ink-3">
            of decided answers crown {project.brand}
            {instinctMode && searchMode
              ? ` · instinct ${pct(instinctMode.pickRate)} / search ${pct(searchMode.pickRate)}`
              : ""}
          </span>
        </div>
        <Note sentences={notesFor(insights, "modes")} />
      </Q>

      <Q n={3} q="Who wins instead, and why?" tab="arguments">
        {metrics.topPicks ? (
          <div className="grid gap-2">
            {[...(you ? [you] : []), ...rivals]
              .sort((a, b) => b.shareOfDecided - a.shareOfDecided)
              .map((t) => (
                <BarRow
                  key={t.brand}
                  name={t.brand}
                  isTarget={t.isTarget}
                  share={t.shareOfDecided}
                  max={maxPick}
                  right={`${t.picks} picks · ${pct(t.shareOfDecided)}`}
                />
              ))}
          </div>
        ) : (
          <p className="text-sm text-ink-3">This run wasn&apos;t coded for picks.</p>
        )}
        {topLift.length > 0 && (
          <p className="text-[13px] text-ink-2">
            Arguments that travel with your wins:{" "}
            <span className="font-medium">
              {topLift.slice(0, 2).map((r) => `${r.code} (+${(r.lift * 100).toFixed(0)} pts)`).join(", ")}
            </span>
            {" · "}working against you:{" "}
            <span className="font-medium">
              {topLift.slice(-1).map((r) => `${r.code} (${(r.lift * 100).toFixed(0)} pts)`).join(", ")}
            </span>
          </p>
        )}
        <Note sentences={notesFor(insights, "top_picks").slice(0, 1)} />
      </Q>

      <Q n={4} q="What feeds their answers?" tab="sources">
        {metrics.sources && metrics.sources.domains.length > 0 ? (
          <>
            <div className="grid gap-2">
              {metrics.sources.domains.slice(0, 5).map((d) => (
                <BarRow
                  key={d.domain}
                  name={d.brand ? `${d.domain} ●` : d.domain}
                  isTarget={Boolean(d.brand)}
                  share={d.share}
                  max={metrics.sources!.domains[0].share}
                  right={`${d.answers} answers · ${pct(d.share)}`}
                />
              ))}
            </div>
            <Note sentences={notesFor(insights, "sources")} />
          </>
        ) : (
          <p className="text-sm text-ink-3">
            No grounded answers in this run — add search-enabled engines to the
            panel and the source landscape appears here: which sites write the
            AI&apos;s script, and how much of it you own.
          </p>
        )}
      </Q>

      <Q n={5} q="What should you do?" tab="overview">
        {insights && insights.plays.length > 0 ? (
          <div className="grid gap-2.5">
            {insights.plays.map((p, i) => (
              <p key={p.title} className="text-sm text-ink-2">
                <span className="font-semibold text-primary tabular-nums">
                  {i + 1}.
                </span>{" "}
                <span className="font-semibold">{p.title}.</span> {p.play}{" "}
                <span className="text-ink-3">
                  Graded by {p.measuredBy} — today {p.today}.
                </span>
              </p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-3">
            Verified plays are being written for this run — check back in a
            minute.
          </p>
        )}
      </Q>
    </div>
  );
}
