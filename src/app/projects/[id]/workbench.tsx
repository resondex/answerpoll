"use client";

import { useEffect, useMemo, useState } from "react";
import type { Project, RunMetrics } from "@/lib/types";

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Series colors: the client is always the primary blue; rivals take the
 * fixed order after it — color follows the entity, never its rank. */
const SERIES = ["var(--color-primary)", "#56809a", "#c0702f", "#7c6aa6", "#4e8f6e"];

export type WbView =
  | "visibility"
  | "choice"
  | "why"
  | "battleground"
  | "sources"
  | "risk"
  | "style";

const VIEWS: { id: WbView; label: string; sub: string }[] = [
  { id: "visibility", label: "Visibility", sub: "who's named" },
  { id: "choice", label: "Choice", sub: "who wins" },
  { id: "why", label: "Why", sub: "the arguments" },
  { id: "battleground", label: "Battleground", sub: "by prompt" },
  { id: "sources", label: "Sources", sub: "what feeds it" },
  { id: "risk", label: "Risk", sub: "negatives" },
  { id: "style", label: "Style", sub: "how engines answer" },
];

/** Old tab ids (Questions deep links) → v2 views. */
const LEGACY: Record<string, WbView> = {
  overview: "visibility",
  engines: "visibility",
  modes: "visibility",
  prompts: "battleground",
  arguments: "why",
  sources: "sources",
  brands: "visibility",
  risks: "risk",
};

interface WbState {
  brandMode: "solo" | "comparative";
  soloBrand: string;
  compBrands: string[];
  grain: "brands" | "parents";
  split: "none" | "engine" | "mode";
  modeFilter: "all" | "instinct" | "search";
  measure: "named" | "firstNamed" | "sov";
}

function brandStats(m: RunMetrics | null) {
  if (!m) return null;
  const t = m.brands.find((b) => b.isTarget);
  if (!t) return null;
  const un = m.unbrandedResponses;
  const pd = m.positionDist;
  return {
    named: t.mentionRate,
    ciLow: t.ciLow,
    ciHigh: t.ciHigh,
    count: t.mentionCount,
    avgRank: t.avgRank,
    sov: t.shareOfVoice,
    framing: t.framing,
    firstNamed: pd && un > 0 ? pd.r1 / un : null,
    top3: pd && un > 0 ? (pd.r1 + pd.r2 + pd.r3) / un : null,
    chosen: m.firstPick?.rate ?? null,
    m,
  };
}

export default function Workbench({
  runId,
  pooled,
  project,
  view: rawView,
  setView,
  refreshToken,
}: {
  runId: string;
  pooled: RunMetrics;
  project: Project;
  view: string;
  setView: (v: string) => void;
  refreshToken: number;
}) {
  const view: WbView = (LEGACY[rawView] ?? rawView) as WbView;
  const storageKey = `answerpoll_wb_${project.id}`;

  const topBrands = useMemo(
    () => pooled.brands.slice(0, 30).map((b) => b.brand),
    [pooled]
  );
  const defaultComp = useMemo(() => {
    const top5 = topBrands.slice(0, 5);
    return top5.includes(project.brand) ? top5 : [project.brand, ...top5.slice(0, 4)];
  }, [topBrands, project.brand]);

  const [st, setSt] = useState<WbState>({
    brandMode: "comparative",
    soloBrand: project.brand,
    compBrands: [],
    grain: "brands",
    split: "none",
    modeFilter: "all",
    measure: "named",
  });
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}");
      setSt((prev) => ({ ...prev, ...saved }));
    } catch {}
    setHydrated(true);
  }, [storageKey]);
  useEffect(() => {
    if (hydrated) window.localStorage.setItem(storageKey, JSON.stringify(st));
  }, [st, hydrated, storageKey]);

  const parents = pooled.parentRollup;
  const parentNames = useMemo(
    () => (parents ?? []).slice(0, 30).map((p) => p.parent),
    [parents]
  );
  const clientParent =
    (parents ?? []).find((p) => p.includesTarget)?.parent ?? project.brand;

  const options = st.grain === "parents" ? parentNames : topBrands;
  const clientName = st.grain === "parents" ? clientParent : project.brand;
  const selected = useMemo(() => {
    if (view === "style") return [clientName];
    if (st.brandMode === "solo") {
      const solo = options.includes(st.soloBrand) || st.soloBrand === clientName
        ? st.soloBrand
        : clientName;
      return [solo];
    }
    const list = st.compBrands.filter((b) => options.includes(b));
    if (list.length > 0) return list.slice(0, 5);
    if (st.grain === "parents") {
      const top5 = parentNames.slice(0, 5);
      return top5.includes(clientParent) ? top5 : [clientParent, ...top5.slice(0, 4)];
    }
    return defaultComp;
  }, [st, options, defaultComp, clientName, clientParent, parentNames, view]);

  // ---- slice fetching: one recompute per (mode, grain, name), cached ----
  const [slices, setSlices] = useState<Record<string, RunMetrics>>({});
  useEffect(() => setSlices({}), [runId, refreshToken]);
  const keyFor = (name: string) =>
    `${st.modeFilter}|${st.grain}|${name}`;
  useEffect(() => {
    let cancelled = false;
    for (const name of selected) {
      const key = keyFor(name);
      if (slices[key]) continue;
      // The client at home state under no mode filter IS the pooled object.
      if (st.grain === "brands" && name === project.brand && st.modeFilter === "all") {
        setSlices((prev) => ({ ...prev, [key]: pooled }));
        continue;
      }
      const params = new URLSearchParams();
      if (st.modeFilter !== "all") params.set("mode", st.modeFilter);
      params.set("focus", st.grain === "parents" ? `parent:${name}` : name);
      fetch(`/api/runs/${runId}/metrics?${params.toString()}`)
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled && d.metrics) {
            setSlices((prev) => ({ ...prev, [key]: d.metrics }));
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, st.modeFilter, st.grain, runId, refreshToken, pooled]);

  const series = selected.map((name, i) => ({
    name,
    isClient: name === clientName,
    color: name === clientName ? SERIES[0] : SERIES[(i % 4) + 1],
    stats: brandStats(slices[keyFor(name)] ?? null),
  }));
  const loading = series.some((s) => !s.stats);
  const solo = st.brandMode === "solo" ? series[0] : null;

  const set = (patch: Partial<WbState>) => setSt((p) => ({ ...p, ...patch }));

  const chip = (on: boolean, extra = "") =>
    `rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${extra} ${
      on
        ? "border-[var(--color-primary)] bg-primary-soft text-primary"
        : "border-line text-ink-3 hover:border-ink-3"
    }`;

  return (
    <div className="card overflow-hidden">
      {/* ---------- control bar ---------- */}
      <div className="grid gap-2 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 w-12">
            Mode
          </span>
          <button type="button" className={chip(st.brandMode === "solo")}
            onClick={() => set({ brandMode: "solo" })}>
            Solo
          </button>
          <button type="button" className={chip(st.brandMode === "comparative")}
            onClick={() => set({ brandMode: "comparative" })}>
            Comparative
          </button>
          {view === "style" ? (
            <span className="text-[12px] text-ink-3 ml-2">
              this view is about the engines — brand selection doesn&apos;t apply
            </span>
          ) : st.brandMode === "solo" ? (
            <select
              value={selected[0]}
              onChange={(e) => set({ soloBrand: e.target.value })}
              className="input w-auto py-0.5 text-[12px] ml-1"
            >
              {[clientName, ...options.filter((o) => o !== clientName)].map(
                (o) => (
                  <option key={o} value={o}>
                    {o === clientName ? `${o} (client)` : o}
                  </option>
                )
              )}
            </select>
          ) : (
            <>
              {selected.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() =>
                    set({ compBrands: selected.filter((b) => b !== name) })
                  }
                  className="rounded-full border px-2.5 py-0.5 text-[12px] font-semibold"
                  style={{
                    borderColor: series.find((s) => s.name === name)?.color,
                    color: series.find((s) => s.name === name)?.color,
                  }}
                  title="Remove from comparison"
                >
                  {name} ✕
                </button>
              ))}
              {selected.length < 5 && (
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value)
                      set({ compBrands: [...selected, e.target.value] });
                  }}
                  className="input w-auto py-0.5 text-[12px]"
                >
                  <option value="">+ add</option>
                  {options
                    .filter((o) => !selected.includes(o))
                    .map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                </select>
              )}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {parents && parents.length > 0 && (
            <>
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 w-12">
                Grain
              </span>
              <button type="button" className={chip(st.grain === "brands")}
                onClick={() => set({ grain: "brands", compBrands: [], soloBrand: project.brand })}>
                Brands
              </button>
              <button type="button" className={chip(st.grain === "parents")}
                onClick={() => set({ grain: "parents", compBrands: [], soloBrand: clientParent })}>
                Parents
              </button>
            </>
          )}
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 w-10 ml-1">
            Split
          </span>
          {(["none", "engine", "mode"] as const).map((sp) => (
            <button key={sp} type="button"
              className={chip(st.split === sp)}
              onClick={() => set({ split: sp, measure: sp === "none" ? st.measure : "named" })}>
              {sp === "none" ? "None" : sp === "engine" ? "Engine" : "Mode"}
            </button>
          ))}
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 ml-2">
            Filter
          </span>
          {(["all", "instinct", "search"] as const).map((m) => (
            <button key={m} type="button" className={chip(st.modeFilter === m)}
              onClick={() => set({ modeFilter: m })}>
              {m === "all" ? "All modes" : m === "instinct" ? "Instinct" : "Search"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-[11.5rem_1fr]">
        <nav className="border-b md:border-b-0 md:border-r border-line py-2 flex md:grid content-start overflow-x-auto">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" onClick={() => setView(v.id)}
              className={`px-4 py-2 text-left whitespace-nowrap ${
                view === v.id
                  ? "font-semibold text-primary md:border-r-2 border-[var(--color-primary)] bg-primary-soft/40"
                  : "text-ink-2 hover:text-ink"
              }`}>
              <span className="text-sm">{v.label}</span>
              <span className="block text-[10px] text-ink-3 font-normal">
                {v.sub}
              </span>
            </button>
          ))}
        </nav>
        <div className="p-5 grid gap-4 content-start min-h-[24rem]">
          {loading && view !== "style" ? (
            <p className="text-sm text-ink-3">Computing slices…</p>
          ) : (
            <>
              {view === "visibility" && (
                <Visibility series={series} solo={solo} st={st} set={set} />
              )}
              {view === "choice" && (
                <Choice series={series} pooled={pooled} st={st} />
              )}
              {view === "why" && <Why series={series} />}
              {view === "battleground" && (
                <Battleground series={series} pooled={pooled} />
              )}
              {view === "sources" && <Sources pooled={pooled} />}
              {view === "risk" && (
                <Risk series={series} pooled={pooled} project={project} />
              )}
              {view === "style" && <Style pooled={pooled} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type Series = {
  name: string;
  isClient: boolean;
  color: string;
  stats: ReturnType<typeof brandStats>;
}[];

function Bar({ w, color }: { w: number; color: string }) {
  return (
    <div className="h-4 relative">
      <div className="absolute inset-y-0 left-0 rounded-r-[4px]"
        style={{ width: `${Math.min(w, 1) * 100}%`, background: color }} />
    </div>
  );
}

function SeriesBars({
  rows,
}: {
  rows: { label: string; color: string; value: number | null; right: string }[];
}) {
  const max = Math.max(...rows.map((r) => r.value ?? 0), 0.01);
  return (
    <div className="grid gap-1.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[10rem_1fr_11rem] items-center gap-3">
          <span className="truncate text-sm text-right font-medium" style={{ color: r.color }}>
            {r.label}
          </span>
          <Bar w={(r.value ?? 0) / max} color={r.color} />
          <span className="text-[13px] tabular-nums text-ink-2">{r.right}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Visibility ---------------- */
function Visibility({
  series, solo, st, set,
}: {
  series: Series;
  solo: Series[number] | null;
  st: WbState;
  set: (p: Partial<WbState>) => void;
}) {
  const measures = [
    ["named", "Named rate"],
    ["firstNamed", "First-named"],
    ["sov", "Share of voice"],
  ] as const;
  const valOf = (s: Series[number]) =>
    st.measure === "named" ? s.stats!.named
    : st.measure === "firstNamed" ? s.stats!.firstNamed
    : s.stats!.sov;
  const rightOf = (s: Series[number]) => {
    const v = valOf(s);
    if (v === null) return "—";
    const pos = s.stats!.avgRank ? ` · #${s.stats!.avgRank.toFixed(1)}` : "";
    return st.measure === "named"
      ? `${pct(v)} · CI ${pct(s.stats!.ciLow)}–${pct(s.stats!.ciHigh)}${pos}`
      : `${pct(v)}${pos}`;
  };

  if (solo && solo.stats) {
    const s = solo.stats;
    return (
      <>
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {[
            [pct(s.named), `named · CI ${pct(s.ciLow)}–${pct(s.ciHigh)}`],
            [s.firstNamed !== null ? pct(s.firstNamed) : "—", "first-named"],
            [pct(s.sov), "share of voice"],
            [s.avgRank ? `#${s.avgRank.toFixed(1)}` : "—", "avg position"],
          ].map(([v, l]) => (
            <div key={l}>
              <div className="text-2xl font-semibold tabular-nums">{v}</div>
              <div className="text-[11px] text-ink-3">{l}</div>
            </div>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-line p-4">
            <div className="section-label mb-2">Funnel</div>
            {[
              ["Named", s.named],
              ["Top-3", s.top3],
              ["Chosen", s.chosen],
            ].map(([l, v]) => (
              <div key={l as string} className="flex justify-between text-sm py-0.5">
                <span className="text-ink-2">{l}</span>
                <span className="font-semibold tabular-nums">
                  {v !== null ? pct(v as number) : "—"}
                </span>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-line p-4">
            <div className="section-label mb-2">Framing</div>
            {(["recommended", "mentioned", "negative"] as const).map((f) => (
              <div key={f} className="flex justify-between text-sm py-0.5">
                <span className="text-ink-2">{f === "mentioned" ? "neutral" : f}</span>
                <span className={`font-semibold tabular-nums ${f === "negative" && s.framing[f] > 0 ? "text-danger" : ""}`}>
                  {s.framing[f]}
                </span>
              </div>
            ))}
          </div>
        </div>
        {s.m.engines && s.m.engines.length > 1 && (
          <div>
            <div className="section-label mb-2">Named rate by engine</div>
            <SeriesBars rows={s.m.engines.map((e) => ({
              label: e.model, color: solo.color, value: e.namedRate,
              right: `${pct(e.namedRate)} · picks ${pct(e.pickRate)}`,
            }))} />
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Measure
        </span>
        {measures.map(([id, label]) => (
          <button key={id} type="button"
            disabled={st.split !== "none" && id !== "named"}
            onClick={() => set({ measure: id })}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${
              st.measure === id
                ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                : "border-line text-ink-3 hover:border-ink-3 disabled:opacity-40"
            }`}>
            {label}
          </button>
        ))}
        {st.split !== "none" && (
          <span className="text-[11px] text-ink-3">splits show named rate</span>
        )}
      </div>
      {st.split === "none" && (
        <SeriesBars rows={series.map((s) => ({
          label: s.name, color: s.color, value: valOf(s), right: rightOf(s),
        }))} />
      )}
      {st.split === "engine" && (
        <div className="grid gap-4">
          {(series[0].stats?.m.engines ?? []).map((e) => (
            <div key={e.model}>
              <div className="section-label mb-1.5">{e.model}</div>
              <SeriesBars rows={series.map((s) => {
                const row = s.stats?.m.engines?.find((x) => x.model === e.model);
                return {
                  label: s.name, color: s.color, value: row?.namedRate ?? null,
                  right: row ? `${pct(row.namedRate)} · picks ${pct(row.pickRate)}` : "—",
                };
              })} />
            </div>
          ))}
        </div>
      )}
      {st.split === "mode" && (
        <div className="grid gap-4">
          {(series[0].stats?.m.modes ?? []).map((mo) => (
            <div key={mo.mode}>
              <div className="section-label mb-1.5">
                {mo.mode === "search" ? "Search-enabled" : "Instinct"}
                {mo.searchRate !== null && mo.mode === "search"
                  ? ` · searched on ${pct(mo.searchRate)} of answers`
                  : ""}
              </div>
              <SeriesBars rows={series.map((s) => {
                const row = s.stats?.m.modes?.find((x) => x.mode === mo.mode);
                return {
                  label: s.name, color: s.color, value: row?.namedRate ?? null,
                  right: row
                    ? `${pct(row.namedRate)} · CI ${pct(row.ciLow)}–${pct(row.ciHigh)} · picks ${pct(row.pickRate)}`
                    : "—",
                };
              })} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------------- Choice ---------------- */
function Choice({ series, pooled, st }: { series: Series; pooled: RunMetrics; st: WbState }) {
  const strip = (o: { pick: number; no_pick: number; clarification: number }, label?: string) => {
    const total = o.pick + o.no_pick + o.clarification || 1;
    return (
      <div key={label ?? "run"}>
        {label && <div className="section-label mb-1">{label}</div>}
        <div className="flex h-5 overflow-hidden rounded-md">
          <div style={{ width: `${(o.pick / total) * 100}%` }} className="bg-primary" title={`committed to a pick: ${o.pick}`} />
          <div style={{ width: `${(o.no_pick / total) * 100}%` }} className="bg-neutral-bar" title={`explained without picking: ${o.no_pick}`} />
          <div style={{ width: `${(o.clarification / total) * 100}%` }} className="bg-warning/60" title={`asked a question: ${o.clarification}`} />
        </div>
        <div className="text-[12px] text-ink-3 mt-1">
          {o.pick} committed · {o.no_pick} explained without picking · {o.clarification} asked a question
        </div>
      </div>
    );
  };
  const colorOf = (brand: string) =>
    series.find((s) => s.name === brand)?.color ?? null;
  const top = (pooled.topPicks ?? []).slice(0, 8);
  const maxShare = top[0]?.shareOfDecided ?? 1;
  return (
    <>
      {pooled.outcomes && st.split !== "engine" && (
        <div className="rounded-xl border border-line p-4">
          <div className="section-label mb-2">
            Decisiveness — the leaderboard below shares out the committed segment
          </div>
          {strip(pooled.outcomes)}
        </div>
      )}
      {st.split === "engine" && pooled.engines && (
        <div className="rounded-xl border border-line p-4 grid gap-3">
          <div className="section-label">Decisiveness by engine — who commits, who hedges</div>
          {pooled.engines.map((e) => strip(e.outcomes, e.model))}
        </div>
      )}
      {top.length > 0 && (
        <div>
          <div className="section-label mb-2">Share of decided answers</div>
          <div className="grid gap-1.5">
            {top.map((t) => {
              const c = colorOf(t.brand);
              return (
                <div key={t.brand} className="grid grid-cols-[10rem_1fr_9rem] items-center gap-3">
                  <span className="truncate text-sm text-right font-medium"
                    style={{ color: c ?? "var(--color-ink-2, inherit)" }}>
                    {t.brand}
                  </span>
                  <Bar w={t.shareOfDecided / maxShare} color={c ?? "var(--color-neutral-bar, #c3ced4)"} />
                  <span className="text-[13px] tabular-nums text-ink-2">
                    {t.picks} picks · {pct(t.shareOfDecided)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {series.map((s) =>
          s.stats ? (
            <div key={s.name} className="rounded-xl border border-line p-4">
              <div className="text-sm font-semibold mb-1.5" style={{ color: s.color }}>
                {s.name}
              </div>
              {[
                ["Named", s.stats.named],
                ["Top-3", s.stats.top3],
                ["Chosen", s.stats.chosen],
              ].map(([l, v]) => (
                <div key={l as string} className="flex justify-between text-sm py-0.5">
                  <span className="text-ink-2">{l}</span>
                  <span className="font-semibold tabular-nums">
                    {v !== null ? pct(v as number) : "—"}
                  </span>
                </div>
              ))}
            </div>
          ) : null
        )}
      </div>
    </>
  );
}

/* ---------------- Why ---------------- */
function Why({ series }: { series: Series }) {
  const [sort, setSort] = useState<"lift" | "killshot">("lift");
  const [open, setOpen] = useState<string | null>(null);
  const first = series[0]?.stats?.m.reasonLift ?? [];
  const liftOf = (s: Series[number], code: string) =>
    s.stats?.m.reasonLift?.find((r) => r.code === code) ?? null;
  const codes = [...first]
    .sort((a, b) =>
      sort === "lift" ? b.lift - a.lift : b.shareAbsent - a.shareAbsent
    )
    .map((r) => r.code);
  if (codes.length === 0)
    return <p className="text-sm text-ink-3">No argument coding in this run.</p>;
  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Sort</span>
        {(
          [
            ["lift", `${series[0].name}'s biggest lifts`],
            ["killshot", "biggest kill-shots"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setSort(id)}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${
              sort === id
                ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                : "border-line text-ink-3 hover:border-ink-3"
            }`}>
            {label}
          </button>
        ))}
        <span className="text-[11px] text-ink-3">
          kill-shot = travels with answers where {series[0].name} is absent
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
              <th className="py-2 pr-4 font-semibold">Argument · lift in each brand&apos;s wins</th>
              {series.map((s) => (
                <th key={s.name} className="py-2 pr-3 font-semibold text-right" style={{ color: s.color }}>
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {codes.map((code) => (
              <>
                <tr key={code} className="border-b border-line/60 cursor-pointer hover:bg-primary-soft/20"
                  onClick={() => setOpen(open === code ? null : code)}>
                  <td className="py-2 pr-4 font-medium">
                    {open === code ? "▾ " : "▸ "}{code}
                  </td>
                  {series.map((s) => {
                    const r = liftOf(s, code);
                    return (
                      <td key={s.name}
                        className={`py-2 pr-3 text-right tabular-nums font-semibold ${
                          !r ? "text-ink-3" : r.lift > 0.02 ? "text-success" : r.lift < -0.02 ? "text-danger" : "text-ink-2"
                        }`}>
                        {r ? `${r.lift >= 0 ? "+" : ""}${(r.lift * 100).toFixed(0)}` : "—"}
                      </td>
                    );
                  })}
                </tr>
                {open === code && (
                  <tr key={`${code}-detail`} className="border-b border-line/60 bg-primary-soft/10">
                    <td className="py-2 pr-4 text-[12px] text-ink-3">
                      share of answers using it: in wins / overall / when absent
                    </td>
                    {series.map((s) => {
                      const r = liftOf(s, code);
                      return (
                        <td key={s.name} className="py-2 pr-3 text-right tabular-nums text-[12px] text-ink-2">
                          {r ? `${pct(r.shareWins)} / ${pct(r.shareAll)} / ${pct(r.shareAbsent)}` : "—"}
                        </td>
                      );
                    })}
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------- Battleground ---------------- */
function Battleground({ series, pooled }: { series: Series; pooled: RunMetrics }) {
  const [group, setGroup] = useState<"contested" | "theme">("contested");
  const base = pooled.promptGrid ?? [];
  if (base.length === 0)
    return <p className="text-sm text-ink-3">No prompt coding in this run.</p>;
  const badgeFor = (s: Series[number], promptId: string) =>
    s.stats?.m.promptGrid?.find((g) => g.promptId === promptId)?.badge ?? null;
  const dot = (b: string | null) => (
    <span className="inline-block h-2.5 w-2.5 rounded-full"
      style={{
        background: b === "win" ? "var(--color-success, #2e7d4f)"
          : b === "contested" ? "var(--color-warning, #b3822a)"
          : "var(--color-line, #d8dfe2)",
      }}
      title={b ?? "—"} />
  );
  const contestScore = (promptId: string) =>
    series.filter((s) => badgeFor(s, promptId) === "contested").length * 2 +
    series.filter((s) => badgeFor(s, promptId) === "win").length;
  const rows =
    group === "contested"
      ? [...base].sort((a, b) => contestScore(b.promptId) - contestScore(a.promptId))
      : base;
  const themes = group === "theme" ? [...new Set(base.map((g) => g.theme))] : [null];
  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Group</span>
        {(
          [
            ["contested", "most contested first"],
            ["theme", "by topic"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setGroup(id)}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${
              group === id
                ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                : "border-line text-ink-3 hover:border-ink-3"
            }`}>
            {label}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
              <th className="py-2 pr-4 font-semibold">Prompt</th>
              {series.map((s) => (
                <th key={s.name} className="py-2 pr-3 font-semibold text-center" style={{ color: s.color }}>
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {themes.map((theme) => (
              <>
                {theme && (
                  <tr key={`t-${theme}`} className="bg-primary-soft/20">
                    <td className="py-1.5 pr-4 text-[11px] font-semibold uppercase tracking-wide text-primary">
                      {theme.replace("_", " ")}
                    </td>
                    {series.map((s) => {
                      const th = s.stats?.m.themes.find((x) => x.theme === theme);
                      return (
                        <td key={s.name} className="py-1.5 pr-3 text-center text-[11px] tabular-nums text-ink-2">
                          {th ? pct(th.targetRate) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                )}
                {rows
                  .filter((g) => !theme || g.theme === theme)
                  .map((g) => (
                    <tr key={g.promptId} className="border-b border-line/60">
                      <td className="py-2 pr-4 text-ink-2 max-w-[26rem]">
                        <span className="line-clamp-2">{g.text}</span>
                      </td>
                      {series.map((s) => (
                        <td key={s.name} className="py-2 pr-3 text-center">
                          {dot(badgeFor(s, g.promptId))}
                        </td>
                      ))}
                    </tr>
                  ))}
              </>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-4 text-[12px] text-ink-3">
        <span>{dot("win")} wins it</span>
        <span>{dot("contested")} contested</span>
        <span>{dot(null)} absent from picks</span>
        {group === "theme" && <span>topic rows: named rate at topic grain</span>}
      </div>
    </>
  );
}

/* ---------------- Sources ---------------- */
function Sources({ pooled }: { pooled: RunMetrics }) {
  const searchMode = pooled.modes?.find((m) => m.mode === "search");
  if (!pooled.sources || pooled.sources.domains.length === 0)
    return (
      <p className="text-sm text-ink-3">
        No grounded answers in this run — add search-enabled engines to the
        panel and the source landscape appears here: which sites write the
        AI&apos;s script, and how much of it you own.
      </p>
    );
  const src = pooled.sources;
  const max = src.domains[0].share || 1;
  return (
    <>
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        {[
          [String(src.citedAnswers), "answers with citations"],
          [searchMode?.searchRate !== null && searchMode?.searchRate !== undefined ? pct(searchMode.searchRate) : "—", "search rate"],
          [String(src.domains.length), "distinct domains"],
        ].map(([v, l]) => (
          <div key={l}>
            <div className="text-2xl font-semibold tabular-nums">{v}</div>
            <div className="text-[11px] text-ink-3">{l}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-2.5">
        {src.domains.slice(0, 12).map((d) => (
          <div key={d.domain} className="grid grid-cols-[12rem_1fr_14rem] items-center gap-3">
            <span className={`truncate text-sm text-right ${d.brand ? "font-semibold text-primary" : "text-ink-2"}`}
              title={d.brand ? `Owned/operated by ${d.brand}` : undefined}>
              {d.domain}{d.brand ? " ●" : ""}
            </span>
            <Bar w={d.share / max} color={d.brand ? "var(--color-primary)" : "var(--color-neutral-bar, #c3ced4)"} />
            <span className="text-[12px] tabular-nums text-ink-2">
              {d.answers} answers
              {d.topBrands.length > 0 && (
                <span className="text-ink-3"> · {d.topBrands.map((b) => b.brand).join(", ")}</span>
              )}
            </span>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-3">
        ● = brand-owned domain. The brand names on each row are who appears in
        that domain&apos;s citing answers — earned coverage in action.
      </p>
    </>
  );
}

/* ---------------- Risk ---------------- */
function Risk({ series, pooled, project }: { series: Series; pooled: RunMetrics; project: Project }) {
  return (
    <>
      <div className="grid gap-1.5">
        {series.map((s) =>
          s.stats ? (
            <div key={s.name} className="flex items-baseline gap-3 text-sm">
              <span className="w-40 truncate text-right font-medium" style={{ color: s.color }}>
                {s.name}
              </span>
              <span className={`font-semibold tabular-nums ${s.stats.framing.negative > 0 ? "text-danger" : "text-ink-2"}`}>
                {s.stats.framing.negative}
              </span>
              <span className="text-ink-3 text-[13px]">
                negative framings · {s.stats.framing.recommended} recommended
              </span>
            </div>
          ) : null
        )}
      </div>
      {pooled.negatives && pooled.negatives.length > 0 && (
        <div>
          <div className="section-label mb-2">
            Verbatims — coded for {project.brand}
          </div>
          <div className="grid gap-3">
            {pooled.negatives.slice(0, 8).map((n, i) => (
              <div key={i} className="border-l-2 border-danger/50 pl-4">
                <p className="text-[13px] text-ink-3 mb-1">“{n.promptText}”</p>
                {n.quote && <p className="text-sm text-ink-2 italic">“{n.quote}”</p>}
                {n.interpretation && (
                  <p className="text-[13px] text-ink-3 mt-1">{n.interpretation}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- Style ---------------- */
function Style({ pooled }: { pooled: RunMetrics }) {
  if (!pooled.engines || pooled.engines.length === 0)
    return <p className="text-sm text-ink-3">No per-engine data in this run.</p>;
  return (
    <>
      <p className="text-[13px] text-ink-3 -mb-1">
        How each engine answers — length, decisiveness, and what it volunteers.
        These are traits of the instrument, identical for every brand.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
              <th className="py-2 pr-4 font-semibold">Engine</th>
              <th className="py-2 pr-4 font-semibold text-right">Avg words</th>
              <th className="py-2 pr-4 font-semibold text-right">Recommends</th>
              <th className="py-2 pr-4 font-semibold text-right">Quotes prices</th>
              <th className="py-2 pr-4 font-semibold text-right">Quotes specs</th>
              <th className="py-2 pr-4 font-semibold text-right">Asks back</th>
              <th className="py-2 font-semibold text-right">Options offered</th>
            </tr>
          </thead>
          <tbody>
            {pooled.engines.map((e) => (
              <tr key={e.model} className="border-b border-line/60">
                <td className="py-2 pr-4 font-medium">
                  {e.model}
                  {e.mode === "search" && (
                    <span className="ml-1.5 rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                      search
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{e.style.avgWords}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{pct(e.style.recRate)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{pct(e.style.priceRate)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{pct(e.style.specRate)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{pct(e.style.clarRate)}</td>
                <td className="py-2 text-right tabular-nums">{e.style.avgOptions.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-ink-3">
        &quot;Asks back&quot; counts answers that pose any question to the user;
        &quot;options offered&quot; is the average number of distinct
        recommendations per answer.
      </p>
    </>
  );
}
