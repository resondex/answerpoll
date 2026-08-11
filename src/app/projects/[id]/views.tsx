"use client";

import { useMemo, useState } from "react";
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
/* C — The Workbench: one cut at a time, filters everywhere            */
/* ================================================================== */

export function WorkbenchView({
  metrics,
  pooled,
  filterPending,
  project,
  insights,
  brandSet,
  tab,
  setTab,
  modeFilter,
  setModeFilter,
  focus,
  setFocus,
}: ViewProps & {
  /** Unfiltered run metrics — drives the tab list and the modes comparison. */
  pooled: RunMetrics;
  /** True while a slice is still being computed server-side. */
  filterPending: boolean;
  tab: WorkbenchTab;
  setTab: (t: WorkbenchTab) => void;
  modeFilter: "all" | "instinct" | "search";
  setModeFilter: (m: "all" | "instinct" | "search") => void;
  /** Brand lens: null = the client's own view. */
  focus: string | null;
  setFocus: (b: string | null) => void;
}) {
  const filtered = modeFilter !== "all" || focus !== null;
  const [expandedBrand, setExpandedBrand] = useState<string | null>(null);
  const tabs = useMemo(() => {
    const t: { id: WorkbenchTab; label: string }[] = [
      { id: "overview", label: "Overview" },
      { id: "engines", label: "Engines" },
    ];
    if (pooled.modes && pooled.modes.length > 1)
      t.push({ id: "modes", label: "Instinct vs search" });
    if (pooled.promptGrid) t.push({ id: "prompts", label: "Prompts" });
    if (pooled.reasonLift) t.push({ id: "arguments", label: "Arguments" });
    if (pooled.sources && pooled.sources.domains.length > 0)
      t.push({ id: "sources", label: "Sources" });
    t.push({ id: "brands", label: "Brands" });
    t.push({ id: "risks", label: "Risks" });
    return t;
  }, [pooled]);

  // Under a mode filter the target can in principle vanish from the slice.
  const target = metrics.brands.find((b) => b.isTarget) ?? {
    brand: project.brand,
    isTarget: true,
    isCompetitor: false,
    mentionCount: 0,
    mentionRate: 0,
    ciLow: 0,
    ciHigh: 0,
    avgRank: null,
    shareOfVoice: 0,
    framing: { recommended: 0, mentioned: 0, negative: 0 },
  };
  const engines = metrics.engines ?? [];

  // Verified readings describe the full run; under a filter they'd disagree
  // with the numbers on screen, so a context line takes their place.
  const SliceNote = ({ sentences }: { sentences: string[] }) =>
    filtered ? (
      <p className="text-[12px] text-ink-3">
        {filterPending
          ? "Recomputing this slice…"
          : `Every number above is recomputed for this slice (${
              focus ? `focus: ${focus}` : ""
            }${focus && modeFilter !== "all" ? ", " : ""}${
              modeFilter !== "all" ? `${modeFilter} answers only` : ""
            }). Verified readings describe the client's full run — clear the filters to see them.`}
      </p>
    ) : (
      <Note sentences={sentences} />
    );

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5">
        {(["all", "instinct", "search"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setModeFilter(m)}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${
              modeFilter === m
                ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                : "border-line text-ink-3 hover:border-ink-3"
            }`}
          >
            {m === "all" ? "All modes" : m === "instinct" ? "Instinct" : "Search"}
          </button>
        ))}
        <label className="ml-2 inline-flex items-center gap-1.5 text-[12px] text-ink-3">
          Viewing as:
          <select
            value={focus ?? "__client__"}
            onChange={(e) =>
              setFocus(e.target.value === "__client__" ? null : e.target.value)
            }
            className={`input w-auto py-0.5 text-[12px] ${focus ? "border-warning text-warning font-semibold" : ""}`}
            title="The brand lens — every cut recomputes with this brand as the focus, like the workbook's Focus dropdown"
          >
            <option value="__client__">{project.brand} (client)</option>
            {pooled.brands
              .filter((b) => !b.isTarget)
              .slice(0, 30)
              .map((b) => (
                <option key={b.brand} value={b.brand}>
                  {b.brand}
                </option>
              ))}
          </select>
        </label>
        <span className="text-[12px] text-ink-3 ml-1">
          {filtered
            ? filterPending
              ? "recomputing this slice…"
              : "every cut below is recomputed for this slice"
            : "pick an instrument or a brand to recompute every cut"}
        </span>
      </div>
      {focus && !filterPending && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-warning/8 px-4 py-2 text-[13px]">
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
            Lens
          </span>
          <span className="text-ink-2">
            All numbers are <span className="font-semibold">{focus}</span>&apos;s.
            Verified readings and quotes are coded for {project.brand} and
            step aside under a lens.
          </span>
          <button
            type="button"
            onClick={() => setFocus(null)}
            className="text-[13px] font-semibold text-primary hover:opacity-80"
          >
            ← back to {project.brand}
          </button>
        </div>
      )}
      <div className="grid md:grid-cols-[11rem_1fr]">
        <nav className="border-b md:border-b-0 md:border-r border-line py-2 flex md:grid content-start overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-left text-sm whitespace-nowrap ${
                tab === t.id
                  ? "font-semibold text-primary md:border-r-2 border-[var(--color-primary)] bg-primary-soft/40"
                  : "text-ink-2 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="p-5 grid gap-4 content-start min-h-[22rem]">
          {tab === "overview" && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    l: "Mention rate",
                    v: pct(target.mentionRate),
                    d: `CI ${pct(target.ciLow)}–${pct(target.ciHigh)}`,
                  },
                  {
                    l: "First pick",
                    v: metrics.firstPick ? pct(metrics.firstPick.rate) : "—",
                    d: metrics.firstPick
                      ? `${metrics.firstPick.count} of ${metrics.firstPick.of}`
                      : "not coded",
                  },
                  {
                    l: "Avg position",
                    v: target.avgRank ? `#${target.avgRank.toFixed(1)}` : "—",
                    d: "when named",
                  },
                  {
                    l: "Share of voice",
                    v: pct(target.shareOfVoice),
                    d: "of all brand mentions",
                  },
                ].map((s) => (
                  <div key={s.l} className="rounded-xl border border-line p-4">
                    <div className="section-label">{s.l}</div>
                    <div className="text-2xl font-semibold tabular-nums mt-1">
                      {s.v}
                    </div>
                    <div className="text-[12px] text-ink-3 mt-0.5">{s.d}</div>
                  </div>
                ))}
              </div>
              <SliceNote sentences={notesFor(insights, "scorecard")} />
            </>
          )}

          {tab === "engines" && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
                      <th className="py-2 pr-4 font-semibold">Engine</th>
                      <th className="py-2 pr-4 font-semibold text-right">Answers</th>
                      <th className="py-2 pr-4 font-semibold text-right">Named</th>
                      <th className="py-2 pr-4 font-semibold text-right">95% CI</th>
                      <th className="py-2 pr-4 font-semibold text-right">First pick</th>
                      <th className="py-2 font-semibold text-right">Searched</th>
                    </tr>
                  </thead>
                  <tbody>
                    {engines.map((e) => (
                      <tr key={e.model} className="border-b border-line/60">
                        <td className="py-2 pr-4 font-medium">
                          {e.model}
                          {e.mode === "search" && (
                            <span className="ml-1.5 rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                              search
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums text-ink-2">{e.answers}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{pct(e.namedRate)}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-ink-3 whitespace-nowrap">
                          {pct(e.ciLow)}–{pct(e.ciHigh)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">{pct(e.pickRate)}</td>
                        <td className="py-2 text-right tabular-nums text-ink-2">
                          {e.mode === "search"
                            ? e.searchRate !== null
                              ? pct(e.searchRate)
                              : e.citedAnswers > 0
                                ? "always"
                                : "—"
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <SliceNote sentences={notesFor(insights, "engines")} />
            </>
          )}

          {tab === "modes" && pooled.modes && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {pooled.modes.map((m) => (
                  <div key={m.mode} className="rounded-xl border border-line p-4 grid gap-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-semibold">
                        {m.mode === "search" ? "Search-enabled" : "Instinct"}
                      </span>
                      <span className="text-[11px] text-ink-3">
                        {m.answers} answers · {m.engines.length} engine{m.engines.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-6 gap-y-1">
                      <div>
                        <div className="text-xl font-semibold tabular-nums">{pct(m.namedRate)}</div>
                        <div className="text-[11px] text-ink-3">named · CI {pct(m.ciLow)}–{pct(m.ciHigh)}</div>
                      </div>
                      <div>
                        <div className="text-xl font-semibold tabular-nums">{pct(m.pickRate)}</div>
                        <div className="text-[11px] text-ink-3">first pick</div>
                      </div>
                      <div>
                        <div className="text-xl font-semibold tabular-nums">
                          {m.searchRate !== null ? pct(m.searchRate) : m.mode === "search" ? "always" : "—"}
                        </div>
                        <div className="text-[11px] text-ink-3">searched</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <Note sentences={notesFor(insights, "modes")} />
            </>
          )}

          {tab === "prompts" && metrics.promptGrid && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
                      <th className="py-2 pr-4 font-semibold">Prompt</th>
                      <th className="py-2 pr-4 font-semibold text-right">Named</th>
                      <th className="py-2 pr-4 font-semibold text-right">Picked</th>
                      <th className="py-2 pr-4 font-semibold">Consensus pick</th>
                      <th className="py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.promptGrid.map((g) => (
                      <tr key={g.promptId} className="border-b border-line/60">
                        <td className="py-2 pr-4 text-ink-2 max-w-[26rem]">
                          <span className="line-clamp-2">{g.text}</span>
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {g.targetNamed}/{g.answers}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {g.targetPicks}/{g.decided}
                        </td>
                        <td className="py-2 pr-4 text-ink-2">{g.modalPick ?? "—"}</td>
                        <td className="py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                              g.badge === "win"
                                ? "bg-success/12 text-success"
                                : g.badge === "contested"
                                  ? "bg-warning/15 text-warning"
                                  : "bg-danger/10 text-danger"
                            }`}
                          >
                            {g.badge}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <SliceNote sentences={notesFor(insights, "prompts")} />
            </>
          )}

          {tab === "arguments" && metrics.reasonLift && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
                      <th className="py-2 pr-4 font-semibold">Argument</th>
                      <th className="py-2 pr-4 font-semibold text-right">All answers</th>
                      <th className="py-2 pr-4 font-semibold text-right">In your wins</th>
                      <th className="py-2 font-semibold text-right">Lift</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...metrics.reasonLift]
                      .sort((a, b) => b.lift - a.lift)
                      .map((r) => (
                        <tr key={r.code} className="border-b border-line/60">
                          <td className="py-2 pr-4 font-medium">{r.code}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-ink-2">{pct(r.shareAll)}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{pct(r.shareWins)}</td>
                          <td
                            className={`py-2 text-right tabular-nums font-semibold ${
                              r.lift > 0.02 ? "text-success" : r.lift < -0.02 ? "text-danger" : "text-ink-2"
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
              <SliceNote sentences={notesFor(insights, "arguments")} />
            </>
          )}

          {tab === "sources" && !metrics.sources && (
            <p className="text-sm text-ink-3">
              No cited answers in this slice — citations come from
              search-enabled engines.
            </p>
          )}
          {tab === "sources" && metrics.sources && (
            <>
              <div className="grid gap-2">
                {metrics.sources.domains.slice(0, 12).map((d) => (
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
              <p className="text-xs text-ink-3">
                ● = brand-owned domain. Everything else is earned/editorial —
                the surface where content work pays off.
              </p>
              <SliceNote sentences={notesFor(insights, "sources")} />
            </>
          )}

          {tab === "brands" && (
            <>
              <p className="text-[12px] text-ink-3 -mb-1">
                Click any brand to unfold its card.
              </p>
              <div className="grid gap-1">
                {metrics.brands
                  .filter((b) => inSet(brandSet, b))
                  .slice(0, 15)
                  .map((b) => {
                    const open = expandedBrand === b.brand;
                    const picks = metrics.topPicks?.find(
                      (t) => t.brand === b.brand
                    );
                    return (
                      <div key={b.brand}>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedBrand(open ? null : b.brand)
                          }
                          className={`w-full rounded-lg px-2 py-1 text-left hover:bg-primary-soft/30 ${open ? "bg-primary-soft/30" : ""}`}
                        >
                          <BarRow
                            name={`${b.brand} ${open ? "▾" : "▸"}`}
                            isTarget={b.isTarget}
                            share={b.mentionRate}
                            max={metrics.brands[0]?.mentionRate ?? 1}
                            right={`${pct(b.mentionRate)} · ${b.avgRank ? `#${b.avgRank.toFixed(1)}` : "—"}`}
                          />
                        </button>
                        {open && (
                          <div className="mt-1 mb-2 rounded-xl border border-[var(--color-primary)]/40 bg-primary-soft/20 p-4 grid gap-3">
                            <div className="flex flex-wrap gap-x-7 gap-y-2">
                              <div>
                                <div className="text-lg font-semibold tabular-nums">
                                  {pct(b.mentionRate)}
                                </div>
                                <div className="text-[11px] text-ink-3">
                                  named · CI {pct(b.ciLow)}–{pct(b.ciHigh)}
                                </div>
                              </div>
                              <div>
                                <div className="text-lg font-semibold tabular-nums">
                                  {picks ? pct(picks.shareOfDecided) : "0%"}
                                </div>
                                <div className="text-[11px] text-ink-3">
                                  first picks{picks ? ` · ${picks.picks}` : ""}
                                </div>
                              </div>
                              <div>
                                <div className="text-lg font-semibold tabular-nums">
                                  {b.avgRank ? `#${b.avgRank.toFixed(1)}` : "—"}
                                </div>
                                <div className="text-[11px] text-ink-3">
                                  avg position
                                </div>
                              </div>
                              <div>
                                <div className="text-lg font-semibold tabular-nums">
                                  {pct(b.shareOfVoice)}
                                </div>
                                <div className="text-[11px] text-ink-3">
                                  share of voice
                                </div>
                              </div>
                            </div>
                            <div className="text-[12px] text-ink-2">
                              Framing: {b.framing.recommended} recommended ·{" "}
                              {b.framing.mentioned} neutral ·{" "}
                              <span
                                className={
                                  b.framing.negative > 0 ? "text-danger" : ""
                                }
                              >
                                {b.framing.negative} negative
                              </span>
                            </div>
                            {!b.isTarget && (
                              <button
                                type="button"
                                onClick={() => {
                                  setFocus(b.brand);
                                  setTab("overview");
                                }}
                                className="w-fit text-[13px] font-semibold text-primary hover:opacity-80"
                              >
                                Make this my lens →
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
              <SliceNote sentences={notesFor(insights, "leaderboard")} />
            </>
          )}

          {tab === "risks" &&
            (metrics.negatives && metrics.negatives.length > 0 ? (
              <>
                {focus && (
                  <p className="text-[12px] text-ink-3">
                    Verbatim quotes are coded for {project.brand} at collection
                    time — under a lens you see which prompts drew negative
                    framing of {focus}, without the prose.
                  </p>
                )}
                <div className="grid gap-3">
                  {metrics.negatives.slice(0, 8).map((n, i) => (
                    <div key={i} className="border-l-2 border-danger/50 pl-4">
                      <p className="text-[13px] text-ink-3 mb-1">“{n.promptText}”</p>
                      {n.quote && <p className="text-sm text-ink-2 italic">“{n.quote}”</p>}
                      {n.interpretation && (
                        <p className="text-[13px] text-ink-3 mt-1">{n.interpretation}</p>
                      )}
                    </div>
                  ))}
                </div>
                <Note sentences={notesFor(insights, "negatives")} />
              </>
            ) : (
              <p className="text-sm text-ink-3">
                No answers framed {focus ?? project.brand} negatively in this
                slice.
              </p>
            ))}
        </div>
      </div>
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
