"use client";

import { useCallback, useEffect, useState } from "react";
import { METRIC_QUESTION } from "@/lib/coding_questions";
import type { CodingMetric } from "@/lib/types";

interface AssignmentRow {
  id: string;
  name: string;
  metric: CodingMetric;
  url: string;
  createdAt: string;
  stats: {
    total: number;
    codedItems: number;
    coders: { coder: string; coded: number; llmAgreement: number | null }[];
    llmAgreement: number | null;
    interRater: number | null;
    interRaterItems: number;
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The owner's side of human coding: create an assignment (a frozen sample
 * of answers behind one question), hand out its link, and watch verdicts
 * accumulate against the LLM coder. Built first as the validation bench for
 * the coder question; the same panel is how a client would commission a
 * human-coded read.
 */
export default function HumanCodingPanel({
  projectId,
  runId,
  onClose,
}: {
  projectId: string;
  runId: string;
  onClose: () => void;
}) {
  const [assignments, setAssignments] = useState<AssignmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [metric, setMetric] = useState<CodingMetric>("recommended");
  const [sampleSize, setSampleSize] = useState(50);
  const [brandScope, setBrandScope] = useState<"focus" | "any">("any");
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/projects/${projectId}/codings`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "couldn't load assignments");
        setAssignments(d.assignments);
      })
      .catch((e) => setError((e as Error).message));
  }, [projectId]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${projectId}/codings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, metric, sampleSize, brandScope }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "couldn't create the assignment");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = (url: string, id: string) => {
    navigator.clipboard
      .writeText(`${window.location.origin}${url}`)
      .then(() => {
        setCopied(id);
        setTimeout(() => setCopied(null), 1500);
      });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[8vh] overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-2xl p-6 grid gap-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Human coding"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Human coding</h2>
            <p className="text-[13px] text-ink-3 leading-relaxed mt-1">
              Freeze a sample of this run&apos;s answers behind one question
              and send the link to anyone — no account needed. Verdicts come
              back here, scored against the LLM coder. Human codes are
              validation data; they never move the dashboard numbers.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="grid gap-3 rounded-lg border border-line p-4">
          <p className="text-sm font-semibold">New assignment</p>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="grid gap-1 text-[12px] font-medium text-ink-3">
              Question
              <select
                className="input"
                value={metric}
                onChange={(e) => setMetric(e.target.value as CodingMetric)}
              >
                {(
                  ["recommended", "mentioned", "chosen", "negative"] as const
                ).map((m) => (
                  <option key={m} value={m}>
                    {m} — {METRIC_QUESTION[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[12px] font-medium text-ink-3">
              Answers
              <input
                type="number"
                min={5}
                max={500}
                className="input w-20"
                value={sampleSize}
                onChange={(e) => setSampleSize(Number(e.target.value))}
              />
            </label>
            <label className="grid gap-1 text-[12px] font-medium text-ink-3">
              Brands
              <select
                className="input"
                value={brandScope}
                onChange={(e) =>
                  setBrandScope(e.target.value as "focus" | "any")
                }
              >
                <option value="any">all mentioned brands</option>
                <option value="focus">focus brand only</option>
              </select>
            </label>
            <button
              type="button"
              onClick={create}
              disabled={busy}
              className="btn-primary"
            >
              {busy ? "Sampling…" : "Create link"}
            </button>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        <div className="grid gap-3">
          {assignments === null ? (
            <p className="text-sm text-ink-3">Loading…</p>
          ) : assignments.length === 0 ? (
            <p className="text-sm text-ink-3">
              No assignments yet — create one above.
            </p>
          ) : (
            assignments.map((a) => (
              <div key={a.id} className="rounded-lg border border-line p-4 grid gap-2">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <p className="text-sm font-semibold">{a.name}</p>
                  <button
                    type="button"
                    onClick={() => copy(a.url, a.id)}
                    className="text-[13px] font-medium text-primary hover:opacity-80"
                  >
                    {copied === a.id ? "copied ✓" : "copy coder link"}
                  </button>
                </div>
                <p className="text-[13px] text-ink-2">
                  {a.stats.codedItems} of {a.stats.total} answers coded
                  {a.stats.llmAgreement !== null &&
                    ` · humans agree with the LLM coder on ${pct(a.stats.llmAgreement)}`}
                  {a.stats.interRater !== null &&
                    ` · coders agree with each other on ${pct(a.stats.interRater)} (${a.stats.interRaterItems} shared answers)`}
                </p>
                {a.stats.coders.length > 0 && (
                  <p className="text-[12px] text-ink-3">
                    {a.stats.coders
                      .map(
                        (c) =>
                          `${c.coder}: ${c.coded} coded${c.llmAgreement !== null ? ` (${pct(c.llmAgreement)} vs LLM)` : ""}`
                      )
                      .join(" · ")}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
