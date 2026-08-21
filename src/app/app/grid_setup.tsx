"use client";

import { useState } from "react";

/**
 * Buyer Landscape setup: three confirm gates, each cheap to redo and each
 * catching errors before the next step multiplies them.
 *
 *   1. stages & scenarios  - the composed skeleton; the user keeps/drops
 *      stages and edits scenarios before any prompt exists
 *   2. prompts             - one seed prompt per cell; edit or remove
 *   3. paraphrases         - the full phrasing set per cell; edit or remove
 *
 * The page owns the state (create() and the cost line read it); this
 * component owns the gate UI and the three API calls.
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

export interface GridState {
  step: "compose" | "cells" | "phrasings";
  moderators: Record<string, unknown> & { rationale?: string };
  stages: { key: string; label: string; layer: string }[];
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

/** The chips the classification banner shows, in reading order. */
export function moderatorChips(m: GridState["moderators"]): string[] {
  const dict: Record<string, string> = {
    spec: "spec-driven", taste: "taste-driven", trust: "trust-driven",
    considered: "considered", habitual: "habitual",
    think: "rational", feel: "identity-led",
    solo: "solo buyer", household: "household", committee: "committee-bought",
    one_shot: "one-shot", replenishment: "replenishment", subscription: "subscription",
    performance: "performance risk", financial: "financial risk",
    social: "social risk", physical: "physical risk",
  };
  return [
    m.verifiability, m.involvement, m.think_feel,
    m.decision_unit, m.rhythm, m.risk,
  ]
    .map((v) => dict[String(v)] ?? null)
    .filter((v): v is string => v !== null);
}

interface Props {
  brand: string;
  category: string;
  competitors: string[];
  audience: string;
  detailsReady: boolean;
  state: GridState | null;
  setState: (s: GridState | null) => void;
  /** Label of the call in flight, or null when idle. */
  busy: string | null;
  setBusy: (b: string | null) => void;
  setError: (e: string | null) => void;
}

export function GridSetupPanel({
  brand, category, competitors, audience, detailsReady,
  state, setState, busy, setBusy, setError,
}: Props) {
  const [openCell, setOpenCell] = useState<number | null>(null);

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? "something went wrong");
      return null;
    }
    return data as T;
  }

  async function compose() {
    setBusy("Reading your category…");
    setError(null);
    const data = await post<{
      moderators: GridState["moderators"];
      stages: GridState["stages"];
      scenarios: GridState["scenarios"];
    }>("/api/setup/grid/compose", { category, audience: audience || undefined });
    setBusy(null);
    if (!data) return;
    setState({
      step: "compose",
      moderators: data.moderators,
      stages: data.stages,
      keptStages: data.stages.map((s) => s.key),
      scenarios: data.scenarios,
      cells: [],
    });
  }

  async function writeCells() {
    if (!state) return;
    setBusy("Writing your prompts…");
    setError(null);
    const data = await post<{ cells: Omit<GridCellUi, "phrasings">[] }>(
      "/api/setup/grid/cells",
      {
        brand, category, competitors, audience: audience || undefined,
        moderators: state.moderators,
        stageKeys: state.keptStages,
        scenarios: state.scenarios,
      }
    );
    setBusy(null);
    if (!data) return;
    setState({
      ...state,
      step: "cells",
      cells: data.cells.map((c) => ({ ...c, phrasings: [] })),
    });
  }

  async function writePhrasings() {
    if (!state) return;
    setError(null);
    const cells = state.cells.filter((c) => c.text.trim());
    const merged: GridCellUi[] = cells.map((c) => ({ ...c, phrasings: [] }));
    // Small batches, in layer order: a whole grid in one request would run
    // past the platform's function limit; ~8 cells keeps each call short.
    const batches: { layer: string; idx: number[] }[] = [];
    for (const layer of LAYERS) {
      const idx = merged.map((c, i) => (c.layer === layer ? i : -1)).filter((i) => i >= 0);
      for (let k = 0; k < idx.length; k += PHRASING_BATCH) {
        batches.push({ layer, idx: idx.slice(k, k + PHRASING_BATCH) });
      }
    }
    let done = 0;
    for (const { layer, idx } of batches) {
      setBusy(`Writing paraphrases… ${layer} (${done}/${cells.length})`);
      const data = await post<{ phrasings: { text: string; asker: string }[][] }>(
        "/api/setup/grid/phrasings",
        {
          brand, category, competitors, audience: audience || undefined,
          moderators: state.moderators,
          cells: idx.map((i) => ({
            stage: merged[i].stage,
            situation: merged[i].situation,
            angle: merged[i].angle,
            text: merged[i].text,
          })),
          count: PHRASING_COUNT,
        }
      );
      if (!data) {
        setBusy(null);
        return;
      }
      idx.forEach((i, k) => {
        merged[i] = { ...merged[i], phrasings: (data.phrasings[k] ?? []).map((p) => p.text) };
      });
      done += idx.length;
    }
    setBusy(null);
    setState({ ...state, step: "phrasings", cells: merged });
    setOpenCell(null);
  }

  function stageLabel(key: string): string {
    return state?.stages.find((s) => s.key === key)?.label ?? key;
  }

  function cellMeta(c: GridCellUi): string {
    return (
      stageLabel(c.stage) +
      (c.situation ? ` · ${c.situation}` : "") +
      (c.angle !== "generic"
        ? ` · ${c.angle === "defensive" ? "your churn moment" : `vs ${c.angle}`}`
        : "")
    );
  }

  /* ------------------------------- gate 0 -------------------------------- */
  if (!state) {
    return (
      <button
        type="button"
        onClick={compose}
        disabled={!detailsReady || busy !== null}
        className="btn-primary w-fit"
      >
        {busy ?? "Compose stages & scenarios"}
      </button>
    );
  }

  const banner = (
    <div className="rounded-lg border border-line bg-surface-1 px-3.5 py-2.5 grid gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          We read your category as
        </span>
        {moderatorChips(state.moderators).map((c) => (
          <span
            key={c}
            className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary"
          >
            {c}
          </span>
        ))}
      </div>
      {typeof state.moderators.rationale === "string" && (
        <p className="text-[12px] text-ink-3">{state.moderators.rationale}</p>
      )}
    </div>
  );

  const stepper = (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
      {(
        [
          ["compose", "1 · Stages & scenarios"],
          ["cells", "2 · Prompts"],
          ["phrasings", "3 · Paraphrases"],
        ] as const
      ).map(([k, label], i) => (
        <span key={k} className="flex items-center gap-2">
          {i > 0 && <span className="text-line">›</span>}
          <span className={k === state.step ? "text-primary" : "text-ink-3"}>{label}</span>
        </span>
      ))}
    </div>
  );

  /* ------------------------------- gate 1 -------------------------------- */
  if (state.step === "compose") {
    return (
      <div className="grid gap-3">
        {stepper}
        {banner}
        <div className="grid gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Stages - untick any that don&apos;t fit your category
          </span>
          <div className="grid gap-2 sm:grid-cols-2">
            {LAYERS.map((layer) => {
              const stages = state.stages.filter((s) => s.layer === layer);
              if (stages.length === 0) return null;
              return (
                <div key={layer} className="grid gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                    {layer}
                  </span>
                  {stages.map((s) => {
                    const kept = state.keptStages.includes(s.key);
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
                        <span className={kept ? "text-ink" : "text-ink-3 line-through"}>
                          {s.label}
                        </span>
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        <div className="grid gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Buying scenarios - the circumstances that change the right answer
          </span>
          {state.scenarios.map((sc, i) => (
            <div key={i} className="flex items-start gap-2">
              <input
                className="input w-40 shrink-0 text-sm"
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
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={compose}
            disabled={busy !== null}
            className="text-[13px] font-medium text-ink-3 hover:text-ink"
          >
            Recompose
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={writeCells}
            disabled={
              busy !== null ||
              state.keptStages.length === 0 ||
              state.scenarios.some((s) => !s.label.trim())
            }
            className="btn-primary"
          >
            {busy ?? "Looks right - write the prompts"}
          </button>
        </div>
      </div>
    );
  }

  /* ------------------------------- gate 2 -------------------------------- */
  if (state.step === "cells") {
    return (
      <div className="grid gap-3">
        {stepper}
        <div className="grid gap-3 max-h-96 overflow-y-auto pr-1">
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
                    <span className="w-40 shrink-0 pt-1.5 text-[11px] leading-tight text-ink-3">
                      {cellMeta(c)}
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
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setState({ ...state, step: "compose", cells: [] })}
            disabled={busy !== null}
            className="text-[13px] font-medium text-ink-3 hover:text-ink"
          >
            ← Back to stages & scenarios
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={writePhrasings}
            disabled={busy !== null || state.cells.filter((c) => c.text.trim()).length < 4}
            className="btn-primary"
          >
            {busy ?? "Looks right - write the paraphrases"}
          </button>
        </div>
      </div>
    );
  }

  /* ------------------------------- gate 3 -------------------------------- */
  return (
    <div className="grid gap-3">
      {stepper}
      <p className="text-[12px] text-ink-3">
        Each prompt is asked {PHRASING_COUNT} ways - the same question in the
        wordings real buyers use. Open a cell to edit or remove any of them.
      </p>
      <div className="grid gap-1.5 max-h-96 overflow-y-auto pr-1">
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
                <span className="w-36 shrink-0 text-[11px] leading-tight text-ink-3 pt-0.5">
                  {cellMeta(c)}
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
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() =>
            setState({
              ...state,
              step: "cells",
              cells: state.cells.map((c) => ({ ...c, phrasings: [] })),
            })
          }
          disabled={busy !== null}
          className="text-[13px] font-medium text-ink-3 hover:text-ink"
        >
          ← Back to prompts
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={writePhrasings}
          disabled={busy !== null}
          className="text-[13px] font-medium text-ink-3 hover:text-ink"
        >
          {busy ?? "Rewrite paraphrases"}
        </button>
      </div>
    </div>
  );
}
