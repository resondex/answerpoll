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
  measure: "named" | "firstNamed" | "sov" | "position";
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

/** Instant tooltip — no native-title delay. */
function Tip({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <span className="group/tip relative inline-block">
      {children}
      <span className="pointer-events-none absolute left-1/2 bottom-full z-30 mb-1.5 hidden w-max max-w-[22rem] -translate-x-1/2 rounded-lg border border-line bg-surface px-3 py-2 text-left text-[12px] font-normal normal-case tracking-normal text-ink-2 shadow-lg group-hover/tip:block">
        {tip}
      </span>
    </span>
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
}: {
  cols: Col<T>[];
  rows: T[];
  filename: string;
  defaultSort?: { id: string; dir: 1 | -1 };
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
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() =>
            downloadCsv(
              filename,
              cols.map((c) => c.label),
              rows.map((r) => cols.map((c) => c.val(r)))
            )
          }
          className="text-[12px] font-medium text-primary hover:opacity-80"
        >
          ↓ csv
        </button>
      </div>
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
                  className={`py-2 ${i === cols.length - 1 ? "" : "pr-4"} font-semibold cursor-pointer select-none hover:opacity-70 ${c.num ? "text-right" : ""}`}
                >
                  {c.label}
                  {sort.id === c.id ? (sort.dir === -1 ? " ↓" : " ↑") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, ri) => (
              <tr key={ri} className="border-b border-line/60">
                {cols.map((c, i) => (
                  <td
                    key={c.id}
                    className={`py-2 ${i === cols.length - 1 ? "" : "pr-4"} ${c.num ? "text-right tabular-nums" : ""}`}
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
    ["position", "Avg position"],
  ] as const;
  const valOf = (s: Series[number]): number | null =>
    !s.stats ? null
    : st.measure === "named" ? s.stats.named
    : st.measure === "firstNamed" ? s.stats.firstNamed
    : st.measure === "sov" ? s.stats.sov
    : s.stats.avgRank;
  const fmt = (v: number | null) =>
    v === null ? "—" : st.measure === "position" ? `#${v.toFixed(1)}` : pct(v);

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
            <div className="section-label mb-2">Framing · % of named answers</div>
            {(["recommended", "mentioned", "negative"] as const).map((f) => (
              <div key={f} className="flex justify-between text-sm py-0.5">
                <span className="text-ink-2">{f === "mentioned" ? "neutral" : f}</span>
                <span className={`font-semibold tabular-nums ${f === "negative" && s.framing[f] > 0 ? "text-danger" : ""}`}>
                  {s.count > 0 ? pct(s.framing[f] / s.count) : "—"}
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
              right: pct(e.namedRate),
            }))} />
          </div>
        )}
      </>
    );
  }

  const chartRows = series.map((sr) => {
    const v = valOf(sr);
    return { label: sr.name, color: sr.color, raw: v, right: fmt(v) };
  });
  const best = st.measure === "position"
    ? Math.min(...chartRows.map((r) => r.raw ?? Infinity))
    : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Chart
        </span>
        {measures.map(([id, label]) => (
          <button key={id} type="button"
            disabled={st.split !== "none" && id !== "named"}
            onClick={() => set({ measure: id })}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium disabled:opacity-40 ${
              st.measure === id
                ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                : "border-line text-ink-3 hover:border-ink-3"
            }`}>
            {label}
          </button>
        ))}
      </div>
      {st.split === "none" && (
        <SeriesBars rows={chartRows.map((r) => ({
          label: r.label,
          color: r.color,
          // Position: lower is better, so the best position gets the full bar.
          value:
            st.measure === "position"
              ? r.raw !== null && best !== null
                ? best / r.raw
                : null
              : r.raw,
          right: r.right,
        }))} />
      )}
      {st.split === "engine" && (
        <div className="grid gap-4">
          {(series[0].stats?.m.engines ?? []).map((e) => (
            <div key={e.model}>
              <div className="section-label mb-1.5">{e.model}</div>
              <SeriesBars rows={series.map((sr) => {
                const row = sr.stats?.m.engines?.find((x) => x.model === e.model);
                return {
                  label: sr.name, color: sr.color, value: row?.namedRate ?? null,
                  right: row ? pct(row.namedRate) : "—",
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
              </div>
              <SeriesBars rows={series.map((sr) => {
                const row = sr.stats?.m.modes?.find((x) => x.mode === mo.mode);
                return {
                  label: sr.name, color: sr.color, value: row?.namedRate ?? null,
                  right: row ? pct(row.namedRate) : "—",
                };
              })} />
            </div>
          ))}
        </div>
      )}
      {st.split === "none" && (
        <SortTable
          filename="visibility.csv"
          defaultSort={{ id: "named", dir: -1 }}
          cols={[
            { id: "brand", label: "Brand", val: (r: Series[number]) => r.name,
              color: (r) => r.color,
              render: (r) => <span className="font-medium">{r.name}</span> },
            { id: "named", label: "Named", num: true,
              val: (r) => r.stats ? Math.round(r.stats.named * 100) : null,
              render: (r) => (r.stats ? pct(r.stats.named) : "—") },
            { id: "ci", label: "95% CI", num: true,
              val: (r) => r.stats ? Math.round(r.stats.ciLow * 100) : null,
              render: (r) =>
                r.stats ? `${pct(r.stats.ciLow)}–${pct(r.stats.ciHigh)}` : "—" },
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
          rows={series}
        />
      )}
    </>
  );
}

/* ---------------- Choice ---------------- */
function Choice({ series, pooled, st }: { series: Series; pooled: RunMetrics; st: WbState }) {
  const [metric, setMetric] = useState<"share" | "chosen" | "top3" | "named">("share");
  const colorOf = (brand: string) =>
    series.find((s) => s.name === brand)?.color ?? null;

  // Decisiveness: the coder types every answer's outcome — a fixed,
  // study-independent typology from the extraction schema.
  const strip = (o: { pick: number; no_pick: number; clarification: number }, label?: string) => {
    const total = o.pick + o.no_pick + o.clarification || 1;
    return (
      <div key={label ?? "run"}>
        {label && <div className="section-label mb-1">{label}</div>}
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

  const metricDefs = [
    ["share", "Share of decided"],
    ["chosen", "Chosen rate"],
    ["top3", "Top-3 rate"],
    ["named", "Named rate"],
  ] as const;
  const valFor = (s: Series[number]) => {
    if (!s.stats) return null;
    if (metric === "share") {
      return pooled.topPicks?.find((t) => t.brand === s.name)?.shareOfDecided ?? 0;
    }
    return metric === "chosen" ? s.stats.chosen : metric === "top3" ? s.stats.top3 : s.stats.named;
  };
  const rows = [...series].sort((a, b) => (valFor(b) ?? 0) - (valFor(a) ?? 0));
  const unselected =
    metric === "share"
      ? (pooled.topPicks ?? [])
          .filter((t) => !series.some((s) => s.name === t.brand))
          .slice(0, Math.max(0, 8 - series.length))
      : [];
  const maxV = Math.max(
    ...rows.map((s) => valFor(s) ?? 0),
    ...unselected.map((t) => t.shareOfDecided),
    0.01
  );

  return (
    <>
      {pooled.outcomes && st.split !== "engine" && (
        <div className="rounded-xl border border-line p-4">
          <div className="section-label mb-2">
            Decisiveness — committed = the answer crowned ONE product as its pick
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
      <div className="grid gap-1.5">
        {rows.map((s) => {
          const v = valFor(s);
          return (
            <div key={s.name} className="grid grid-cols-[10rem_1fr_9rem] items-center gap-3">
              <span className="truncate text-sm text-right font-medium" style={{ color: s.color }}>
                {s.name}
              </span>
              <Bar w={(v ?? 0) / maxV} color={s.color} />
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

      <ChoiceTable series={series} pooled={pooled} />
    </>
  );
}

function ChoiceTable({ series, pooled }: { series: Series; pooled: RunMetrics }) {
  const tp = (name: string) => pooled.topPicks?.find((t) => t.brand === name);
  return (
    <SortTable
      filename="choice.csv"
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
        { id: "picks", label: "Picks", num: true,
          val: (r) => tp(r.name)?.picks ?? 0 },
        { id: "share", label: "Share of decided", num: true,
          val: (r) => Math.round((tp(r.name)?.shareOfDecided ?? 0) * 100),
          render: (r) => pct(tp(r.name)?.shareOfDecided ?? 0) },
      ]}
      rows={series}
    />
  );
}

/* ---------------- Why ---------------- */
function Why({ series }: { series: Series }) {
  const [metric, setMetric] = useState<"lift" | "wins" | "all" | "absent">("lift");
  const [sortBy, setSortBy] = useState<{ name: string; dir: 1 | -1 } | null>(null);
  const first = series[0]?.stats?.m.reasonLift ?? [];
  const liftOf = (s: Series[number], code: string) =>
    s.stats?.m.reasonLift?.find((r) => r.code === code) ?? null;
  const cell = (s: Series[number], code: string): number | null => {
    const r = liftOf(s, code);
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
    return <p className="text-sm text-ink-3">No argument coding in this run.</p>;
  const metricDefs = [
    ["lift", "Lift", "the argument's share in that brand's wins, minus its share overall"],
    ["wins", "In their wins", "share of the brand's winning answers using the argument"],
    ["all", "Overall", "share of all answers using the argument"],
    ["absent", "Where they're missing", "share of answers that never mention the brand — the arguments of conversations they're excluded from"],
  ] as const;
  const fmtCell = (v: number | null) =>
    v === null ? "—" : metric === "lift" ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}` : pct(v);
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Chart
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
      <div className="mt-3 grid gap-1">
        <div className="flex justify-end">
          <button type="button"
            onClick={() =>
              downloadCsv(
                "arguments.csv",
                ["argument", ...series.flatMap((s) => [
                  `${s.name} lift`, `${s.name} in wins`, `${s.name} overall`, `${s.name} where missing`,
                ])],
                first.map((r0) => [
                  r0.code,
                  ...series.flatMap((s) => {
                    const r = liftOf(s, r0.code);
                    return r
                      ? [Math.round(r.lift * 100), Math.round(r.shareWins * 100), Math.round(r.shareAll * 100), Math.round(r.shareAbsent * 100)]
                      : [null, null, null, null];
                  }),
                ])
              )
            }
            className="text-[12px] font-medium text-primary hover:opacity-80">
            ↓ csv
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
                <th className="py-2 pr-4 font-semibold">Argument</th>
                {series.map((s) => (
                  <th key={s.name}
                    className="py-2 pr-3 font-semibold text-right cursor-pointer select-none hover:opacity-70"
                    style={{ color: s.color }}
                    onClick={() =>
                      setSortBy((prev) =>
                        prev?.name === s.name
                          ? { name: s.name, dir: prev.dir === 1 ? -1 : 1 }
                          : { name: s.name, dir: -1 }
                      )
                    }>
                    {s.name}
                    {sortBy?.name === s.name ? (sortBy.dir === -1 ? " ↓" : " ↑") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {codes.map((code) => (
                <tr key={code} className="border-b border-line/60">
                  <td className="py-2 pr-4 font-medium">{code}</td>
                  {series.map((s) => {
                    const v = cell(s, code);
                    const r = liftOf(s, code);
                    return (
                      <td key={s.name}
                        className={`py-2 pr-3 text-right tabular-nums ${
                          metric !== "lift" ? "text-ink-2"
                          : v === null ? "text-ink-3"
                          : v > 0.02 ? "text-success font-semibold"
                          : v < -0.02 ? "text-danger font-semibold"
                          : "text-ink-2"
                        }`}>
                        {r ? (
                          <Tip tip={`in wins ${pct(r.shareWins)} · overall ${pct(r.shareAll)} · where missing ${pct(r.shareAbsent)} · lift ${r.lift >= 0 ? "+" : ""}${(r.lift * 100).toFixed(0)}`}>
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
    </>
  );
}

/* ---------------- Battleground ---------------- */
function Battleground({ series, pooled }: { series: Series; pooled: RunMetrics }) {
  const [sort, setSort] = useState<"contested" | "owned" | "theme">("contested");
  const base = pooled.promptGrid ?? [];
  if (base.length === 0)
    return <p className="text-sm text-ink-3">No prompt coding in this run.</p>;
  const gridFor = (s: Series[number], promptId: string) =>
    s.stats?.m.promptGrid?.find((g) => g.promptId === promptId) ?? null;
  const badgeFor = (s: Series[number], promptId: string) =>
    gridFor(s, promptId)?.badge ?? null;
  const dot = (b: string | null) => (
    <span className="inline-block h-2.5 w-2.5 rounded-full"
      style={{
        background: b === "win" ? "var(--color-success, #2e7d4f)"
          : b === "contested" ? "var(--color-warning, #b3822a)"
          : "var(--color-line, #d8dfe2)",
      }} />
  );
  const cellDot = (s: Series[number], promptId: string) => {
    const g = gridFor(s, promptId);
    if (!g) return dot(null);
    return (
      <Tip tip={`named in ${g.targetNamed}/${g.answers} · picked in ${g.targetPicks}/${g.decided} decided${g.modalPick ? ` · consensus: ${g.modalPick}` : ""}`}>
        <span className="cursor-help">{dot(g.badge)}</span>
      </Tip>
    );
  };
  const contestScore = (promptId: string) =>
    series.filter((s) => badgeFor(s, promptId) === "contested").length * 2 +
    series.filter((s) => badgeFor(s, promptId) === "win").length;
  const ownedScore = (promptId: string) =>
    (badgeFor(series[0], promptId) === "win" ? 100 : 0) +
    series.filter((s) => badgeFor(s, promptId) === "win").length;
  const rows =
    sort === "contested"
      ? [...base].sort((a, b) => contestScore(b.promptId) - contestScore(a.promptId))
      : sort === "owned"
        ? [...base].sort((a, b) => ownedScore(b.promptId) - ownedScore(a.promptId))
        : base;
  const themes = sort === "theme" ? [...new Set(base.map((g) => g.theme))] : [null];
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Sort</span>
        {(
          [
            ["contested", "most contested"],
            ["owned", `most owned by ${series[0]?.name ?? ""}`],
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
      </div>
      <div className="mt-3 flex justify-end">
        <button type="button"
          onClick={() =>
            downloadCsv(
              "battleground.csv",
              ["prompt", "topic", "brand", "answers", "named", "decided", "picked", "status", "consensus_pick", "consensus_share"],
              base.flatMap((g0) =>
                series.map((s) => {
                  const g = gridFor(s, g0.promptId);
                  return [
                    g0.text, g0.theme, s.name,
                    g?.answers ?? null, g?.targetNamed ?? null,
                    g?.decided ?? null, g?.targetPicks ?? null,
                    g?.badge ?? null, g?.modalPick ?? null,
                    g?.modalShare !== null && g?.modalShare !== undefined
                      ? Math.round(g.modalShare * 100) : null,
                  ];
                })
              )
            )
          }
          className="text-[12px] font-medium text-primary hover:opacity-80">
          ↓ csv
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
              <th className="py-2 pr-4 font-semibold">Prompt</th>
              <th className="py-2 pr-4 font-semibold">Topic</th>
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
                    <td colSpan={2} className="py-1.5 pr-4 text-[11px] font-semibold uppercase tracking-wide text-primary">
                      {theme.replace("_", " ")} — named rate at topic grain
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
                      <td className="py-2 pr-4 text-ink-2 max-w-[24rem]">
                        <span className="line-clamp-2">{g.text}</span>
                      </td>
                      <td className="py-2 pr-4 text-[12px] text-ink-3 whitespace-nowrap">
                        {g.theme.replace("_", " ")}
                      </td>
                      {series.map((s) => (
                        <td key={s.name} className="py-2 pr-3 text-center">
                          {cellDot(s, g.promptId)}
                        </td>
                      ))}
                    </tr>
                  ))}
              </>
            ))}
          </tbody>
        </table>
      </div>
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
      <SortTable
        filename="risk.csv"
        defaultSort={{ id: "negpct", dir: -1 }}
        cols={[
          { id: "brand", label: "Brand", val: (r: Series[number]) => r.name,
            color: (r) => r.color,
            render: (r) => <span className="font-medium">{r.name}</span> },
          { id: "named", label: "Named answers", num: true,
            val: (r) => r.stats?.count ?? null },
          { id: "neg", label: "Negative", num: true,
            val: (r) => r.stats?.framing.negative ?? null,
            render: (r) =>
              r.stats ? (
                <span className={r.stats.framing.negative > 0 ? "text-danger font-semibold" : ""}>
                  {r.stats.framing.negative}
                </span>
              ) : ("—") },
          { id: "negpct", label: "% of named", num: true,
            val: (r) =>
              r.stats && r.stats.count > 0
                ? Math.round((r.stats.framing.negative / r.stats.count) * 100) : null,
            render: (r) =>
              r.stats && r.stats.count > 0
                ? pct(r.stats.framing.negative / r.stats.count) : "—" },
          { id: "rec", label: "Recommended", num: true,
            val: (r) => r.stats?.framing.recommended ?? null },
          { id: "recpct", label: "% of named ", num: true,
            val: (r) =>
              r.stats && r.stats.count > 0
                ? Math.round((r.stats.framing.recommended / r.stats.count) * 100) : null,
            render: (r) =>
              r.stats && r.stats.count > 0
                ? pct(r.stats.framing.recommended / r.stats.count) : "—" },
        ]}
        rows={series}
      />
      {pooled.negatives && pooled.negatives.length > 0 && (
        <div className="mt-2">
          <div className="section-label mb-2">
            Verbatims — {project.brand}
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
        ]}
        rows={pooled.engines}
      />
    </>
  );
}
