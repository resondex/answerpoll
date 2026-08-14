"use client";

import { useEffect, useState } from "react";
import type { BrandStats, Project, RunMetrics } from "@/lib/types";
import type { InsightsBundle } from "@/lib/engine/insights";
import {
  BoardroomView,
  QuestionsView,
  type WorkbenchTab,
} from "./views";
import Workbench, { type WbPreset } from "./workbench";
import { SortTable } from "./table";
import AnswerText from "./answer_text";
import HumanCodingPanel from "./human_coding_panel";

const pct = (x: number) =>
  x > 0 && x < 0.005 ? "<1%" : `${Math.round(x * 100)}%`;

/**
 * Full results block for one run — the analytical core of the tracker
 * dashboard. Fetches its own metrics so the parent only has to say which
 * run is selected.
 */
export default function RunResults({
  runId,
  refreshToken = 0,
}: {
  runId: string;
  /** Bump to refetch in place — current results stay up while the new ones
   * load, so dictionary edits don't flash a skeleton. */
  refreshToken?: number;
}) {
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  // The verified narrative — the same gate-checked bundle the workbooks and
  // deck carry, so every written insight is discoverable here too.
  const [insights, setInsights] = useState<InsightsBundle | null>(null);
  const [plan, setPlan] = useState<"free" | "pro" | "enterprise">("free");
  const [loaded, setLoaded] = useState(false);
  // Which competitive set the brand tables show. The target always stays.
  // The Set filter retired 2026-08-12 — the Workbench's brand picker is the
  // curation surface now; the Brief always shows the full field.
  const brandSet = "all" as const;
  // The four dashboard styles share one data fetch; the choice sticks.
  const [view, setView] = useState<
    "brief" | "boardroom" | "workbench" | "questions"
  >("brief");
  const [workbenchTab, setWorkbenchTab] = useState<string>("brands");
  const [showCoding, setShowCoding] = useState(false);
  // Share links render this same component read-only; the coding panel's
  // APIs would 403 them anyway, so don't show the door.
  const [isShareView, setIsShareView] = useState(false);
  useEffect(() => {
    setIsShareView(window.location.pathname.startsWith("/share/"));
  }, []);
  useEffect(() => {
    const saved = window.localStorage.getItem("answerpoll_view");
    if (
      saved === "boardroom" ||
      saved === "workbench" ||
      saved === "questions"
    ) {
      setView(saved);
    }
  }, []);
  const switchView = (v: typeof view) => {
    setView(v);
    window.localStorage.setItem("answerpoll_view", v);
  };
  const [wbPreset, setWbPreset] = useState<{
    nonce: number;
    state: WbPreset;
  } | null>(null);
  const openWorkbench = (tab: string, preset?: WbPreset) => {
    setWorkbenchTab(tab);
    if (preset) setWbPreset({ nonce: Date.now(), state: preset });
    switchView("workbench");
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${runId}/metrics`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setMetrics(d.metrics);
        setProject(d.project);
        if (d.plan) setPlan(d.plan);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, refreshToken]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${runId}/insights`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setInsights(d?.insights ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runId, refreshToken]);

  if (!loaded && !metrics) {
    return (
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="card h-28 animate-pulse" />
          <div className="card h-28 animate-pulse" />
          <div className="card h-28 animate-pulse" />
        </div>
        <div className="card h-48 animate-pulse" />
      </div>
    );
  }
  if (!metrics || !project)
    return <p className="text-sm text-danger">Run results not found.</p>;

  const target = metrics.brands.find((b) => b.isTarget)!;
  const inSet = (b: { isTarget: boolean; isCompetitor: boolean }) =>
    brandSet === "all" ||
    b.isTarget ||
    (brandSet === "competitors" ? b.isCompetitor : !b.isCompetitor);
  const setBrands = metrics.brands.filter(inSet);
  const setTopPicks = metrics.topPicks?.filter(inSet) ?? null;
  // The target brand is always on the board — pinned to the bottom when it
  // sits outside the top ten, so "where you stand" is never off-screen.
  const leaderboard = setBrands.slice(0, 10);
  if (!leaderboard.some((b) => b.isTarget)) {
    leaderboard[Math.max(leaderboard.length - 1, 0)] = target;
  }
  const maxRate = Math.max(...leaderboard.map((b) => b.mentionRate), 0.01);
  const targetPos = setBrands.findIndex((b) => b.isTarget) + 1;
  // Citation deep-links: the exact Workbench state that shows each
  // section's figures — client solo by default, split where the section
  // is about a split, comparative where it's about the field.
  const cite = (key: string): [string, WbPreset] => {
    const solo: WbPreset = {
      brandMode: "solo",
      soloBrand: project?.brand ?? "",
      grain: "brands",
      split: "none",
      engines: [],
    };
    switch (key) {
      case "engines":
        return ["brands", { ...solo, split: "engine" }];
      case "modes":
        return ["brands", { ...solo, split: "mode" }];
      case "top_picks":
        return ["brands", { ...solo, brandMode: "comparative", compBrands: [], measure: "share" }];
      case "arguments":
        return ["why", solo];
      case "leaderboard":
        return ["brands", { ...solo, brandMode: "comparative", compBrands: [], measure: "named" }];
      case "parents":
        return ["brands", { ...solo, grain: "parents" }];
      case "prompts":
        return ["battleground", solo];
      case "negatives":
        return ["risk", solo];
      case "sources":
        return ["sources", { ...solo, split: "none" }];
      default:
        return ["brands", solo];
    }
  };
  const notesFor = (key: string) =>
    insights?.sections.find((sec) => sec.key === key)?.insights ?? [];

  return (
    <div className="grid gap-8">
      <div className="flex items-baseline justify-between gap-4 flex-wrap -mb-2">
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
          {" · "}
          <a href={`/api/projects/${project.id}/deck`}
            className="font-medium text-primary hover:opacity-80">
            deck (.pptx)
          </a>
          {" · "}
          <a href={`/api/projects/${project.id}/study`}
            className="font-medium text-primary hover:opacity-80">
            study (.zip)
          </a>
          {!isShareView && (
            <>
              {" · "}
              <button
                type="button"
                onClick={() => setShowCoding(true)}
                className="font-medium text-primary hover:opacity-80"
              >
                human coding
              </button>
            </>
          )}
        </p>
      </div>
      {showCoding && (
        <HumanCodingPanel
          projectId={project.id}
          runId={runId}
          onClose={() => setShowCoding(false)}
        />
      )}

      <div className="flex flex-wrap items-center gap-1.5 -mt-3">
        <span className="text-[12px] text-ink-3 mr-1">View:</span>
        {(
          [
            ["brief", "The brief"],
            ["boardroom", "Boardroom"],
            ["workbench", "Workbench"],
            ["questions", "Five questions"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => switchView(id)}
            className={`rounded-full border px-3 py-1 text-[13px] font-medium transition-colors ${
              view === id
                ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                : "border-line text-ink-2 hover:border-ink-3"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "boardroom" && (
        <BoardroomView
          metrics={metrics}
          project={project}
          insights={insights}
          brandSet={brandSet}
          openWorkbench={openWorkbench}
        />
      )}
      {view === "workbench" && (
        <Workbench
          runId={runId}
          pooled={metrics}
          project={project}
          plan={plan}
          view={workbenchTab}
          setView={setWorkbenchTab}
          refreshToken={refreshToken}
          preset={wbPreset}
        />
      )}
      {view === "questions" && (
        <QuestionsView
          metrics={metrics}
          project={project}
          insights={insights}
          brandSet={brandSet}
          openWorkbench={openWorkbench}
        />
      )}

      {view === "brief" && (
        <>
          {insights && insights.sections.length > 0 && (
        <section className="card p-6 border-l-4 border-l-[var(--color-primary)]">
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
            <h2 className="section-label">Key takeaways</h2>
          </div>
          <ol className="grid gap-2">
            {[
              ...notesFor("scorecard"),
              ...notesFor("trend"),
            ].map((t, i) => (
              <li key={i} className="flex gap-2.5 text-sm text-ink-2">
                <span className="font-semibold text-primary tabular-nums">
                  {i + 1}
                </span>
                <span>
                  {t}
                  <button type="button"
                    onClick={() => openWorkbench(...cite("scorecard"))}
                    title="See this data in the Workbench"
                    className="ml-1.5 font-semibold text-primary hover:opacity-80">
                    ↗
                  </button>
                </span>
              </li>
            ))}
          </ol>
          {insights.plays.length > 0 && (
            <details className="mt-4 group">
              <summary className="cursor-pointer text-sm font-semibold text-primary list-none">
                <span className="group-open:hidden">
                  ▸ What to do next — {insights.plays.length} recommended plays
                </span>
                <span className="hidden group-open:inline">
                  ▾ What to do next — {insights.plays.length} recommended plays
                </span>
              </summary>
              <div className="mt-3 grid gap-3 lg:grid-cols-3 sm:grid-cols-2">
                {insights.plays.map((pl) => (
                  <div
                    key={pl.title}
                    className="rounded-xl border border-line p-4 grid gap-1.5 content-start"
                  >
                    <span className="text-sm font-semibold">{pl.title}</span>
                    <span className="text-[12px] text-ink-3">{pl.gap}</span>
                    <span className="text-[13px] text-ink-2">{pl.play}</span>
                    <span className="text-[12px] text-ink-3">
                      Graded by: {pl.measuredBy} — today {pl.today}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      <section
        className={`grid gap-3 sm:grid-cols-2 ${metrics.coded ? "lg:grid-cols-4" : "sm:grid-cols-3"}`}
      >
        <StatTile
          label="Mentioned rate"
          value={pct(target.mentionRate)}
          detail={`mentioned in ${target.mentionCount} of ${metrics.unbrandedResponses} answers`}
          hint="Share of unbranded answers that name you at all"
        />
        {metrics.coded && metrics.firstPick && (
          <StatTile
            label="Chosen"
            value={pct(metrics.firstPick.rate)}
            detail={`${metrics.firstPick.count} of ${metrics.firstPick.of} answers`}
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
          detail={`#${targetPos} of ${setBrands.length} brands in set`}
          hint="Your mentions as a share of all brand mentions"
        />
      </section>

      {metrics.engines && metrics.engines.length > 1 && (
        <section className="card p-6">
          <h2 className="section-label mb-1">By engine</h2>
          <InsightNote sentences={notesFor("engines")}
            onVerify={() => openWorkbench(...cite("engines"))} />
          <p className="text-[13px] text-ink-3 mb-4">
            The same battery answered by each assistant. Answers come from the
            engine; every answer then goes through the same coding, so these
            differences are the engines, not the measurement.
          </p>
          <SortTable
            filename="by_engine.csv"
            defaultSort={{ id: "named", dir: -1 }}
            cols={[
              { id: "engine", label: "Engine",
                val: (e: NonNullable<RunMetrics["engines"]>[number]) => e.model,
                render: (e) => (
                  <span className="font-medium whitespace-nowrap">
                    {e.model}
                    {e.mode === "search" && (
                      <span className="ml-1.5 rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                        search
                      </span>
                    )}
                  </span>
                ) },
              { id: "answers", label: "Answers", num: true, val: (e) => e.answers },
              { id: "named", label: "Mentioned", num: true,
                val: (e) => Math.round(e.namedRate * 100),
                render: (e) => pct(e.namedRate) },
              { id: "pick", label: "Chosen", num: true,
                val: (e) => Math.round(e.pickRate * 100),
                render: (e) => pct(e.pickRate) },
              { id: "pos", label: "Avg position", num: true,
                val: (e) => e.avgPosition,
                render: (e) => (e.avgPosition ? `#${e.avgPosition.toFixed(1)}` : "—") },
              { id: "searched", label: "Searched", num: true,
                val: (e) => (e.searchRate !== null ? Math.round(e.searchRate * 100) : null),
                render: (e) =>
                  e.mode !== "search" ? "—"
                  : e.searchRate !== null ? pct(e.searchRate)
                  : e.citedAnswers > 0 ? "always" : "—" },
            ]}
            rows={metrics.engines}
          />
        </section>
      )}

      {metrics.modes && metrics.modes.length > 1 && (
        <section className="card p-6">
          <h2 className="section-label mb-1">Instinct vs search-enabled</h2>
          <InsightNote sentences={notesFor("modes")}
            onVerify={() => openWorkbench(...cite("modes"))} />
          <p className="text-[13px] text-ink-3 mb-4">
            The same battery, two instruments: instinct engines answer from
            trained knowledge alone; search-enabled engines may retrieve like
            the consumer apps. The gap is visibility the live web grants or
            withholds relative to the model&apos;s priors.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {metrics.modes.map((m) => (
              <div
                key={m.mode}
                className="rounded-xl border border-line p-4 grid gap-2"
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold capitalize">
                    {m.mode === "search" ? "Search-enabled" : "Instinct"}
                  </span>
                  <span className="text-[11px] text-ink-3">
                    {m.answers} answers · {m.engines.length} engine
                    {m.engines.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  <div>
                    <div className="text-xl font-semibold tabular-nums">
                      {pct(m.namedRate)}
                    </div>
                    <div className="text-[11px] text-ink-3">
                      mentioned
                    </div>
                  </div>
                  <div>
                    <div className="text-xl font-semibold tabular-nums">
                      {pct(m.pickRate)}
                    </div>
                    <div className="text-[11px] text-ink-3">chosen</div>
                  </div>
                  <div>
                    <div className="text-xl font-semibold tabular-nums">
                      {m.avgPosition ? `#${m.avgPosition.toFixed(1)}` : "—"}
                    </div>
                    <div className="text-[11px] text-ink-3">avg position</div>
                  </div>
                </div>
                <div className="text-[12px] text-ink-2">
                  {m.mode === "search" ? (
                    <>
                      {m.searchRate !== null
                        ? `Searched on ${pct(m.searchRate)} of answers`
                        : "Always grounded"}
                      {" · "}
                      {m.citedAnswers} answers carried citations
                    </>
                  ) : (
                    "No retrieval — the stable baseline"
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {metrics.coded && setTopPicks && setTopPicks.length > 0 && (
        <section className="card p-6">
          <h2 className="section-label mb-1">Who wins instead</h2>
          <InsightNote sentences={notesFor("top_picks")}
            onVerify={() => openWorkbench(...cite("top_picks"))} />
          <p className="text-[13px] text-ink-3 mb-4">
            The brand each answer actually crowned - over the{" "}
            {metrics.outcomes?.pick ?? 0} answers that committed to a pick
            {metrics.outcomes
              ? ` (${metrics.outcomes.no_pick} explained without picking, ${metrics.outcomes.clarification} asked a question instead)`
              : ""}
            .
          </p>
          <div className="grid gap-2">
            {setTopPicks.slice(0, 10).map((t) => (
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
                      width: `${(t.shareOfDecided / (setTopPicks[0].shareOfDecided || 1)) * 100}%`,
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
          <InsightNote sentences={notesFor("arguments")}
            onVerify={() => openWorkbench(...cite("arguments"))} />
          <p className="text-[13px] text-ink-3 mb-4">
            Which arguments travel with your wins - share of answers using each
            argument, in the answers that chose you vs overall. Positive lift =
            arguments to feed; negative = the conversations you&apos;re losing.
          </p>
          <SortTable
            filename="arguments.csv"
            defaultSort={{ id: "lift", dir: -1 }}
            cols={[
              { id: "code", label: "Argument",
                val: (r: NonNullable<RunMetrics["reasonLift"]>[number]) => r.code,
                render: (r) => <span className="font-medium">{r.code}</span> },
              { id: "all", label: "In all answers", num: true,
                val: (r) => Math.round(r.shareAll * 100),
                render: (r) => pct(r.shareAll) },
              { id: "wins", label: "In your wins", num: true,
                val: (r) => Math.round(r.shareWins * 100),
                render: (r) => pct(r.shareWins) },
              { id: "lift", label: "Lift", num: true,
                val: (r) => Math.round(r.lift * 100),
                render: (r) => (
                  <span className={r.lift > 0.02 ? "text-success font-semibold" : r.lift < -0.02 ? "text-danger font-semibold" : ""}>
                    {r.lift >= 0 ? "+" : ""}{(r.lift * 100).toFixed(0)} pts
                  </span>
                ) },
            ]}
            rows={metrics.reasonLift}
          />
        </section>
      )}

      <section className="card p-6">
        <h2 className="section-label mb-1">Brand leaderboard</h2>
          <InsightNote sentences={notesFor("leaderboard")}
            onVerify={() => openWorkbench(...cite("leaderboard"))} />
        <p className="text-[13px] text-ink-3 mb-5">
          Mention rate across unbranded answers — named competitors and brands
          the model volunteered on its own.
        </p>
        <div className="grid gap-2.5">
          {leaderboard.map((b) => (
            <div
              key={b.brand}
              className="group grid grid-cols-[9rem_1fr_7rem] items-center gap-3"
              title={`${b.brand}: mentioned in ${b.mentionCount} of ${metrics.unbrandedResponses} answers · avg position ${b.avgRank ? b.avgRank.toFixed(1) : "—"} · recommended ${b.framing.recommended}× · negative ${b.framing.negative}×`}
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
          <LegendSwatch
            color="bg-neutral-bar"
            label="volunteered by the model"
          />
        </div>
      </section>

      {metrics.parentRollup && metrics.parentRollup.length > 0 && (
        <section className="card p-6">
          <h2 className="section-label mb-1">By parent company</h2>
          <InsightNote sentences={notesFor("parents")}
            onVerify={() => openWorkbench(...cite("parents"))} />
          <p className="text-[13px] text-ink-3 mb-5">
            Combined footprint at parent grain — every independent brand is
            its own parent company. An answer naming any of a parent&apos;s
            brands counts once, so this is reach, not a sum of the rows above.
          </p>
          <div className="grid gap-2.5">
            {(() => {
              // Top rows only, with the target's parent always on the board.
              const shown = metrics.parentRollup!.slice(0, 12);
              const mine = metrics.parentRollup!.find((p) => p.includesTarget);
              if (mine && !shown.includes(mine)) shown[shown.length - 1] = mine;
              return shown;
            })().map((p) => {
              const maxParent = Math.max(
                ...metrics.parentRollup!.map((x) => x.mentionRate),
                0.01
              );
              return (
                <div
                  key={p.parent}
                  className="grid grid-cols-[9rem_1fr_11rem] items-center gap-3"
                  title={`${p.parent}: ${p.brands.join(", ")} — mentioned in ${p.responses} of ${metrics.unbrandedResponses} answers · ${pct(p.shareOfVoice)} share of voice`}
                >
                  <span
                    className={`truncate text-sm text-right ${p.includesTarget ? "font-semibold text-primary" : "text-ink-2"}`}
                  >
                    {p.parent}
                  </span>
                  <div className="h-4 relative">
                    <div
                      className={`absolute inset-y-0 left-0 rounded-r-[4px] ${p.includesTarget ? "bg-primary" : "bg-ink-3"}`}
                      style={{
                        width: `${(p.mentionRate / maxParent) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="text-sm tabular-nums text-ink-2 whitespace-nowrap">
                    {pct(p.mentionRate)}
                    <span className="text-xs text-ink-3">
                      {" "}
                      · SOV{" "}
                      {pct(p.shareOfVoice)}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-ink-3 mt-4">
            {metrics.parentRollup
              .filter((p) => p.brands.length > 1)
              .map((p) => `${p.parent}: ${p.brands.join(", ")}`)
              .join(" · ") || null}
            {metrics.parentRollup.some((p) => p.brands.length > 1)
              ? " — every other brand stands as its own parent."
              : "Every brand currently stands as its own parent."}
          </p>
        </section>
      )}

      <details className="card p-6">
        <summary className="cursor-pointer list-none">
          <h2 className="section-label mb-1 inline">Full brand table</h2>
          <span className="ml-2 text-[13px] text-ink-3">
            every brand with full metrics — for reference; the workbook
            carries the live version ▸
          </span>
        </summary>
        <p className="text-[13px] text-ink-3 mb-4 mt-3">
          Every brand mentioned in this run, with its full metrics
.
        </p>
        <SortTable
          filename="brands.csv"
          defaultSort={{ id: "rate", dir: -1 }}
          cols={[
            { id: "brand", label: "Brand", val: (b: BrandStats) => b.brand,
              render: (b) => (
                <span className={b.isTarget ? "font-semibold text-primary" : "text-ink-2"}>
                  {b.brand}
                </span>
              ) },
            { id: "type", label: "Type",
              val: (b) => (b.isTarget ? "you" : b.isCompetitor ? "competitor" : "emerged") },
            { id: "rate", label: "Mention rate", num: true,
              val: (b) => Math.round(b.mentionRate * 100),
              render: (b) => pct(b.mentionRate) },
            { id: "pos", label: "Avg position", num: true,
              val: (b) => b.avgRank,
              render: (b) => (b.avgRank ? `#${b.avgRank.toFixed(1)}` : "—") },
            { id: "sov", label: "Share of voice", num: true,
              val: (b) => Math.round(b.shareOfVoice * 100),
              render: (b) => pct(b.shareOfVoice) },
            { id: "rec", label: "Recommended", num: true,
              val: (b) => b.framing.recommended },
            { id: "neg", label: "Negative", num: true,
              val: (b) => b.framing.negative },
          ]}
          rows={setBrands}
        />
      </details>

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
              title={`${t.prompts} prompts · ${t.targetMentions} of ${t.responses} answers name ${project.brand}`}
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
                  ·{" "}
                  {t.targetAvgRank ? `#${t.targetAvgRank.toFixed(1)}` : "—"}
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="card p-6">
        <h2 className="section-label mb-4">Where you show up — by prompt</h2>
          <InsightNote sentences={notesFor("prompts")}
            onVerify={() => openWorkbench(...cite("prompts"))} />
        <SortTable
          filename="by_prompt.csv"
          defaultSort={{ id: "appear", dir: -1 }}
          cols={[
            { id: "prompt", label: "Prompt",
              val: (p: (typeof metrics.prompts)[number]) => p.text,
              render: (p) => (
                <span className="line-clamp-2 max-w-[24rem]" title={p.text}>
                  {p.text}
                </span>
              ) },
            { id: "theme", label: "Theme", val: (p) => p.theme,
              render: (p) => (
                <span className="whitespace-nowrap text-xs text-ink-3">
                  {p.theme.replace("_", " ")}
                </span>
              ) },
            { id: "appear", label: "You appear", num: true,
              val: (p) => (p.responses > 0 ? Math.round((p.targetMentions / p.responses) * 100) : null),
              render: (p) => (
                <span className={`whitespace-nowrap ${p.targetMentions > 0 ? "font-medium" : "text-ink-3"}`}>
                  {p.targetMentions}/{p.responses}
                </span>
              ) },
            { id: "pos", label: "Avg position", num: true,
              val: (p) => p.targetAvgRank,
              render: (p) => (p.targetAvgRank ? `#${p.targetAvgRank.toFixed(1)}` : "—") },
            { id: "consensus", label: "Consensus pick",
              val: (p) =>
                metrics.promptGrid?.find((x) => x.promptId === p.promptId)?.modalPick ?? null,
              render: (p) => {
                const g = metrics.promptGrid?.find((x) => x.promptId === p.promptId);
                return (
                  <span className="whitespace-nowrap text-ink-2">
                    {g?.modalPick ?? (g && p.theme !== "branded" ? "split / no pick" : "—")}
                  </span>
                );
              } },
            { id: "status", label: "Status",
              val: (p) =>
                metrics.promptGrid?.find((x) => x.promptId === p.promptId)?.badge ?? null,
              render: (p) => {
                const g = metrics.promptGrid?.find((x) => x.promptId === p.promptId);
                return g ? <Badge badge={g.badge} /> : null;
              } },
          ]}
          rows={metrics.prompts}
        />
      </section>

      {metrics.sources && metrics.sources.domains.length > 0 && (
        <section className="card p-6">
          <h2 className="section-label mb-1">
            Where grounded answers get their facts
          </h2>
          <InsightNote sentences={notesFor("sources")}
            onVerify={() => openWorkbench(...cite("sources"))} />
          <p className="text-[13px] text-ink-3 mb-4">
            Domains cited by the {metrics.sources.citedAnswers} answers from
            citation-grounded engines — each domain counted once per answer.
            These sites are writing the AI&apos;s script for your category.
          </p>
          <div className="grid gap-2">
            {metrics.sources.domains.slice(0, 12).map((d) => (
              <div
                key={d.domain}
                className="grid grid-cols-[14rem_1fr_9rem] items-center gap-3"
              >
                <span
                  className={`truncate text-sm text-right ${d.brand ? "font-semibold text-primary" : "text-ink-2"}`}
                  title={d.brand ? `Owned/operated by ${d.brand}` : undefined}
                >
                  {d.domain}
                  {d.brand ? " ●" : ""}
                </span>
                <div className="h-4 relative">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-r-[4px] ${d.brand ? "bg-primary" : "bg-neutral-bar"}`}
                    style={{
                      width: `${(d.share / (metrics.sources!.domains[0].share || 1)) * 100}%`,
                    }}
                  />
                </div>
                <span className="text-sm tabular-nums text-ink-2">
                  {d.answers} answers
                  <span className="text-xs text-ink-3"> · {pct(d.share)}</span>
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-3 mt-4">
            ● = domain matches a tracked brand (owned media). Everything else
            is earned/editorial — the influence surface where content work
            pays off.
          </p>
        </section>
      )}

      {metrics.negatives && metrics.negatives.length > 0 && (
        <section className="card p-6">
          <h2 className="section-label mb-1">Where the answers push back</h2>
          <InsightNote sentences={notesFor("negatives")}
            onVerify={() => openWorkbench(...cite("negatives"))} />
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
              <div className="border-l-2 border-line pl-4">
                <AnswerText text={v.text} />
              </div>
            </div>
          ))}
        </div>
      </section>
        </>
      )}
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

/** A section's verified reading — the deck-caption pattern, in the app. */
function InsightNote({
  sentences,
  onVerify,
}: {
  sentences: string[];
  onVerify?: () => void;
}) {
  if (sentences.length === 0) return null;
  return (
    <div className="my-3 rounded-lg bg-primary-soft/40 px-3.5 py-2.5 grid gap-1">
      {sentences.map((t, i) => (
        <p key={i} className="text-[13px] leading-snug text-ink-2">
          {t}
          {i === sentences.length - 1 && onVerify && (
            <button type="button" onClick={onVerify}
              title="See this data in the Workbench"
              className="ml-1.5 font-semibold text-primary hover:opacity-80">
              ↗
            </button>
          )}
        </p>
      ))}
    </div>
  );
}
