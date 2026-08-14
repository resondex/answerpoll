"use client";

import { useEffect, useState } from "react";
import AnswerText from "./answer_text";
import type { EvidenceTarget } from "./table";
import {
  METRIC_DEFINITION as DEFINITION,
  METRIC_QUESTION as QUESTION,
} from "@/lib/coding_questions";

interface EvidenceAnswer {
  id: string;
  model: string;
  repeat: number;
  prompt: string;
  text: string;
  quote: string | null;
  framing: string | null;
  rank: number | null;
  /** Whether the coder counts this answer in the metric. */
  codedIn: boolean;
  /** Human verdict, or null when nobody has reviewed it. */
  label: boolean | null;
}

interface Evidence {
  metric: "mentioned" | "recommended" | "chosen";
  brand: string;
  base: number;
  count: number;
  reviewed: number;
  humanOverride: boolean;
  answers: EvidenceAnswer[];
}

/**
 * The answers behind one figure. Opens from any table cell that declares a
 * metric and a brand; the query is derived from the metric, so no cell needs
 * its own wiring.
 *
 * A verdict recorded here never moves the figure on its own — labels are
 * evaluation data, and only a project with human override switched on lets
 * them into the arithmetic.
 */
export default function EvidenceDrawer({
  runId,
  target,
  onClose,
}: {
  runId: string;
  target: EvidenceTarget;
  onClose: () => void;
}) {
  const [data, setData] = useState<Evidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);

  // The parent remounts this component per target (see the key in workbench),
  // so state starts fresh without resetting it inside the effect.
  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({
      metric: target.metric,
      brand: target.brand,
    });
    fetch(`/api/runs/${runId}/evidence?${q.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "could not load");
        return r.json();
      })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [runId, target]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  async function label(answerId: string, verdict: boolean) {
    if (!data) return;
    setSaving(answerId);
    try {
      const res = await fetch(`/api/runs/${runId}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          responseId: answerId,
          metric: data.metric,
          brand: data.brand,
          verdict,
        }),
      });
      if (!res.ok) throw new Error("could not save");
      setData((prev) =>
        prev
          ? {
              ...prev,
              reviewed:
                prev.reviewed +
                (prev.answers.find((a) => a.id === answerId)?.label === null
                  ? 1
                  : 0),
              answers: prev.answers.map((a) =>
                a.id === answerId ? { ...a, label: verdict } : a
              ),
            }
          : prev
      );
      // Move to the next unreviewed answer so a slice can be worked through
      // without hunting for where you were.
      setIdx((i) => {
        const next = data.answers.findIndex(
          (a, j) => j > i && a.label === null && a.id !== answerId
        );
        return next === -1 ? i : next;
      });
    } catch {
      setError("Could not save that verdict — try again.");
    } finally {
      setSaving(null);
    }
  }

  const answers = data?.answers ?? [];
  const current = answers[idx] ?? answers[0] ?? null;

  return (
    // Overlay rather than an in-flow panel: opening it must not push the very
    // figures being audited off screen.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Answers behind ${target.metric} for ${target.brand}`}
    >
    <aside
      onClick={(e) => e.stopPropagation()}
      className="w-full max-w-2xl rounded-xl border border-line bg-[var(--color-surface)] grid gap-0 content-start overflow-hidden shadow-xl"
    >
      <div className="border-b border-line p-4 grid gap-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold capitalize">
              {target.metric} · {data?.brand ?? target.brand}
            </h3>
            <p className="text-[12px] text-ink-3 mt-0.5">
              {data
                ? `${data.count} of ${data.base} answers · ${data.base > 0 ? ((100 * data.count) / data.base).toFixed(1) : "0"}%`
                : "Loading…"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-ink-3 hover:text-ink text-lg leading-none"
          >
            ×
          </button>
        </div>
        <p className="text-[12px] text-ink-2 bg-primary-soft/25 rounded-lg px-2.5 py-2 leading-relaxed">
          {DEFINITION[data?.metric ?? target.metric]}
        </p>
        {data && (
          <p className="text-[11px] text-ink-3">
            {data.reviewed} of {answers.length} reviewed
            {data.humanOverride ? (
              <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 font-semibold text-warning">
                reviews change the numbers
              </span>
            ) : (
              <span className="ml-2">· reviews are recorded, not applied</span>
            )}
          </p>
        )}
      </div>

      {error && <p className="p-4 text-sm text-danger">{error}</p>}

      {current && (
        <div className="p-4 grid gap-2 content-start">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
            <span className="rounded-full bg-primary-soft px-2 py-0.5 font-semibold text-primary">
              {current.model}
            </span>
            <span>repeat {current.repeat}</span>
            {current.rank !== null && <span>· named #{current.rank}</span>}
            {current.framing && <span>· {current.framing}</span>}
            {!current.codedIn && (
              <span className="text-warning">· not counted by the coder</span>
            )}
          </div>
          <p className="text-[12px] font-medium text-ink-2">
            “{current.prompt}”
          </p>
          {current.quote && (
            <p className="text-[13px] border-l-2 border-[var(--color-primary)] pl-3 text-ink">
              {current.quote}
            </p>
          )}
          <div className="max-h-72 overflow-y-auto border-l-2 border-line pl-3">
            <AnswerText text={current.text} highlight={[data?.brand ?? target.brand]} />
          </div>
        </div>
      )}

      {current && (
        <div className="border-t border-line p-3 flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-3">
            {QUESTION[data?.metric ?? target.metric]}
          </span>
          <span className="flex items-center gap-1.5">
            {(["yes", "no"] as const).map((v) => {
              const verdict = v === "yes";
              const on = current.label === verdict;
              return (
                <button
                  key={v}
                  type="button"
                  disabled={saving === current.id}
                  onClick={() => label(current.id, verdict)}
                  className={`rounded-full border px-3 py-1 text-[12px] font-medium disabled:opacity-50 ${
                    on
                      ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                      : "border-line text-ink-2 hover:border-ink-3"
                  }`}
                >
                  {v}
                </button>
              );
            })}
          </span>
        </div>
      )}

      {answers.length > 0 && (
        <div className="border-t border-line px-3 py-2 flex items-center justify-between text-[11px] text-ink-3">
          <span>
            answer {Math.min(idx + 1, answers.length)} of {answers.length}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              className="hover:text-ink"
            >
              prev
            </button>
            <button
              type="button"
              onClick={() => setIdx((i) => Math.min(answers.length - 1, i + 1))}
              className="hover:text-ink"
            >
              next
            </button>
          </span>
        </div>
      )}

      {data && answers.length === 0 && (
        <p className="p-4 text-sm text-ink-3">
          No answers behind this figure.
        </p>
      )}
    </aside>
    </div>
  );
}
