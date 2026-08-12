"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, RunMetrics } from "@/lib/types";

/** Percent for display. A non-zero value that rounds to 0 reads "<1%" —
 * "0%" is reserved for a true zero, so absence and rarity never look alike. */
const pct = (x: number) => {
  if (x > 0 && x < 0.005) return "<1%";
  return `${Math.round(x * 100)}%`;
};

/** Series colors: the client is always the primary blue; rivals take the
 * fixed order after it — color follows the entity, never its rank. */
const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
];

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

export type WbPreset = Partial<WbState>;

interface WbState {
  brandMode: "solo" | "comparative";
  soloBrand: string;
  compBrands: string[];
  grain: "brands" | "parents";
  split: "none" | "engine" | "mode";
  /** Engine scope; empty = every engine in the run. */
  engines: string[];
  measure: "named" | "firstNamed" | "sov" | "position";
  /** Table-only disclosures — charts never carry them. */
  showCI: boolean;
  showCounts: boolean;
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
  plan,
  view: rawView,
  setView,
  refreshToken,
  preset,
}: {
  runId: string;
  pooled: RunMetrics;
  project: Project;
  plan: "free" | "pro" | "enterprise";
  view: string;
  setView: (v: string) => void;
  refreshToken: number;
  /** Citation deep-link: applies this exact state when nonce changes. */
  preset?: { nonce: number; state: WbPreset } | null;
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
    engines: [],
    measure: "named",
    showCI: false,
    showCounts: false,
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
  useEffect(() => {
    if (preset) setSt((prev) => ({ ...prev, ...preset.state }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.nonce]);

  const runEngines = useMemo(
    () => (pooled.engines ?? []).map((e) => ({ id: e.model, mode: e.mode })),
    [pooled]
  );
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
    if (list.length > 0) return list;
    if (st.grain === "parents") {
      const top5 = parentNames.slice(0, 5);
      return top5.includes(clientParent) ? top5 : [clientParent, ...top5.slice(0, 4)];
    }
    return defaultComp;
  }, [st, options, defaultComp, clientName, clientParent, parentNames, view]);

  // ---- slice fetching: one batched request per change, cached ----
  const [slices, setSlices] = useState<Record<string, RunMetrics>>({});
  const inFlight = useRef<Set<string>>(new Set());
  useEffect(() => {
    setSlices({});
    inFlight.current.clear();
  }, [runId, refreshToken]);
  const scopedEngines = useMemo(
    () =>
      st.engines.length > 0 ? st.engines : runEngines.map((e) => e.id),
    [st.engines, runEngines]
  );
  const keyFor = (name: string, engines: string[]) =>
    `${engines.slice().sort().join(",")}|${st.grain}|${name}`;
  const focusFor = (name: string) =>
    st.grain === "parents" ? `parent:${name}` : name;

  // Break-out facets: each facet is just a narrower engine scope, so every
  // view can break out — the facet's slice carries the whole metrics shape.
  const facetDefs = useMemo(() => {
    if (view === "style" || st.split === "none") return null;
    if (st.split === "engine") {
      return scopedEngines.map((id) => ({ key: id, label: id, engines: [id] }));
    }
    const byMode = (m: "instinct" | "search") =>
      runEngines
        .filter((e) => e.mode === m && scopedEngines.includes(e.id))
        .map((e) => e.id);
    return (
      [
        { key: "instinct", label: "Instinct", engines: byMode("instinct") },
        { key: "search", label: "Search-enabled", engines: byMode("search") },
      ] as const
    ).filter((f) => f.engines.length > 0);
  }, [view, st.split, scopedEngines, runEngines]);

  useEffect(() => {
    const scopes: string[][] = facetDefs
      ? facetDefs.map((f) => f.engines)
      : [st.engines];
    const missing: { key: string; focus: string; engines?: string[] }[] = [];
    for (const name of selected) {
      for (const engines of scopes) {
        const key = keyFor(name, engines);
        if (slices[key] || inFlight.current.has(key)) continue;
        if (
          st.grain === "brands" &&
          name === project.brand &&
          engines.length === 0
        ) {
          setSlices((prev) => ({ ...prev, [key]: pooled }));
          continue;
        }
        missing.push({
          key,
          focus: focusFor(name),
          engines: engines.length > 0 ? engines : undefined,
        });
      }
    }
    if (missing.length === 0) return;
    for (const m of missing) inFlight.current.add(m.key);
    fetch(`/api/runs/${runId}/slices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: missing }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // Slice keys are content-addressed, so merging a late response is
        // always safe — no cancellation, or in-flight dedupe would deadlock
        // with the effect re-running as earlier slices land.
        if (d?.slices) setSlices((prev) => ({ ...prev, ...d.slices }));
      })
      .catch(() => {})
      .finally(() => {
        for (const m of missing) inFlight.current.delete(m.key);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, facetDefs, st.engines, st.grain, runId, refreshToken, pooled, slices]);

  const colorOf = (name: string) =>
    name === clientName
      ? SERIES[0]
      : SERIES[1 + (selected.indexOf(name) % (SERIES.length - 1))];
  const seriesFor = (engines: string[]): Series =>
    selected.map((name) => ({
      name,
      isClient: name === clientName,
      color: colorOf(name),
      stats: brandStats(slices[keyFor(name, engines)] ?? null),
    }));
  // One group per facet — or a single unlabeled group when not broken out.
  // g.m carries the group's brand-independent metrics (outcomes, topPicks,
  // sources, prompt list), identical across the group's brand slices.
  const groups: Group[] = (facetDefs ?? [{ key: "", label: null as string | null, engines: st.engines }]).map(
    (f) => {
      const sr = seriesFor(f.engines);
      const m = sr.find((x) => x.stats)?.stats?.m ?? null;
      let label = f.label;
      if (label && m) {
        const rate =
          st.split === "engine"
            ? m.engines?.[0]?.searchRate
            : m.modes?.find((x) => x.mode === "search")?.searchRate;
        if (rate !== null && rate !== undefined && (st.split !== "mode" || f.key === "search")) {
          label = `${label} · searched on ${pct(rate)} of answers`;
        }
      }
      return { label, series: sr, m };
    }
  );
  const loading =
    view !== "style" && groups.some((g) => g.series.some((x) => !x.stats));
  const solo = st.brandMode === "solo";

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
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 w-16">
            Compare
          </span>
          <button type="button" className={chip(st.brandMode === "solo")}
            onClick={() => set({ brandMode: "solo" })}>
            Solo
          </button>
          <button type="button" className={chip(st.brandMode === "comparative")}
            onClick={() => set({ brandMode: "comparative" })}>
            Multiple
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
                  style={{ borderColor: colorOf(name), color: colorOf(name) }}
                  title="Remove from comparison"
                >
                  {name} ✕
                </button>
              ))}
              <AddBrand
                options={options.filter((o) => !selected.includes(o))}
                onAdd={(b) => set({ compBrands: [...selected, b] })}
              />
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {parents && parents.length > 0 && (
            <>
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 w-16">
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
          {st.brandMode === "comparative" && (
            <select
              value=""
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!n) return;
                const top = options.filter((o) => o !== clientName).slice(0, n);
                set({ compBrands: [clientName, ...top] });
              }}
              className="input w-auto py-0.5 text-[12px]"
              title="Replace the comparison with the top brands by visibility, plus you"
            >
              <option value="">Top…</option>
              {[3, 5, 10, 15, 20].map((n) => (
                <option key={n} value={n}>
                  Top {n} + you
                </option>
              ))}
            </select>
          )}
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 w-16">
            Answers
          </span>
          <ScopeControl
            all={runEngines}
            selected={st.engines}
            split={st.split}
            onChange={(engines, split) =>
              set({
                engines,
                split,
                measure: split === "none" ? st.measure : "named",
              })
            }
          />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 ml-2">
            Show
          </span>
          <button type="button" className={chip(st.showCI)}
            onClick={() => set({ showCI: !st.showCI })}
            title="Add 95% confidence-interval columns to every table">
            CI
          </button>
          <button type="button" className={chip(st.showCounts)}
            onClick={() => set({ showCounts: !st.showCounts })}
            title="Add the counts behind the rates to every table">
            Counts
          </button>
        </div>
      </div>

      <div className="grid md:grid-cols-[11.5rem_1fr]">
        <nav className="border-b md:border-b-0 md:border-r border-line py-2 flex md:grid content-start overflow-x-auto">
          {VIEWS.map((v) => {
            const locked = v.id === "risk" && plan === "free";
            return (
            <button key={v.id} type="button" disabled={locked}
              title={locked ? "Risk analysis is a paid feature" : undefined}
              onClick={() => setView(v.id)}
              className={`px-4 py-2 text-left whitespace-nowrap ${
                locked
                  ? "text-ink-3 opacity-40 cursor-not-allowed"
                  : view === v.id
                    ? "font-semibold text-primary md:border-r-2 border-[var(--color-primary)] bg-primary-soft/40"
                    : "text-ink-2 hover:text-ink"
              }`}>
              <span className="text-sm">{v.label}</span>
              <span className="block text-[10px] text-ink-3 font-normal">
                {v.sub}
              </span>
            </button>
            );
          })}
        </nav>
        <div className="p-5 grid gap-4 content-start min-h-[24rem]">
          {loading ? (
            <p className="text-sm text-ink-3">Computing slices…</p>
          ) : (
            <>
              {view === "visibility" && (
                <Visibility groups={groups} solo={solo} st={st} set={set} />
              )}
              {view === "choice" && <Choice groups={groups} st={st} />}
              {view === "why" && <Why groups={groups} />}
              {view === "battleground" && <Battleground groups={groups} st={st} />}
              {view === "sources" && <Sources groups={groups} />}
              {view === "risk" && plan !== "free" && (
                <Risk groups={groups} pooled={pooled}
                  plan={plan} runId={runId} clientName={clientName} />
              )}
              {view === "style" && <Style pooled={pooled} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** "+ add" wears the same pill as the brands it adds to. */
function AddBrand({
  options,
  onAdd,
}: {
  options: string[];
  onAdd: (brand: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  if (options.length === 0) return null;
  const shown = options.filter((o) =>
    o.toLowerCase().includes(q.trim().toLowerCase())
  );
  return (
    <span className="relative inline-block">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="rounded-full border border-dashed border-line px-2.5 py-0.5 text-[12px] font-medium text-ink-3 hover:border-ink-3 hover:text-ink-2">
        + add
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <span className="absolute left-0 top-full z-40 mt-1 block w-56 rounded-xl border border-line bg-surface p-2 shadow-lg">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Find a brand"
              className="input mb-1 w-full py-1 text-[12px]" />
            <span className="block max-h-56 overflow-y-auto">
              {shown.map((o) => (
                <button key={o} type="button"
                  onClick={() => {
                    onAdd(o);
                    setQ("");
                    setOpen(false);
                  }}
                  className="block w-full rounded-md px-2 py-1 text-left text-[13px] text-ink-2 hover:bg-primary-soft/40 hover:text-primary">
                  {o}
                </button>
              ))}
              {shown.length === 0 && (
                <span className="block px-2 py-1 text-[12px] text-ink-3">
                  Nothing matches
                </span>
              )}
            </span>
          </span>
        </>
      )}
    </span>
  );
}

/**
 * The answer scope: which engines are in play, and whether the view pools
 * them or breaks them out. One summary line in the bar, the detail on
 * demand — so the control row stays calm as the engine panel grows.
 */
function ScopeControl({
  all,
  selected,
  split,
  onChange,
}: {
  all: { id: string; mode: "instinct" | "search" }[];
  selected: string[];
  split: "none" | "engine" | "mode";
  onChange: (engines: string[], split: "none" | "engine" | "mode") => void;
}) {
  const [open, setOpen] = useState(false);
  const live = selected.length > 0 ? selected : all.map((e) => e.id);
  const liveModes = new Set(
    all.filter((e) => live.includes(e.id)).map((e) => e.mode)
  );
  const allOn = selected.length === 0 || selected.length === all.length;
  const onlyInstinct = liveModes.size === 1 && liveModes.has("instinct");
  const onlySearch = liveModes.size === 1 && liveModes.has("search");

  const summary = `${
    allOn
      ? `all ${all.length} engines`
      : `${live.length} ${onlySearch ? "search " : onlyInstinct ? "instinct " : ""}engine${live.length === 1 ? "" : "s"}`
  } · ${split === "none" ? "combined" : split === "engine" ? "by engine" : "by instrument"}`;

  // A break-out with nothing left to break out collapses itself.
  const commit = (engines: string[], nextSplit = split) => {
    const nextLive = engines.length > 0 ? engines : all.map((e) => e.id);
    const modes = new Set(
      all.filter((e) => nextLive.includes(e.id)).map((e) => e.mode)
    );
    let resolved = nextSplit;
    if (resolved === "engine" && nextLive.length < 2) resolved = "none";
    if (resolved === "mode" && modes.size < 2) resolved = "none";
    onChange(engines, resolved);
  };
  const pick = (mode: "all" | "instinct" | "search") =>
    commit(
      mode === "all" ? [] : all.filter((e) => e.mode === mode).map((e) => e.id)
    );

  const splitOpts = [
    ["none", "Nothing"],
    ["engine", "Engine"],
    ["mode", "Instrument"],
  ] as const;

  return (
    <span className="relative inline-block">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-line px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:border-ink-3">
        {summary} <span className="text-ink-3">▾</span>
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <span className="absolute left-0 top-full z-40 mt-1 block w-72 rounded-xl border border-line bg-surface p-4 shadow-lg">
            <span className="mb-2 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              Break out by
            </span>
            <span className="mb-1 flex flex-wrap gap-1.5">
              {splitOpts.map(([id, label]) => {
                const disabled =
                  (id === "engine" && live.length < 2) ||
                  (id === "mode" && liveModes.size < 2);
                return (
                  <button key={id} type="button" disabled={disabled}
                    onClick={() => commit(selected, id)}
                    className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium disabled:opacity-40 ${
                      split === id
                        ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                        : "border-line text-ink-3 hover:border-ink-3"
                    }`}>
                    {label}
                  </button>
                );
              })}
            </span>

            <span className="mt-3 mb-2 flex items-baseline justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Include
              </span>
              <span className="flex gap-1.5">
                {(["all", "instinct", "search"] as const).map((m) => {
                  const active =
                    m === "all" ? allOn : m === "instinct" ? onlyInstinct : onlySearch;
                  if (m !== "all" && !all.some((e) => e.mode === m)) return null;
                  return (
                    <button key={m} type="button" onClick={() => pick(m)}
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                        active
                          ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                          : "border-line text-ink-3 hover:border-ink-3"
                      }`}>
                      {m === "all" ? "All" : m === "instinct" ? "Instinct" : "Search"}
                    </button>
                  );
                })}
              </span>
            </span>
            <span className="grid gap-1">
              {all.map((e) => {
                const on = live.includes(e.id);
                return (
                  <label key={e.id}
                    className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
                    <input type="checkbox" checked={on}
                      onChange={() => {
                        const next = on
                          ? live.filter((x) => x !== e.id)
                          : [...live, e.id];
                        if (next.length === 0) return;
                        commit(next.length === all.length ? [] : next);
                      }}
                      className="h-3.5 w-3.5 accent-[var(--color-primary)]" />
                    {e.id}
                    {e.mode === "search" && (
                      <span className="rounded-full bg-primary-soft px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
                        search
                      </span>
                    )}
                  </label>
                );
              })}
            </span>
          </span>
        </>
      )}
    </span>
  );
}

function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number | null)[][]
) {
  const esc = (v: string | number | null) => {
    const x = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function downloadXlsx(
  sheet: string,
  header: string[],
  rows: (string | number | null)[][]
) {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sheet, header, rows }),
  });
  if (!res.ok) return;
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sheet}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Every table's download control: the same rows, either format. */
function Download({
  name,
  header,
  rows,
}: {
  name: string;
  header: string[];
  rows: () => (string | number | null)[][];
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex justify-end gap-3">
      <button type="button"
        onClick={() => downloadCsv(`${name}.csv`, header, rows())}
        className="text-[12px] font-medium text-primary hover:opacity-80">
        ↓ csv
      </button>
      <button type="button" disabled={busy}
        onClick={async () => {
          setBusy(true);
          await downloadXlsx(name, header, rows());
          setBusy(false);
        }}
        className="text-[12px] font-medium text-primary hover:opacity-80 disabled:opacity-50">
        {busy ? "…" : "↓ excel"}
      </button>
    </div>
  );
}

/** Instant tooltip. Rendered position:fixed so it escapes overflow-x
 * scroll containers (tables) instead of being clipped at their edge. */
function Tip({ tip, children }: { tip: string; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      className="inline-block"
      onMouseEnter={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.top });
      }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && (
        <span
          style={{
            position: "fixed",
            left: Math.min(
              Math.max(pos.x, Math.min(176, window.innerWidth / 2)),
              window.innerWidth - Math.min(176, window.innerWidth / 2)
            ),
            top: pos.y - 8,
            transform: "translate(-50%, -100%)",
            zIndex: 50,
            maxWidth: Math.min(336, window.innerWidth - 16),
          }}
          className="pointer-events-none w-max rounded-lg border border-line bg-surface px-3 py-2 text-left text-[12px] font-normal normal-case tracking-normal text-ink-2 shadow-lg"
        >
          {tip}
        </span>
      )}
    </span>
  );
}

/** Header text with the sort arrow bound to its final word, so a wrapping
 * label can never drop the arrow onto a line of its own. */
function HeadLabel({ label, arrow }: { label: string; arrow: string }) {
  const words = label.split(" ");
  const last = words.pop() ?? "";
  return (
    <>
      {words.length > 0 && `${words.join(" ")} `}
      <span className="whitespace-nowrap">
        {last}
        <span className="inline-block w-2.5 text-left">{arrow}</span>
      </span>
    </>
  );
}

interface Col<T> {
  id: string;
  label: string;
  num?: boolean;
  color?: (r: T) => string | undefined;
  val: (r: T) => string | number | null;
  render?: (r: T) => React.ReactNode;
}

/** Every workbench table: sortable headers, one-click CSV. */
function SortTable<T>({
  cols,
  rows,
  filename,
  defaultSort,
  onRowClick,
  activeRow,
}: {
  cols: Col<T>[];
  rows: T[];
  filename: string;
  defaultSort?: { id: string; dir: 1 | -1 };
  onRowClick?: (r: T) => void;
  activeRow?: (r: T) => boolean;
}) {
  const [sort, setSort] = useState<{ id: string; dir: 1 | -1 }>(
    defaultSort ?? { id: cols[1]?.id ?? cols[0].id, dir: -1 }
  );
  const col = cols.find((c) => c.id === sort.id) ?? cols[0];
  const sorted = [...rows].sort((a, b) => {
    const va = col.val(a);
    const vb = col.val(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
    return sort.dir === 1 ? cmp : -cmp;
  });
  return (
    <div className="mt-3 grid gap-1">
      <Download
        name={filename.replace(/\.csv$/, "")}
        header={cols.map((c) => c.label)}
        rows={() => rows.map((r) => cols.map((c) => c.val(r)))}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
              {cols.map((c, i) => (
                <th
                  key={c.id}
                  onClick={() =>
                    setSort((prev) =>
                      prev.id === c.id
                        ? { id: c.id, dir: prev.dir === 1 ? -1 : 1 }
                        : { id: c.id, dir: -1 }
                    )
                  }
                  className={`py-2 ${i === cols.length - 1 ? "" : "pr-4"} font-semibold cursor-pointer select-none hover:opacity-70 ${c.num ? "text-center" : ""}`}
                >
                  {/* The arrow always occupies its slot, so sorting a
                      different column never re-measures the header. */}
                  <HeadLabel
                    label={c.label}
                    arrow={sort.id === c.id ? (sort.dir === -1 ? "↓" : "↑") : ""}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, ri) => (
              <tr key={ri}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={`border-b border-line/60 ${onRowClick ? "cursor-pointer hover:bg-primary-soft/20" : ""} ${activeRow?.(r) ? "bg-primary-soft/25" : ""}`}>
                {cols.map((c, i) => (
                  <td
                    key={c.id}
                    className={`py-2 ${i === cols.length - 1 ? "" : "pr-4"} ${c.num ? "text-center tabular-nums" : ""}`}
                    style={c.color ? { color: c.color(r) } : undefined}
                  >
                    {c.render ? c.render(r) : c.val(r) ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Group {
  label: string | null;
  series: Series;
  m: RunMetrics | null;
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
const slugify = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "_");

function GroupLabel({ label }: { label: string | null }) {
  if (!label) return null;
  return <div className="section-label -mb-1">{label}</div>;
}

/* ---------------- Visibility ---------------- */
function Visibility({
  groups, solo, st, set,
}: {
  groups: Group[];
  solo: boolean;
  st: WbState;
  set: (p: Partial<WbState>) => void;
}) {
  const measures = [
    ["named", "Named rate"],
    ["firstNamed", "First-named"],
    ["sov", "Share of voice"],
    ["position", "Avg position"],
  ] as const;
  const valOf = (x: Series[number]): number | null =>
    !x.stats ? null
    : st.measure === "named" ? x.stats.named
    : st.measure === "firstNamed" ? x.stats.firstNamed
    : st.measure === "sov" ? x.stats.sov
    : x.stats.avgRank;
  const fmt = (v: number | null) =>
    v === null ? "—" : st.measure === "position" ? `#${v.toFixed(1)}` : pct(v);

  return (
    <>
      {!solo && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Chart
          </span>
          {measures.map(([id, label]) => (
            <button key={id} type="button" onClick={() => set({ measure: id })}
              className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${
                st.measure === id
                  ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                  : "border-line text-ink-3 hover:border-ink-3"
              }`}>
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-8">
        {groups.map((g) => {
          const sr = g.series;
          if (solo) {
            const one = sr[0];
            if (!one?.stats) return null;
            return (
              <div key={g.label ?? "all"} className="grid gap-4">
                <GroupLabel label={g.label} />
                <SoloVisibility s={one} />
              </div>
            );
          }
          const chartRows = sr.map((x) => ({
            label: x.name, color: x.color, raw: valOf(x), right: fmt(valOf(x)),
          }));
          const best =
            st.measure === "position"
              ? Math.min(...chartRows.map((r) => r.raw ?? Infinity))
              : null;
          return (
            <div key={g.label ?? "all"} className="grid gap-4">
              <GroupLabel label={g.label} />
              <SeriesBars rows={chartRows.map((r) => ({
                label: r.label,
                color: r.color,
                value:
                  st.measure === "position"
                    ? r.raw !== null && best !== null ? best / r.raw : null
                    : r.raw,
                right: r.right,
              }))} />
              <SortTable
                filename={`visibility${g.label ? `_${slugify(g.label)}` : ""}.csv`}
                defaultSort={{ id: "named", dir: -1 }}
                cols={[
                  { id: "brand", label: "Brand", val: (r: Series[number]) => r.name,
                    color: (r) => r.color,
                    render: (r) => <span className="font-medium">{r.name}</span> },
                  ...(st.showCounts
                    ? [{ id: "answers", label: "Answers", num: true,
                        val: (r: Series[number]) =>
                          r.stats?.m.unbrandedResponses ?? null }]
                    : []),
                  { id: "named", label: "Named", num: true,
                    val: (r) => r.stats ? Math.round(r.stats.named * 100) : null,
                    render: (r) => (r.stats ? pct(r.stats.named) : "—") },
                  ...(st.showCounts
                    ? [{ id: "namedn", label: "Named n", num: true,
                        val: (r: Series[number]) => r.stats?.count ?? null }]
                    : []),
                  ...(st.showCI
                    ? [{ id: "ci", label: "Named 95% CI", num: true,
                        val: (r: Series[number]) =>
                          r.stats ? Math.round(r.stats.ciLow * 100) : null,
                        render: (r: Series[number]) =>
                          r.stats ? `${pct(r.stats.ciLow)}–${pct(r.stats.ciHigh)}` : "—" }]
                    : []),
                  { id: "fn", label: "First-named", num: true,
                    val: (r) =>
                      r.stats?.firstNamed !== null && r.stats
                        ? Math.round((r.stats.firstNamed ?? 0) * 100) : null,
                    render: (r) =>
                      r.stats?.firstNamed !== null && r.stats ? pct(r.stats.firstNamed!) : "—" },
                  { id: "sov", label: "Share of voice", num: true,
                    val: (r) => r.stats ? Math.round(r.stats.sov * 100) : null,
                    render: (r) => (r.stats ? pct(r.stats.sov) : "—") },
                  { id: "pos", label: "Avg position", num: true,
                    val: (r) => r.stats?.avgRank ?? null,
                    render: (r) =>
                      r.stats?.avgRank ? `#${r.stats.avgRank.toFixed(1)}` : "—" },
                  { id: "rec", label: "Recommended", num: true,
                    val: (r) =>
                      r.stats && r.stats.count > 0
                        ? Math.round((r.stats.framing.recommended / r.stats.count) * 100)
                        : null,
                    render: (r) =>
                      r.stats && r.stats.count > 0
                        ? pct(r.stats.framing.recommended / r.stats.count) : "—" },
                  { id: "neg", label: "Negative", num: true,
                    val: (r) =>
                      r.stats && r.stats.count > 0
                        ? Math.round((r.stats.framing.negative / r.stats.count) * 100)
                        : null,
                    render: (r) =>
                      r.stats && r.stats.count > 0 ? (
                        <span className={r.stats.framing.negative > 0 ? "text-danger" : ""}>
                          {pct(r.stats.framing.negative / r.stats.count)}
                        </span>
                      ) : ("—") },
                ]}
                rows={sr}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

function SoloVisibility({ s }: { s: Series[number] }) {
  const st = s.stats!;
  return (
    <>
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        {[
          [pct(st.named), "named"],
          [st.firstNamed !== null ? pct(st.firstNamed) : "—", "first-named"],
          [pct(st.sov), "share of voice"],
          [st.avgRank ? `#${st.avgRank.toFixed(1)}` : "—", "avg position"],
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
            ["Named", st.named],
            ["Top-3", st.top3],
            ["Chosen", st.chosen],
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
          <div className="section-label mb-2">Position when named</div>
          {st.m.positionDist ? (
            (
              [
                ["#1", st.m.positionDist.r1],
                ["#2", st.m.positionDist.r2],
                ["#3", st.m.positionDist.r3],
                ["4th+", st.m.positionDist.r4plus],
              ] as const
            ).map(([l, v]) => (
              <div key={l} className="flex justify-between text-sm py-0.5">
                <span className="text-ink-2">{l}</span>
                <span className="font-semibold tabular-nums">{v}×</span>
              </div>
            ))
          ) : (
            <p className="text-sm text-ink-3">Not coded in this run.</p>
          )}
        </div>
        <div className="rounded-xl border border-line p-4">
          <div className="section-label mb-2">Framing · % of named answers</div>
          {(["recommended", "mentioned", "negative"] as const).map((f) => (
            <div key={f} className="flex justify-between text-sm py-0.5">
              <span className="text-ink-2">{f === "mentioned" ? "neutral" : f}</span>
              <span className={`font-semibold tabular-nums ${f === "negative" && st.framing[f] > 0 ? "text-danger" : ""}`}>
                {st.count > 0 ? pct(st.framing[f] / st.count) : "—"}
              </span>
            </div>
          ))}
        </div>
      </div>
      {st.m.engines && st.m.engines.length > 1 && (
        <div>
          <div className="section-label mb-2">Named rate by engine</div>
          <SeriesBars rows={st.m.engines.map((e) => ({
            label: e.model, color: s.color, value: e.namedRate,
            right: pct(e.namedRate),
          }))} />
        </div>
      )}
    </>
  );
}

/* ---------------- Choice ---------------- */
function Choice({ groups, st }: { groups: Group[]; st: WbState }) {
  const [metric, setMetric] = useState<"share" | "chosen" | "top3" | "named">("share");
  const metricDefs = [
    ["share", "Share of decided"],
    ["chosen", "Chosen rate"],
    ["top3", "Top-3 rate"],
    ["named", "Named rate"],
  ] as const;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Chart
        </span>
        {metricDefs.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setMetric(id)}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${
              metric === id
                ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                : "border-line text-ink-3 hover:border-ink-3"
            }`}>
            {label}
          </button>
        ))}
      </div>
      <div className="grid gap-8">
        {groups.map((g) => (
          <ChoiceGroup key={g.label ?? "all"} g={g} metric={metric}
            showCI={st.showCI} showCounts={st.showCounts} />
        ))}
      </div>
    </>
  );
}

function ChoiceGroup({
  g,
  metric,
  showCI,
  showCounts,
}: {
  g: Group;
  metric: "share" | "chosen" | "top3" | "named";
  showCI: boolean;
  showCounts: boolean;
}) {
  const m = g.m;
  if (!m) return null;
  const tp = (name: string) => m.topPicks?.find((t) => t.brand === name);
  const valFor = (x: Series[number]) => {
    if (!x.stats) return null;
    if (metric === "share") return tp(x.name)?.shareOfDecided ?? 0;
    return metric === "chosen" ? x.stats.chosen : metric === "top3" ? x.stats.top3 : x.stats.named;
  };
  const rows = [...g.series].sort((a, b) => (valFor(b) ?? 0) - (valFor(a) ?? 0));
  const unselected =
    metric === "share"
      ? (m.topPicks ?? [])
          .filter((t) => !g.series.some((x) => x.name === t.brand))
          .slice(0, Math.max(0, 8 - g.series.length))
      : [];
  const maxV = Math.max(
    ...rows.map((x) => valFor(x) ?? 0),
    ...unselected.map((t) => t.shareOfDecided),
    0.01
  );
  const strip = (o: { pick: number; no_pick: number; clarification: number }) => {
    const total = o.pick + o.no_pick + o.clarification || 1;
    return (
      <div className="rounded-xl border border-line p-4">
        <div className="section-label mb-2">
          Decisiveness — committed = the answer crowned ONE product as its pick
        </div>
        <Tip tip={`${pct(o.no_pick / total)} explained the options without crowning one · ${pct(o.clarification / total)} asked the user a question instead of answering`}>
          <div className="flex items-baseline gap-2 cursor-help">
            <span className="text-xl font-semibold tabular-nums">{pct(o.pick / total)}</span>
            <span className="text-[12px] text-ink-3">
              of answers committed to a pick
            </span>
          </div>
        </Tip>
        <div className="flex h-4 overflow-hidden rounded-md mt-1">
          <div style={{ width: `${(o.pick / total) * 100}%` }} className="bg-primary" />
          <div style={{ width: `${(o.no_pick / total) * 100}%` }} className="bg-neutral-bar" />
          <div style={{ width: `${(o.clarification / total) * 100}%` }} className="bg-warning/60" />
        </div>
      </div>
    );
  };
  return (
    <div className="grid gap-4">
      <GroupLabel label={g.label} />
      {m.outcomes && strip(m.outcomes)}
      <div className="grid gap-1.5">
        {rows.map((x) => {
          const v = valFor(x);
          return (
            <div key={x.name} className="grid grid-cols-[10rem_1fr_9rem] items-center gap-3">
              <span className="truncate text-sm text-right font-medium" style={{ color: x.color }}>
                {x.name}
              </span>
              <Bar w={(v ?? 0) / maxV} color={x.color} />
              <span className="text-[13px] tabular-nums text-ink-2">
                {v !== null ? pct(v) : "—"}
              </span>
            </div>
          );
        })}
        {unselected.map((t) => (
          <div key={t.brand} className="grid grid-cols-[10rem_1fr_9rem] items-center gap-3">
            <span className="truncate text-sm text-right text-ink-3">{t.brand}</span>
            <Bar w={t.shareOfDecided / maxV} color="var(--color-neutral-bar, #c3ced4)" />
            <span className="text-[13px] tabular-nums text-ink-3">
              {t.picks} picks · {pct(t.shareOfDecided)}
            </span>
          </div>
        ))}
      </div>
      <SortTable
        filename={`choice${g.label ? `_${slugify(g.label)}` : ""}.csv`}
        defaultSort={{ id: "share", dir: -1 }}
        cols={[
          { id: "brand", label: "Brand", val: (r: Series[number]) => r.name,
            color: (r) => r.color,
            render: (r) => <span className="font-medium">{r.name}</span> },
          { id: "named", label: "Named", num: true,
            val: (r) => (r.stats ? Math.round(r.stats.named * 100) : null),
            render: (r) => (r.stats ? pct(r.stats.named) : "—") },
          { id: "top3", label: "Top-3", num: true,
            val: (r) =>
              r.stats?.top3 !== null && r.stats ? Math.round((r.stats.top3 ?? 0) * 100) : null,
            render: (r) =>
              r.stats?.top3 !== null && r.stats ? pct(r.stats.top3!) : "—" },
          { id: "chosen", label: "Chosen", num: true,
            val: (r) =>
              r.stats?.chosen !== null && r.stats ? Math.round((r.stats.chosen ?? 0) * 100) : null,
            render: (r) =>
              r.stats?.chosen !== null && r.stats ? pct(r.stats.chosen!) : "—" },
          ...(showCI
            ? [{ id: "chosenci", label: "Chosen 95% CI", num: true,
                val: (r: Series[number]) =>
                  r.stats?.m.firstPick
                    ? Math.round(r.stats.m.firstPick.ciLow * 100) : null,
                render: (r: Series[number]) =>
                  r.stats?.m.firstPick
                    ? `${pct(r.stats.m.firstPick.ciLow)}–${pct(r.stats.m.firstPick.ciHigh)}`
                    : "—" }]
            : []),
          ...(showCounts
            ? [
                { id: "coded", label: "Answers", num: true,
                  val: (r: Series[number]) => r.stats?.m.firstPick?.of ?? null },
                { id: "chosenn", label: "Chosen n", num: true,
                  val: (r: Series[number]) => r.stats?.m.firstPick?.count ?? null },
              ]
            : []),
          { id: "picks", label: "Picks", num: true,
            val: (r) => tp(r.name)?.picks ?? 0 },
          { id: "share", label: "Share of decided", num: true,
            val: (r) => Math.round((tp(r.name)?.shareOfDecided ?? 0) * 100),
            render: (r) => pct(tp(r.name)?.shareOfDecided ?? 0) },
        ]}
        rows={g.series}
      />
    </div>
  );
}

/* ---------------- Why ---------------- */
function Why({ groups }: { groups: Group[] }) {
  const [metric, setMetric] = useState<"lift" | "wins" | "all" | "absent">("lift");
  const [sortBy, setSortBy] = useState<{ name: string; dir: 1 | -1 } | null>(null);
  const metricDefs = [
    ["lift", "Lift", "How much more often the argument shows up in answers the brand wins than in answers overall. Positive = it travels with their wins."],
    ["wins", "In their wins", "Of the answers that crown the brand, the share that use this argument — their winning story."],
    ["all", "Overall", "The share of all answers that use this argument, whoever wins — the category's background conversation."],
    ["absent", "Where they're missing", "Of the answers that never mention the brand, the share using this argument — the talking points of conversations they're excluded from."],
  ] as const;
  const activeDef = metricDefs.find(([id]) => id === metric)!;
  return (
    <>
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Metric
          </span>
          {metricDefs.map(([id, label, tip]) => (
            <Tip key={id} tip={tip}>
              <button type="button" onClick={() => setMetric(id)}
                className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${
                  metric === id
                    ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                    : "border-line text-ink-3 hover:border-ink-3"
                }`}>
                {label}
              </button>
            </Tip>
          ))}
        </div>
        <p className="text-[12px] text-ink-3">{activeDef[2]}</p>
      </div>
      <div className="grid gap-8">
        {groups.map((g) => (
          <WhyGroup key={g.label ?? "all"} g={g} metric={metric}
            sortBy={sortBy} setSortBy={setSortBy} />
        ))}
      </div>
    </>
  );
}

function WhyGroup({
  g, metric, sortBy, setSortBy,
}: {
  g: Group;
  metric: "lift" | "wins" | "all" | "absent";
  sortBy: { name: string; dir: 1 | -1 } | null;
  setSortBy: (v: { name: string; dir: 1 | -1 } | null) => void;
}) {
  const series = g.series;
  const first = series[0]?.stats?.m.reasonLift ?? [];
  const liftOf = (x: Series[number], code: string) =>
    x.stats?.m.reasonLift?.find((r) => r.code === code) ?? null;
  const cell = (x: Series[number], code: string): number | null => {
    const r = liftOf(x, code);
    if (!r) return null;
    return metric === "lift" ? r.lift : metric === "wins" ? r.shareWins
      : metric === "all" ? r.shareAll : r.shareAbsent;
  };
  const sortSeries = series.find((x) => x.name === sortBy?.name) ?? series[0];
  const codes = [...first]
    .map((r) => r.code)
    .sort((a, b) => {
      const va = cell(sortSeries, a) ?? -Infinity;
      const vb = cell(sortSeries, b) ?? -Infinity;
      return (vb - va) * (sortBy?.dir === 1 ? -1 : 1);
    });
  if (codes.length === 0)
    return (
      <div className="grid gap-2">
        <GroupLabel label={g.label} />
        <p className="text-sm text-ink-3">No argument coding in this slice.</p>
      </div>
    );
  const fmtCell = (v: number | null) =>
    v === null ? "—" : metric === "lift" ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}` : pct(v);
  return (
    <div className="grid gap-3">
      <GroupLabel label={g.label} />
      <Download
        name={`arguments${g.label ? `_${slugify(g.label)}` : ""}`}
        header={["argument", ...series.flatMap((x) => [
          `${x.name} lift`, `${x.name} in wins`, `${x.name} overall`, `${x.name} where missing`,
        ])]}
        rows={() =>
          first.map((r0) => [
            r0.code,
            ...series.flatMap((x) => {
              const r = liftOf(x, r0.code);
              return r
                ? [Math.round(r.lift * 100), Math.round(r.shareWins * 100), Math.round(r.shareAll * 100), Math.round(r.shareAbsent * 100)]
                : [null, null, null, null];
            }),
          ])
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
              <th className="py-2 pr-4 font-semibold">Argument</th>
              {series.map((x) => (
                <th key={x.name}
                  className="py-2 pr-3 font-semibold text-center cursor-pointer select-none hover:opacity-70"
                  style={{ color: x.color }}
                  onClick={() =>
                    setSortBy(
                      sortBy?.name === x.name
                        ? { name: x.name, dir: sortBy.dir === 1 ? -1 : 1 }
                        : { name: x.name, dir: -1 }
                    )
                  }>
                  <HeadLabel
                    label={x.name}
                    arrow={
                      sortBy?.name === x.name
                        ? sortBy.dir === -1 ? "↓" : "↑"
                        : ""
                    }
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {codes.map((code) => (
              <tr key={code} className="border-b border-line/60">
                <td className="py-2 pr-4 font-medium">{code}</td>
                {series.map((x) => {
                  const v = cell(x, code);
                  const r = liftOf(x, code);
                  return (
                    <td key={x.name}
                      className={`py-2 pr-3 text-center tabular-nums ${
                        metric !== "lift" ? "text-ink-2"
                        : v === null ? "text-ink-3"
                        : v > 0.02 ? "text-success font-semibold"
                        : v < -0.02 ? "text-danger font-semibold"
                        : "text-ink-2"
                      }`}>
                      {r ? (
                        <Tip tip={`in wins ${pct(r.shareWins)} (${r.winsN} of ${r.winsOf}) · overall ${pct(r.shareAll)} (${r.n} of ${r.of}) · where missing ${pct(r.shareAbsent)} (${r.absentN} of ${r.absentOf}) · lift ${r.lift >= 0 ? "+" : ""}${(r.lift * 100).toFixed(0)}`}>
                          <span className="cursor-help">{fmtCell(v)}</span>
                        </Tip>
                      ) : ("—")}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Battleground ---------------- */
function Battleground({ groups, st }: { groups: Group[]; st: WbState }) {
  const [sort, setSort] = useState<"contested" | "owned" | "theme">("contested");
  const [display, setDisplay] = useState<"grid" | "table">("grid");
  const firstName = groups[0]?.series[0]?.name ?? "";
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Sort</span>
        {(
          [
            ["contested", "most contested"],
            ["owned", `most owned by ${firstName}`],
            ["theme", "by topic"],
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
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 ml-2">
          View
        </span>
        {(
          [
            ["grid", "Grid"],
            ["table", "Data"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setDisplay(id)}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${
              display === id
                ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                : "border-line text-ink-3 hover:border-ink-3"
            }`}>
            {label}
          </button>
        ))}
      </div>
      <div className="grid gap-8">
        {groups.map((g) => (
          <BattlegroundGroup key={g.label ?? "all"} g={g} sort={sort}
            display={display} showCI={st.showCI} />
        ))}
      </div>
    </>
  );
}

function BattlegroundGroup({
  g, sort, display, showCI,
}: {
  g: Group;
  sort: "contested" | "owned" | "theme";
  display: "grid" | "table";
  showCI: boolean;
}) {
  const series = g.series;
  const base = g.m?.promptGrid ?? [];
  const gridFor = (x: Series[number], promptId: string) =>
    x.stats?.m.promptGrid?.find((pg) => pg.promptId === promptId) ?? null;
  const badgeFor = (x: Series[number], promptId: string) =>
    gridFor(x, promptId)?.badge ?? null;
  const dot = (b: string | null) => (
    <span className="inline-block h-2.5 w-2.5 rounded-full"
      style={{
        background: b === "win" ? "var(--color-success, #2e7d4f)"
          : b === "contested" ? "var(--color-warning, #b3822a)"
          : "var(--color-line, #d8dfe2)",
      }} />
  );
  const cellDot = (x: Series[number], promptId: string) => {
    const pg = gridFor(x, promptId);
    if (!pg) return dot(null);
    return (
      <Tip tip={`named in ${pg.targetNamed}/${pg.answers} · picked in ${pg.targetPicks}/${pg.decided} decided${pg.modalPick ? ` · consensus: ${pg.modalPick}` : ""}`}>
        <span className="cursor-help">{dot(pg.badge)}</span>
      </Tip>
    );
  };
  if (base.length === 0)
    return (
      <div className="grid gap-2">
        <GroupLabel label={g.label} />
        <p className="text-sm text-ink-3">No prompt coding in this slice.</p>
      </div>
    );
  const contestScore = (promptId: string) =>
    series.filter((x) => badgeFor(x, promptId) === "contested").length * 2 +
    series.filter((x) => badgeFor(x, promptId) === "win").length;
  const ownedScore = (promptId: string) =>
    (badgeFor(series[0], promptId) === "win" ? 100 : 0) +
    series.filter((x) => badgeFor(x, promptId) === "win").length;
  const rows =
    sort === "contested"
      ? [...base].sort((a, b) => contestScore(b.promptId) - contestScore(a.promptId))
      : sort === "owned"
        ? [...base].sort((a, b) => ownedScore(b.promptId) - ownedScore(a.promptId))
        : base;
  const themes = sort === "theme" ? [...new Set(base.map((pg) => pg.theme))] : [null];
  return (
    <div className="grid gap-3">
      <GroupLabel label={g.label} />
      {display === "grid" && (
      <Download
        name={`battleground${g.label ? `_${slugify(g.label)}` : ""}`}
        header={["prompt", "topic", "brand", "answers", "named", "decided", "picked", "status", "consensus_pick", "consensus_share"]}
        rows={() =>
          base.flatMap((g0) =>
            series.map((x) => {
              const pg = gridFor(x, g0.promptId);
              return [
                g0.text, g0.theme, x.name,
                pg?.answers ?? null, pg?.targetNamed ?? null,
                pg?.decided ?? null, pg?.targetPicks ?? null,
                pg?.badge ?? null, pg?.modalPick ?? null,
                pg?.modalShare !== null && pg?.modalShare !== undefined
                  ? Math.round(pg.modalShare * 100) : null,
              ];
            })
          )
        }
      />
      )}
      {display === "table" ? (
        <SortTable
          filename={`battleground${g.label ? `_${slugify(g.label)}` : ""}.csv`}
          defaultSort={{ id: "named", dir: -1 }}
          cols={[
            { id: "prompt", label: "Prompt",
              val: (r: { pg: NonNullable<RunMetrics["promptGrid"]>[number]; brand: string; color: string }) => r.pg.text,
              render: (r) => (
                <span className="line-clamp-2 max-w-[20rem]" title={r.pg.text}>
                  {r.pg.text}
                </span>
              ) },
            { id: "topic", label: "Topic", val: (r) => r.pg.theme,
              render: (r) => (
                <span className="whitespace-nowrap">
                  {r.pg.theme.replace("_", " ")}
                </span>
              ) },
            { id: "brand", label: "Brand", val: (r) => r.brand,
              color: (r) => r.color,
              render: (r) => (
                <span className="font-medium whitespace-nowrap">{r.brand}</span>
              ) },
            { id: "named", label: "Named", num: true,
              val: (r) => r.pg.answers > 0 ? Math.round((r.pg.targetNamed / r.pg.answers) * 100) : null,
              render: (r) => (
                <span className="whitespace-nowrap">
                  {r.pg.targetNamed}/{r.pg.answers}
                </span>
              ) },
            { id: "picked", label: "Picked", num: true,
              val: (r) => r.pg.decided > 0 ? Math.round((r.pg.targetPicks / r.pg.decided) * 100) : null,
              render: (r) => (
                <span className="whitespace-nowrap">
                  {r.pg.targetPicks}/{r.pg.decided}
                </span>
              ) },
            { id: "consensus", label: "Consensus", 
              val: (r) => r.pg.modalPick ?? null,
              render: (r) => (
                <span className="whitespace-nowrap">{r.pg.modalPick ?? "—"}</span>
              ) },
            { id: "status", label: "Status", val: (r) => r.pg.badge,
              render: (r) => (
                <span className="whitespace-nowrap">{r.pg.badge}</span>
              ) },
          ]}
          rows={series.flatMap((x) =>
            base.flatMap((g0) => {
              const pg = gridFor(x, g0.promptId);
              return pg ? [{ pg, brand: x.name, color: x.color }] : [];
            })
          )}
        />
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
              <th className="py-2 pr-4 font-semibold">Prompt</th>
              <th className="py-2 pr-4 font-semibold">Topic</th>
              {series.map((x) => (
                <th key={x.name} className="py-2 pr-3 font-semibold text-center" style={{ color: x.color }}>
                  {x.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {themes.map((theme) => (
              <>
                {theme && (
                  <tr key={`t-${theme}`} className="bg-primary-soft/20">
                    <td colSpan={2} className="py-1.5 pr-4 text-[11px] font-semibold uppercase tracking-wide text-primary">
                      {theme.replace("_", " ")} — named rate at topic grain
                    </td>
                    {series.map((x) => {
                      const th = x.stats?.m.themes.find((t) => t.theme === theme);
                      return (
                        <td key={x.name} className="py-1.5 pr-3 text-center text-[11px] tabular-nums text-ink-2">
                          {th
                            ? `${pct(th.targetRate)}${th.targetAvgRank ? ` · #${th.targetAvgRank.toFixed(1)}` : ""}${showCI ? ` · ${pct(th.ciLow)}–${pct(th.ciHigh)}` : ""}`
                            : "—"}
                        </td>
                      );
                    })}
                  </tr>
                )}
                {rows
                  .filter((pg) => !theme || pg.theme === theme)
                  .map((pg) => (
                    <tr key={pg.promptId} className="border-b border-line/60">
                      <td className="py-2 pr-4 text-ink-2 max-w-[24rem]">
                        <span className="line-clamp-2">{pg.text}</span>
                      </td>
                      <td className="py-2 pr-4 text-[12px] text-ink-3 whitespace-nowrap">
                        {pg.theme.replace("_", " ")}
                      </td>
                      {series.map((x) => (
                        <td key={x.name} className="py-2 pr-3 text-center">
                          {cellDot(x, pg.promptId)}
                        </td>
                      ))}
                    </tr>
                  ))}
              </>
            ))}
          </tbody>
        </table>
      </div>
      )}
      {display === "grid" && (
      <div className="grid gap-1 text-[12px] text-ink-3">
        <div className="flex gap-4">
          <span>{dot("win")} wins it</span>
          <span>{dot("contested")} contested</span>
          <span>{dot(null)} not named</span>
        </div>
        <p>
          Win = the brand is the prompt&apos;s most common pick AND takes a
          majority (50%+) of its decided answers, with no tie. Contested =
          named in the answers but nobody holds a majority (or someone else
          does). Not named = absent from this prompt&apos;s answers entirely.
        </p>
      </div>
      )}
    </div>
  );
}

/* ---------------- Sources ---------------- */
function Sources({ groups }: { groups: Group[] }) {
  return (
    <div className="grid gap-8">
      {groups.map((g) => {
        const m = g.m;
        const searchMode = m?.modes?.find((x) => x.mode === "search");
        if (!m?.sources || m.sources.domains.length === 0) {
          return (
            <div key={g.label ?? "all"} className="grid gap-2">
              <GroupLabel label={g.label} />
              <p className="text-sm text-ink-3">
                No cited answers in this slice — citations come from
                search-enabled engines.
              </p>
            </div>
          );
        }
        const src = m.sources;
        const max = src.domains[0].share || 1;
        return (
          <div key={g.label ?? "all"} className="grid gap-4">
            <GroupLabel label={g.label} />
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
              ● = brand-owned domain. The brand names on each row are who
              appears in that domain&apos;s citing answers.
            </p>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Risk ---------------- */
function Risk({
  groups, pooled, plan, runId, clientName,
}: {
  groups: Group[];
  pooled: RunMetrics;
  plan: "free" | "pro" | "enterprise";
  runId: string;
  clientName: string;
}) {
  const [verbBrand, setVerbBrand] = useState<string>(clientName);
  const [verbCache, setVerbCache] = useState<
    Record<string, { promptText: string; quote: string | null; interpretation: string | null }[]>
  >({});
  const [verbLoading, setVerbLoading] = useState(false);
  const isClient = verbBrand === clientName;
  const allowed = plan === "enterprise" || isClient;

  useEffect(() => {
    if (isClient || !allowed || verbCache[verbBrand]) return;
    let cancelled = false;
    setVerbLoading(true);
    fetch(`/api/runs/${runId}/verbatims?brand=${encodeURIComponent(verbBrand)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.verbatims) {
          setVerbCache((prev) => ({ ...prev, [verbBrand]: d.verbatims }));
        }
      })
      .finally(() => {
        if (!cancelled) setVerbLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [verbBrand, isClient, allowed, runId, verbCache]);

  const verbatims = isClient
    ? (pooled.negatives ?? [])
    : (verbCache[verbBrand] ?? []);

  return (
    <>
      <div className="grid gap-8">
        {groups.map((g) => (
          <div key={g.label ?? "all"} className="grid gap-2">
            <GroupLabel label={g.label} />
            <SortTable
              filename={`risk${g.label ? `_${slugify(g.label)}` : ""}.csv`}
              defaultSort={{ id: "negpct", dir: -1 }}
              onRowClick={(r) => setVerbBrand(r.name)}
              activeRow={(r) => r.name === verbBrand}
              cols={[
                { id: "brand", label: "Brand", val: (r: Series[number]) => r.name,
                  color: (r) => r.color,
                  render: (r) => <span className="font-medium">{r.name}</span> },
                { id: "named", label: "Named answers", num: true,
                  val: (r) => r.stats?.count ?? null },
                { id: "rec", label: "Recommended", num: true,
                  val: (r) =>
                    r.stats && r.stats.count > 0
                      ? Math.round((r.stats.framing.recommended / r.stats.count) * 100) : null,
                  render: (r) =>
                    r.stats && r.stats.count > 0
                      ? pct(r.stats.framing.recommended / r.stats.count) : "—" },
                { id: "neutral", label: "Neutral", num: true,
                  val: (r) =>
                    r.stats && r.stats.count > 0
                      ? Math.round((r.stats.framing.mentioned / r.stats.count) * 100) : null,
                  render: (r) =>
                    r.stats && r.stats.count > 0 ? (
                      <Tip tip="Named without endorsement or criticism — listed among options, compared factually, or name-dropped in passing">
                        <span className="cursor-help">
                          {pct(r.stats.framing.mentioned / r.stats.count)}
                        </span>
                      </Tip>
                    ) : ("—") },
                { id: "negpct", label: "Negative", num: true,
                  val: (r) =>
                    r.stats && r.stats.count > 0
                      ? Math.round((r.stats.framing.negative / r.stats.count) * 100) : null,
                  render: (r) =>
                    r.stats && r.stats.count > 0 ? (
                      <span className={r.stats.framing.negative > 0 ? "text-danger font-semibold" : ""}>
                        {pct(r.stats.framing.negative / r.stats.count)}
                      </span>
                    ) : ("—") },
                { id: "negn", label: "Negative n", num: true,
                  val: (r) => r.stats?.framing.negative ?? null },
              ]}
              rows={g.series}
            />
          </div>
        ))}
      </div>
      <div className="mt-2">
        <div className="section-label mb-2">Verbatims — {verbBrand}</div>
        {!allowed ? (
          <p className="text-sm text-ink-3">
            Competitor verbatims are available on higher tiers.
          </p>
        ) : verbLoading ? (
          <p className="text-sm text-ink-3">Reading {verbBrand}&apos;s negative answers…</p>
        ) : verbatims.length === 0 ? (
          <p className="text-sm text-ink-3">
            No answers framed {verbBrand} negatively in this run.
          </p>
        ) : (
          <div className="grid gap-3">
            {verbatims.slice(0, 8).map((n, i) => (
              <div key={i} className="border-l-2 border-danger/50 pl-4">
                <p className="text-[13px] text-ink-3 mb-1">“{n.promptText}”</p>
                {n.quote && <p className="text-sm text-ink-2 italic">“{n.quote}”</p>}
                {n.interpretation && (
                  <p className="text-[13px] text-ink-3 mt-1">{n.interpretation}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ---------------- Style ---------------- */
function Style({ pooled }: { pooled: RunMetrics }) {
  if (!pooled.engines || pooled.engines.length === 0)
    return <p className="text-sm text-ink-3">No per-engine data in this run.</p>;
  type E = NonNullable<RunMetrics["engines"]>[number];
  return (
    <>
      <p className="text-[13px] text-ink-3 -mb-1">
        How each engine answers — identical for every brand.
      </p>
      <SortTable
        filename="style.csv"
        defaultSort={{ id: "words", dir: -1 }}
        cols={[
          { id: "engine", label: "Engine", val: (e: E) => e.model,
            render: (e) => (
              <span className="font-medium">
                {e.model}
                {e.mode === "search" && (
                  <span className="ml-1.5 rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    search
                  </span>
                )}
              </span>
            ) },
          { id: "words", label: "Avg words", num: true, val: (e) => e.style.avgWords },
          { id: "rec", label: "Recommends", num: true,
            val: (e) => Math.round(e.style.recRate * 100),
            render: (e) => pct(e.style.recRate) },
          { id: "price", label: "Quotes prices", num: true,
            val: (e) => Math.round(e.style.priceRate * 100),
            render: (e) => pct(e.style.priceRate) },
          { id: "spec", label: "Quotes specs", num: true,
            val: (e) => Math.round(e.style.specRate * 100),
            render: (e) => pct(e.style.specRate) },
          { id: "clar", label: "Asks back", num: true,
            val: (e) => Math.round(e.style.clarRate * 100),
            render: (e) => pct(e.style.clarRate) },
          { id: "opts", label: "Options offered", num: true,
            val: (e) => Number(e.style.avgOptions.toFixed(1)) },
          { id: "searched", label: "Searches", num: true,
            val: (e) =>
              e.searchRate !== null ? Math.round(e.searchRate * 100) : null,
            render: (e) =>
              e.mode !== "search" ? "—"
              : e.searchRate !== null ? pct(e.searchRate)
              : e.citedAnswers > 0 ? "always" : "—" },
        ]}
        rows={pooled.engines}
      />
    </>
  );
}
