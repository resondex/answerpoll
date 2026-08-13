"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/** The named questions people actually ask of raw evidence. */
export type Lens = "all" | "lost" | "won" | "criticized" | "absent" | "nopick";

export interface AnswersFilter {
  lens: Lens;
  promptId: string | null;
  engine: string | null;
}

export const EMPTY_FILTER: AnswersFilter = {
  lens: "all",
  promptId: null,
  engine: null,
};

/** Server params per lens; the subject brand rides along as `focus`. */
function lensParams(lens: Lens): Record<string, string> {
  switch (lens) {
    case "won":
      return { outcome: "chosen" };
    case "lost":
      return { outcome: "lost" };
    case "criticized":
      return { framing: "negative", brandIsFocus: "1" };
    case "absent":
      return { framing: "absent", brandIsFocus: "1" };
    case "nopick":
      return { outcome: "no_pick" };
    default:
      return {};
  }
}

interface Meta {
  total: number;
  lenses: Record<Lens, number>;
  promptCounts: { promptId: string; text: string; count: number }[];
  engines: string[];
}

/**
 * The reading room. Every other view answers with numbers; this one answers
 * with evidence. The rail lists every prompt with its true count under the
 * current lens and fetches a prompt's answers only when it is expanded, so
 * the rail is never a page pretending to be the whole picture. Within a
 * prompt, rounds group under the engine that produced them.
 */
export default function AnswersView({
  runId,
  filter,
  setFilter,
  subject,
}: {
  runId: string;
  filter: AnswersFilter;
  setFilter: (f: AnswersFilter) => void;
  /** Whose view this is — inherited from Compare, never set here. */
  subject: string;
}) {
  // Meta remembers which query produced it; loading is derived by comparing
  // that against the current query, so the effect never sets state
  // synchronously and render never reads a ref.
  const [meta, setMeta] = useState<(Meta & { forQuery: string }) | null>(null);
  // Per-prompt answer cache, cleared whenever the lens/engine slice changes.
  const [groups, setGroups] = useState<Record<string, Answer[]>>({});
  const [groupLoading, setGroupLoading] = useState<string | null>(null);
  const [openPrompts, setOpenPrompts] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  // Guards a stale fetch resolving after the filter has moved on.
  const fetchSeq = useRef(0);

  const baseQuery = useCallback(() => {
    const q = new URLSearchParams({ focus: subject });
    const p = lensParams(filter.lens ?? "all");
    if (p.outcome) q.set("outcome", p.outcome);
    if (p.framing) {
      q.set("framing", p.framing);
      q.set("brand", subject);
    }
    if (filter.promptId) q.set("promptId", filter.promptId);
    if (filter.engine) q.set("engine", filter.engine);
    return q;
  }, [filter, subject]);

  const loadGroup = useCallback(
    async (promptId: string, seq: number, selectFirst: boolean) => {
      setGroupLoading(promptId);
      try {
        const q = baseQuery();
        q.set("promptId", promptId);
        q.set("limit", "60");
        const res = await fetch(`/api/runs/${runId}/answers?${q.toString()}`);
        if (!res.ok) return;
        const d = await res.json();
        if (seq !== fetchSeq.current) return;
        setGroups((prev) => ({ ...prev, [promptId]: d.answers ?? [] }));
        if (selectFirst && d.answers?.[0]) setSelected(d.answers[0].id);
      } finally {
        if (seq === fetchSeq.current) setGroupLoading(null);
      }
    },
    [baseQuery, runId]
  );

  useEffect(() => {
    const seq = ++fetchSeq.current;
    let cancelled = false;
    const q = baseQuery();
    q.set("limit", "0"); // counts only — answers arrive per group, on expand
    fetch(`/api/runs/${runId}/answers?${q.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || seq !== fetchSeq.current) return;
        setMeta({ ...d, forQuery: baseQuery().toString() });
        setGroups({});
        setSelected(null);
        const first = (d.promptCounts ?? [])[0];
        setOpenPrompts(new Set(first ? [first.promptId] : []));
        if (first) void loadGroup(first.promptId, seq, true);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, filter, subject, baseQuery, loadGroup]);

  const loading = meta === null || meta.forQuery !== baseQuery().toString();

  function toggleGroup(promptId: string) {
    setOpenPrompts((prev) => {
      const next = new Set(prev);
      if (next.has(promptId)) next.delete(promptId);
      else {
        next.add(promptId);
        if (!groups[promptId]) {
          void loadGroup(promptId, fetchSeq.current, selected === null);
        }
      }
      return next;
    });
  }

  const loadedAnswers = Object.values(groups).flat();
  const current = loadedAnswers.find((a) => a.id === selected) ?? null;
  const counts = meta?.lenses;
  const promptText = meta?.promptCounts.find(
    (p) => p.promptId === filter.promptId
  )?.text;

  const LENSES: { id: Lens; label: string; sentence: string }[] = [
    { id: "all", label: "All answers", sentence: `about ${subject}` },
    {
      id: "lost",
      label: "Where we lose",
      sentence: `where an assistant chose someone other than ${subject}`,
    },
    {
      id: "won",
      label: "Where we win",
      sentence: `that crowned ${subject}`,
    },
    {
      id: "criticized",
      label: "Where we're criticized",
      sentence: `that criticize ${subject}`,
    },
    {
      id: "absent",
      label: "Where we're absent",
      sentence: `that never mention ${subject}`,
    },
    {
      id: "nopick",
      label: "Where nobody wins",
      sentence: "that refused to crown anyone",
    },
  ];
  // Saved state may predate the lens shape; fall back rather than crash.
  const active = LENSES.find((l) => l.id === filter.lens) ?? LENSES[0];

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-2.5">
        <span className="text-sm font-semibold">
          Reading answers about {subject}
        </span>
        <span className="text-[12px] text-ink-3">
          {counts?.all ?? "—"} answers in this run · change the brand in
          Compare above
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {LENSES.map((l) => {
          const n = counts?.[l.id];
          const on = filter.lens === l.id;
          return (
            <button
              key={l.id}
              type="button"
              disabled={n === 0}
              onClick={() => setFilter({ ...EMPTY_FILTER, ...filter, lens: l.id })}
              className={`rounded-full border px-3 py-1 text-[13px] font-medium disabled:opacity-40 ${
                on
                  ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                  : "border-line text-ink-2 hover:border-ink-3"
              }`}
            >
              {l.label}{" "}
              <span className={on ? "text-primary" : "text-ink-3"}>
                {n ?? "—"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Narrow
        </span>
        {/* The rail's prompt groups replaced the prompt dropdown; a chip
            survives so a Battleground deep link into one prompt is visible
            and escapable. */}
        {filter.promptId && (
          <button
            type="button"
            onClick={() => setFilter({ ...filter, promptId: null })}
            className="rounded-full border border-[var(--color-primary)] bg-primary-soft px-2.5 py-0.5 text-[12px] font-medium text-primary"
            title={promptText ?? undefined}
          >
            one prompt ×
          </button>
        )}
        <select
          className="input w-auto py-0.5 text-[12px]"
          value={filter.engine ?? ""}
          onChange={(e) =>
            setFilter({ ...filter, engine: e.target.value || null })
          }
        >
          <option value="">any engine</option>
          {(meta?.engines ?? []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {filter.engine && (
          <button
            type="button"
            onClick={() => setFilter({ ...filter, engine: null })}
            className="rounded-full border border-line px-2.5 py-0.5 text-[12px] font-medium text-ink-3 hover:border-ink-3"
          >
            clear
          </button>
        )}
      </div>

      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-ink-2">
          {loading ? (
            "Reading answers…"
          ) : (
            <>
              <span className="font-semibold text-primary">
                {meta?.total ?? 0} {meta?.total === 1 ? "answer" : "answers"}
              </span>{" "}
              {active.sentence}
              {promptText ? ` on “${promptText}”` : ""}
              {filter.engine ? `, from ${filter.engine}` : ""}. Expand a
              prompt to read its rounds.
            </>
          )}
        </p>
        {loadedAnswers.length > 0 && (
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
              loadedAnswers.map((a) => [
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

      {!loading && (meta?.promptCounts.length ?? 0) === 0 ? (
        <p className="text-sm text-ink-3">
          Nothing here — try another lens or engine.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] lg:h-[38rem]">
          <div className="grid gap-1 content-start max-h-[34rem] lg:max-h-none lg:h-full overflow-y-auto pr-1">
            {(meta?.promptCounts ?? []).map((grp) => {
              const open = openPrompts.has(grp.promptId);
              const items = groups[grp.promptId];
              const holdsCurrent = current?.promptId === grp.promptId;
              return (
                <div key={grp.promptId} className="grid gap-1">
                  <button
                    type="button"
                    onClick={() => toggleGroup(grp.promptId)}
                    className={`rounded-lg border px-2.5 py-1.5 text-left flex items-start justify-between gap-2 ${
                      holdsCurrent
                        ? "border-[var(--color-primary)]/50 bg-primary-soft/20"
                        : "border-line hover:border-ink-3"
                    }`}
                  >
                    <span className="flex items-start gap-1.5 min-w-0">
                      <span className="text-ink-3 text-[10px] mt-0.5 shrink-0">
                        {open ? "▾" : "▸"}
                      </span>
                      <span className={`text-[12px] leading-snug line-clamp-2 ${holdsCurrent ? "text-primary font-medium" : "text-ink-2"}`}>
                        {grp.text}
                      </span>
                    </span>
                    <span className="text-[11px] text-ink-3 shrink-0 mt-0.5">
                      {grp.count}
                    </span>
                  </button>
                  {open && !items && groupLoading === grp.promptId && (
                    <p className="ml-4 text-[11px] text-ink-3 py-1">Loading…</p>
                  )}
                  {open &&
                    items &&
                    (() => {
                      // Rounds group under their source: one sub-header per
                      // engine, its repeats listed beneath.
                      const bySource: { model: string; rounds: Answer[] }[] = [];
                      const seen = new Map<string, (typeof bySource)[number]>();
                      for (const a of items) {
                        let e = seen.get(a.model);
                        if (!e) {
                          e = { model: a.model, rounds: [] };
                          seen.set(a.model, e);
                          bySource.push(e);
                        }
                        e.rounds.push(a);
                      }
                      return bySource.map((src) => (
                        <div key={src.model} className="ml-4 grid gap-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3 px-1 pt-0.5">
                            {src.model}
                          </div>
                          {src.rounds.map((a) => {
                            const mine = a.brands.find(
                              (b) => b.brand === subject
                            );
                            const on = current?.id === a.id;
                            return (
                              <button
                                key={a.id}
                                type="button"
                                onClick={() => setSelected(a.id)}
                                className={`rounded-lg border px-2.5 py-1 text-left ${
                                  on
                                    ? "border-[var(--color-primary)] bg-primary-soft/40"
                                    : "border-line/70 hover:border-ink-3"
                                }`}
                              >
                                <span className={`block text-[12px] ${on ? "font-semibold text-primary" : "text-ink-2"}`}>
                                  round {a.repeat} ·{" "}
                                  {a.topPick ? `chose ${a.topPick}` : "no pick"}
                                </span>
                                <span className="block text-[11px] text-ink-3">
                                  {mine
                                    ? `${subject} #${mine.rank}${mine.framing === "negative" ? " · criticized" : ""}`
                                    : `${subject} absent`}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ));
                    })()}
                </div>
              );
            })}
          </div>
          {current && (
            <div className="rounded-xl border border-line p-4 grid gap-2 content-start lg:h-full lg:overflow-y-auto lg:min-h-0">
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">
                  {current.model}
                </span>
                {current.mode === "search" && (
                  <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
                    searched
                  </span>
                )}
                <span>round {current.repeat}</span>
                <span>·</span>
                <span>
                  {current.topPick ? `chose ${current.topPick}` : "no pick"}
                </span>
                {current.brands.find((b) => b.brand === subject) && (
                  <>
                    <span>·</span>
                    <span>
                      {subject} named #
                      {current.brands.find((b) => b.brand === subject)!.rank},{" "}
                      {current.brands.find((b) => b.brand === subject)!.framing}
                    </span>
                  </>
                )}
              </div>
              <p className="text-[13px] font-medium text-ink-2">
                “{current.promptText}”
              </p>
              <div className="border-l-2 border-line pl-4">
                <AnswerText text={current.text} highlight={[subject]} />
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
