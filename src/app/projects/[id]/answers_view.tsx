"use client";

import { useEffect, useState } from "react";
import AnswerText from "./answer_text";
import { Download } from "./table";

interface Answer {
  id: string;
  model: string;
  mode: "instinct" | "search";
  promptId: string;
  promptText: string;
  theme: string;
  repeat: number;
  outcome: string | null;
  topPick: string | null;
  brands: { brand: string; rank: number; framing: string }[];
  text: string;
}

export interface AnswersFilter {
  promptId: string | null;
  engine: string | null;
  brand: string | null;
  framing: string | null;
  outcome: string | null;
}

export const EMPTY_FILTER: AnswersFilter = {
  promptId: null,
  engine: null,
  brand: null,
  framing: null,
  outcome: null,
};

/**
 * The reader: every other view answers with numbers, this one answers with
 * evidence. One list, one reader pane, and a count line that always states
 * how much of the run you are looking at — a handful of answers must never
 * pass for the whole picture.
 */
export default function AnswersView({
  runId,
  filter,
  setFilter,
  brands,
  clientBrand,
}: {
  runId: string;
  filter: AnswersFilter;
  setFilter: (f: AnswersFilter) => void;
  brands: string[];
  clientBrand: string;
}) {
  const [data, setData] = useState<{
    total: number;
    answers: Answer[];
    prompts: { id: string; text: string }[];
    engines: string[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const q = new URLSearchParams({ limit: "60" });
    if (filter.promptId) q.set("promptId", filter.promptId);
    if (filter.engine) q.set("engine", filter.engine);
    if (filter.brand) q.set("brand", filter.brand);
    if (filter.framing) q.set("framing", filter.framing);
    if (filter.outcome) q.set("outcome", filter.outcome);
    fetch(`/api/runs/${runId}/answers?${q.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setData(d);
        setSelected(d.answers[0]?.id ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, filter]);

  const set = (patch: Partial<AnswersFilter>) =>
    setFilter({ ...filter, ...patch });

  const answers = data?.answers ?? [];
  const current = answers.find((a) => a.id === selected) ?? answers[0] ?? null;
  const focusBrand = filter.brand ?? clientBrand;

  const sel =
    "input w-auto max-w-[15rem] py-0.5 text-[12px] truncate";

  return (
    <>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Show
          </span>
          <select
            className={sel}
            value={filter.promptId ?? ""}
            onChange={(e) => set({ promptId: e.target.value || null })}
          >
            <option value="">every prompt</option>
            {(data?.prompts ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.text.length > 52 ? `${p.text.slice(0, 52)}…` : p.text}
              </option>
            ))}
          </select>
          <select
            className={sel}
            value={filter.engine ?? ""}
            onChange={(e) => set({ engine: e.target.value || null })}
          >
            <option value="">every engine</option>
            {(data?.engines ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            className={sel}
            value={filter.brand ?? ""}
            onChange={(e) =>
              set({ brand: e.target.value || null, framing: null })
            }
          >
            <option value="">any brand</option>
            {brands.map((b) => (
              <option key={b} value={b}>
                mentions {b}
              </option>
            ))}
          </select>
          {filter.brand && (
            <select
              className={sel}
              value={filter.framing ?? ""}
              onChange={(e) => set({ framing: e.target.value || null })}
            >
              <option value="">any framing</option>
              <option value="recommended">recommended</option>
              <option value="mentioned">neutral</option>
              <option value="negative">criticized</option>
              <option value="absent">absent</option>
            </select>
          )}
          <select
            className={sel}
            value={filter.outcome ?? ""}
            onChange={(e) => set({ outcome: e.target.value || null })}
          >
            <option value="">any outcome</option>
            <option value="chosen">chose {focusBrand}</option>
            <option value="lost">chose someone else</option>
            <option value="no_pick">no pick</option>
          </select>
          {(filter.promptId ||
            filter.engine ||
            filter.brand ||
            filter.outcome) && (
            <button
              type="button"
              onClick={() => setFilter(EMPTY_FILTER)}
              className="rounded-full border border-line px-2.5 py-0.5 text-[12px] font-medium text-ink-3 hover:border-ink-3"
            >
              clear
            </button>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[12px] text-ink-3">
            {loading
              ? "Reading answers…"
              : `Showing ${answers.length} of ${data?.total ?? 0} matching answers`}
          </p>
          {answers.length > 0 && (
            <Download
              name="answers"
              header={[
                "response_id",
                "engine",
                "prompt",
                "repeat",
                "outcome",
                "chose",
                "brands_named",
                "answer",
              ]}
              rows={() =>
                answers.map((a) => [
                  a.id,
                  a.model,
                  a.promptText,
                  a.repeat,
                  a.outcome,
                  a.topPick,
                  a.brands.map((b) => b.brand).join(" | "),
                  a.text,
                ])
              }
            />
          )}
        </div>
      </div>

      {answers.length === 0 && !loading ? (
        <p className="text-sm text-ink-3">
          No answers match these filters. Clear one to widen the search.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
          <div className="grid gap-1 content-start max-h-[34rem] overflow-y-auto pr-1">
            {answers.map((a) => {
              const mine = a.brands.find((b) => b.brand === focusBrand);
              const on = current?.id === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelected(a.id)}
                  className={`rounded-lg border px-2.5 py-1.5 text-left ${
                    on
                      ? "border-[var(--color-primary)] bg-primary-soft/40"
                      : "border-line hover:border-ink-3"
                  }`}
                >
                  <span
                    className={`block truncate text-[12px] ${on ? "font-semibold text-primary" : "text-ink-2"}`}
                  >
                    {a.promptText}
                  </span>
                  <span className="block text-[11px] text-ink-3">
                    {a.model} · r{a.repeat} ·{" "}
                    {a.topPick ? `chose ${a.topPick}` : "no pick"}
                    {mine ? ` · ${focusBrand} #${mine.rank}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
          {current && (
            <div className="rounded-xl border border-line p-4 grid gap-2 content-start">
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">
                  {current.model}
                </span>
                {current.mode === "search" && (
                  <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
                    searched
                  </span>
                )}
                <span>repeat {current.repeat}</span>
                <span>·</span>
                <span>
                  {current.topPick ? `chose ${current.topPick}` : "no pick"}
                </span>
                {current.brands.find((b) => b.brand === focusBrand) && (
                  <>
                    <span>·</span>
                    <span>
                      {focusBrand} named #
                      {current.brands.find((b) => b.brand === focusBrand)!.rank}
                      {", "}
                      {
                        current.brands.find((b) => b.brand === focusBrand)!
                          .framing
                      }
                    </span>
                  </>
                )}
              </div>
              <p className="text-[13px] font-medium text-ink-2">
                “{current.promptText}”
              </p>
              <div className="border-l-2 border-line pl-4">
                <AnswerText text={current.text} highlight={[focusBrand]} />
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
