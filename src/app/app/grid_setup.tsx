"use client";

import { useState } from "react";

/**
 * Buyer Landscape setup pieces: the state shape, the three API calls, and
 * one view per gate. The wizard decides where these live (rail, footer,
 * container); these know nothing about that.
 */

export const PHRASING_COUNT = 10;
/** Cells per paraphrase request - keeps each call well inside the function limit. */
const PHRASING_BATCH = 8;

export const LAYERS = [
  "awareness",
  "consideration",
  "decision",
  "retention",
  "loyalty",
] as const;

export interface GridCellUi {
  stage: string;
  layer: string;
  situation: string | null;
  angle: string;
  text: string;
  /** Paraphrases beyond the seed text; empty until gate 3. */
  phrasings: string[];
}

export interface GridStage {
  key: string;
  label: string;
  layer: string;
  situational: boolean;
  rivals: "none" | "each" | "defensive_offensive";
  /** The composer's verdict; the user can keep a stage it skipped. */
  recommended?: boolean;
}

export interface GridState {
  step: "compose" | "cells" | "phrasings";
  moderators: Record<string, unknown> & { rationale?: string };
  stages: GridStage[];
  keptStages: string[];
  scenarios: { label: string; description: string }[];
  cells: GridCellUi[];
}

/** Prompts the tracker will hold: every kept seed plus its paraphrases. */
export function gridPromptCount(g: GridState | null): number {
  if (!g) return 0;
  return g.cells
    .filter((c) => c.text.trim())
    .reduce((n, c) => n + 1 + c.phrasings.filter((p) => p.trim()).length, 0);
}

/** Cells the kept stages and scenarios will produce - the same expansion
 * rules the engine's planner applies, so the count is exact before anything
 * is written. */
export function gridCellCount(g: GridState | null, rivalCount: number): number {
  if (!g) return 0;
  const r = Math.min(rivalCount, 4);
  const kept = new Set(g.keptStages);
  return g.stages
    .filter((s) => kept.has(s.key))
    .reduce((n, s) => {
      if (s.rivals === "each") return n + r;
      if (s.rivals === "defensive_offensive") return n + 1 + r;
      if (s.situational) return n + Math.max(g.scenarios.length, 1);
      return n + 1;
    }, 0);
}

export function namesAny(text: string, names: string[]): boolean {
  const t = text.toLowerCase();
  return names.some((n) => n.trim() && t.includes(n.trim().toLowerCase()));
}

/** The category read, as editable dimensions. Changing one recomposes the
 * stage list - the composer is pure code, so that is instant. */
export const MODERATOR_FIELDS: { key: string; options: [string, string][] }[] = [
  { key: "verifiability", options: [["spec", "spec-driven"], ["taste", "taste-driven"], ["trust", "trust-driven"]] },
  { key: "involvement", options: [["considered", "considered"], ["habitual", "habitual"]] },
  { key: "think_feel", options: [["think", "rational"], ["feel", "identity-led"]] },
  { key: "decision_unit", options: [["solo", "solo buyer"], ["household", "household"], ["committee", "committee-bought"]] },
  { key: "rhythm", options: [["one_shot", "one-shot"], ["replenishment", "replenishment"], ["subscription", "subscription"]] },
  { key: "risk", options: [["performance", "performance risk"], ["financial", "financial risk"], ["social", "social risk"], ["physical", "physical risk"]] },
];

/** The chips the classification banner shows, in reading order. */
export function moderatorChips(m: GridState["moderators"]): string[] {
  return MODERATOR_FIELDS.map((f) => {
    const v = String(m[f.key] ?? "");
    return f.options.find(([k]) => k === v)?.[1] ?? null;
  }).filter((v): v is string => v !== null);
}

/* ------------------------------- API calls ------------------------------ */

export interface GridSetupArgs {
  brand: string;
  category: string;
  competitors: string[];
  audience: string;
  state: GridState | null;
  setState: (s: GridState | null) => void;
  setBusy: (b: string | null) => void;
  setError: (e: string | null) => void;
}

export function useGridSetup(a: GridSetupArgs) {
  async function post<T>(path: string, body: unknown): Promise<T | null> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      a.setError(data.error ?? "something went wrong");
      return null;
    }
    return data as T;
  }

  /** Gate 1. With `moderators`, recompose from an edited category read. */
  async function compose(moderators?: GridState["moderators"]): Promise<GridState | null> {
    a.setBusy(moderators ? "Recomposing…" : "Reading your category…");
    a.setError(null);
    const data = await post<{
      moderators: GridState["moderators"];
      stages: GridStage[];
      scenarios: GridState["scenarios"];
    }>("/api/setup/grid/compose", {
      category: a.category,
      audience: a.audience || undefined,
      moderators,
    });
    a.setBusy(null);
    if (!data) return null;
    const next: GridState = {
      step: "compose",
      moderators: data.moderators,
      stages: data.stages,
      keptStages: data.stages.filter((s) => s.recommended !== false).map((s) => s.key),
      // An edited read keeps the user's scenarios unless the decision unit
      // changed, which changes what a scenario even is.
      scenarios:
        moderators && a.state && a.state.moderators.decision_unit === data.moderators.decision_unit
          ? a.state.scenarios
          : data.scenarios,
      cells: [],
    };
    a.setState(next);
    return next;
  }

  /** Gate 2: one seed prompt per cell. */
  async function writeCells(): Promise<GridState | null> {
    if (!a.state) return null;
    a.setBusy("Writing your prompts…");
    a.setError(null);
    const data = await post<{ cells: Omit<GridCellUi, "phrasings">[] }>(
      "/api/setup/grid/cells",
      {
        brand: a.brand, category: a.category, competitors: a.competitors,
        audience: a.audience || undefined,
        moderators: a.state.moderators,
        stageKeys: a.state.keptStages,
        scenarios: a.state.scenarios,
      }
    );
    a.setBusy(null);
    if (!data) return null;
    const next: GridState = {
      ...a.state,
      step: "cells",
      cells: data.cells.map((c) => ({ ...c, phrasings: [] })),
    };
    a.setState(next);
    return next;
  }

  /** Gate 3: paraphrase sets, in small batches so no request runs long. */
  async function writePhrasings(force = false): Promise<GridState | null> {
    if (!a.state) return null;
    a.setError(null);
    const cells = a.state.cells.filter((c) => c.text.trim());
    const merged: GridCellUi[] = cells.map((c) => ({ ...c, phrasings: [] }));
    const batches: { layer: string; idx: number[] }[] = [];
    for (const layer of LAYERS) {
      const idx = merged.map((c, i) => (c.layer === layer ? i : -1)).filter((i) => i >= 0);
      for (let k = 0; k < idx.length; k += PHRASING_BATCH) {
        batches.push({ layer, idx: idx.slice(k, k + PHRASING_BATCH) });
      }
    }
    let done = 0;
    for (const { layer, idx } of batches) {
      a.setBusy(`Writing paraphrases… ${layer} (${done}/${cells.length})`);
      const data = await post<{ phrasings: { text: string; asker: string }[][] }>(
        "/api/setup/grid/phrasings",
        {
          brand: a.brand, category: a.category, competitors: a.competitors,
          audience: a.audience || undefined,
          moderators: a.state.moderators,
          cells: idx.map((i) => ({
            stage: merged[i].stage,
            situation: merged[i].situation,
            angle: merged[i].angle,
            text: merged[i].text,
          })),
          count: PHRASING_COUNT,
          force,
        }
      );
      if (!data) {
        a.setBusy(null);
        return null;
      }
      idx.forEach((i, k) => {
        merged[i] = { ...merged[i], phrasings: (data.phrasings[k] ?? []).map((p) => p.text) };
      });
      done += idx.length;
    }
    a.setBusy(null);
    const next: GridState = { ...a.state, step: "phrasings", cells: merged };
    a.setState(next);
    return next;
  }

  return { compose, writeCells, writePhrasings };
}

/* -------------------------------- views --------------------------------- */

function stageLabel(state: GridState, key: string): string {
  return state.stages.find((s) => s.key === key)?.label ?? key;
}

export function cellMeta(state: GridState, c: GridCellUi): string {
  return (
    stageLabel(state, c.stage) +
    (c.situation ? ` · ${c.situation}` : "") +
    (c.angle !== "generic"
      ? ` · ${c.angle === "defensive" ? "your churn moment" : `vs ${c.angle}`}`
      : "")
  );
}

/** Gate 1: the category read (editable), the stages (keep/drop), the scenarios. */
export function StagesGate({
  state, setState, onRecompose, busy,
}: {
  state: GridState;
  setState: (s: GridState) => void;
  onRecompose: (m: GridState["moderators"]) => void;
  busy: boolean;
}) {
  return (
    <div className="grid gap-5">
      <div className="rounded-lg border border-line bg-surface-1 px-4 py-3 grid gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mr-1">
            We read your category as
          </span>
          {MODERATOR_FIELDS.map((f) => (
            <select
              key={f.key}
              aria-label={f.key.replace("_", " ")}
              value={String(state.moderators[f.key] ?? "")}
              disabled={busy}
              onChange={(e) =>
                onRecompose({ ...state.moderators, [f.key]: e.target.value })
              }
              className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary border-0 cursor-pointer"
            >
              {f.options.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          ))}
        </div>
        {typeof state.moderators.rationale === "string" && (
          <p className="text-[12px] text-ink-3">
            {state.moderators.rationale} Change any read above and the stages
            recompose.
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          All stages - the recommended set is ticked; keep any others that fit
        </span>
        <div className="grid gap-3 sm:grid-cols-3">
          {LAYERS.map((layer) => {
            const stages = state.stages.filter((s) => s.layer === layer);
            if (stages.length === 0) return null;
            return (
              <div key={layer} className="grid gap-1 content-start">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                  {layer}
                </span>
                {stages.map((s) => {
                  const kept = state.keptStages.includes(s.key);
                  const rec = s.recommended !== false;
                  return (
                    <label key={s.key} className="flex items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={kept}
                        onChange={(e) =>
                          setState({
                            ...state,
                            keptStages: e.target.checked
                              ? [...state.keptStages, s.key]
                              : state.keptStages.filter((k) => k !== s.key),
                          })
                        }
                      />
                      <span className={kept ? "text-ink" : rec ? "text-ink-3 line-through" : "text-ink-3"}>
                        {s.label}
                      </span>
                      {rec && (
                        <span className="text-[10px] font-medium uppercase tracking-wide text-primary/70">
                          recommended
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Buying scenarios - the circumstances that change the right answer
        </span>
        {state.scenarios.map((sc, i) => (
          <div key={i} className="flex items-start gap-2">
            <input
              className="input w-48 shrink-0 text-sm"
              value={sc.label}
              placeholder="label"
              onChange={(e) =>
                setState({
                  ...state,
                  scenarios: state.scenarios.map((q, j) =>
                    j === i ? { ...q, label: e.target.value } : q
                  ),
                })
              }
            />
            <textarea
              className="input w-full resize-none field-sizing-content text-sm"
              rows={1}
              value={sc.description}
              placeholder="one sentence describing the circumstance"
              onChange={(e) =>
                setState({
                  ...state,
                  scenarios: state.scenarios.map((q, j) =>
                    j === i ? { ...q, description: e.target.value } : q
                  ),
                })
              }
            />
            <button
              type="button"
              aria-label="remove scenario"
              onClick={() =>
                setState({ ...state, scenarios: state.scenarios.filter((_, j) => j !== i) })
              }
              className="text-ink-3 hover:text-danger text-lg leading-none px-1"
            >
              ×
            </button>
          </div>
        ))}
        {state.scenarios.length < 4 && (
          <button
            type="button"
            onClick={() =>
              setState({
                ...state,
                scenarios: [...state.scenarios, { label: "", description: "" }],
              })
            }
            className="text-[13px] font-medium text-primary hover:opacity-80 w-fit"
          >
            + Add scenario
          </button>
        )}
      </div>
    </div>
  );
}

/** Gate 2: one seed prompt per cell, grouped by layer. */
export function CellsGate({
  state, setState, brandNames,
}: {
  state: GridState;
  setState: (s: GridState) => void;
  brandNames: string[];
}) {
  return (
    <div className="grid gap-4">
      {LAYERS.map((layer) => {
        const cells = state.cells.map((c, i) => ({ ...c, i })).filter((c) => c.layer === layer);
        if (cells.length === 0) return null;
        return (
          <div key={layer} className="grid gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
              {layer}
            </span>
            {cells.map((c) => (
              <div key={c.i} className="flex items-start gap-2">
                <span className="w-44 shrink-0 pt-1.5 text-[11px] leading-tight text-ink-3">
                  {cellMeta(state, c)}
                  <span className={`ml-1 ${namesAny(c.text, brandNames) ? "text-warning" : "text-primary"}`}>
                    · {namesAny(c.text, brandNames) ? "branded" : "blind"}
                  </span>
                </span>
                <textarea
                  className="input w-full resize-none field-sizing-content text-sm"
                  rows={1}
                  value={c.text}
                  onChange={(e) =>
                    setState({
                      ...state,
                      cells: state.cells.map((q, j) =>
                        j === c.i ? { ...q, text: e.target.value } : q
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  aria-label="remove cell"
                  onClick={() =>
                    setState({ ...state, cells: state.cells.filter((_, j) => j !== c.i) })
                  }
                  className="text-ink-3 hover:text-danger text-lg leading-none px-1"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Gate 3: every cell's paraphrase set, expandable. */
export function PhrasingsGate({
  state, setState,
}: {
  state: GridState;
  setState: (s: GridState) => void;
}) {
  const [openCell, setOpenCell] = useState<number | null>(null);
  return (
    <div className="grid gap-3">
      <p className="text-[12px] text-ink-3">
        Each prompt is asked {PHRASING_COUNT} ways - the same question in the
        wordings real buyers use. Open a cell to edit or remove any of them.
      </p>
      <div className="grid gap-1.5">
        {state.cells.map((c, i) => {
          const open = openCell === i;
          const n = 1 + c.phrasings.filter((p) => p.trim()).length;
          return (
            <div key={i} className="rounded-lg border border-line">
              <button
                type="button"
                onClick={() => setOpenCell(open ? null : i)}
                className="w-full flex items-start gap-3 px-3 py-2 text-left"
              >
                <span className="w-44 shrink-0 text-[11px] leading-tight text-ink-3 pt-0.5">
                  {cellMeta(state, c)}
                </span>
                <span className="flex-1 text-sm text-ink-2">{c.text}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    n >= PHRASING_COUNT ? "bg-primary-soft text-primary" : "bg-warning/10 text-warning"
                  }`}
                >
                  {n} phrasings
                </span>
              </button>
              {open && (
                <div className="grid gap-1.5 border-t border-line px-3 py-2">
                  {c.phrasings.map((p, k) => (
                    <div key={k} className="flex items-start gap-2">
                      <span className="w-5 shrink-0 pt-1.5 text-[11px] text-ink-3">{k + 2}.</span>
                      <textarea
                        className="input w-full resize-none field-sizing-content text-sm"
                        rows={1}
                        value={p}
                        onChange={(e) =>
                          setState({
                            ...state,
                            cells: state.cells.map((q, j) =>
                              j === i
                                ? { ...q, phrasings: q.phrasings.map((x, m) => (m === k ? e.target.value : x)) }
                                : q
                            ),
                          })
                        }
                      />
                      <button
                        type="button"
                        aria-label="remove paraphrase"
                        onClick={() =>
                          setState({
                            ...state,
                            cells: state.cells.map((q, j) =>
                              j === i ? { ...q, phrasings: q.phrasings.filter((_, m) => m !== k) } : q
                            ),
                          })
                        }
                        className="text-ink-3 hover:text-danger text-lg leading-none px-1"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      setState({
                        ...state,
                        cells: state.cells.map((q, j) =>
                          j === i ? { ...q, phrasings: [...q.phrasings, ""] } : q
                        ),
                      })
                    }
                    className="text-[13px] font-medium text-primary hover:opacity-80 w-fit"
                  >
                    + Add paraphrase
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
