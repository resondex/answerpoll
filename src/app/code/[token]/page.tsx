"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import AnswerText from "@/app/projects/[id]/answer_text";

interface Item {
  responseId: string;
  brand: string;
  brandNorm: string;
  prompt: string;
  text: string;
}

interface Payload {
  name: string;
  metric: string;
  question: string;
  definition: string;
  category: string;
  items: Item[];
  codes: Record<string, boolean>;
}

const itemKey = (it: Item) => `${it.responseId}|${it.brandNorm}`;

/**
 * The coder's room: one answer at a time, one question, yes or no. The
 * coder types a name once (it attributes their verdicts and lets them
 * resume later) and works through the sample. Deliberately spartan — no
 * metrics, no model verdicts, nothing that could anchor the human.
 */
export default function CodingPage() {
  const { token } = useParams<{ token: string }>();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [coder, setCoder] = useState("");
  const [started, setStarted] = useState(false);
  const [codes, setCodes] = useState<Record<string, boolean>>({});
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const saved = localStorage.getItem(`ap_coder_${token}`);
    fetch(
      `/api/coding/${token}${saved ? `?coder=${encodeURIComponent(saved)}` : ""}`
    )
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "This link didn't work.");
        if (saved) setCoder(saved);
        setPayload(d);
        setCodes(d.codes ?? {});
      })
      .catch((e) => setError((e as Error).message));
  }, [token]);

  const items = useMemo(() => payload?.items ?? [], [payload]);
  const codedCount = items.filter((it) => itemKey(it) in codes).length;

  const begin = () => {
    if (!coder.trim()) return;
    localStorage.setItem(`ap_coder_${token}`, coder.trim());
    // Land on the first uncoded item so a returning coder resumes.
    const first = items.findIndex((it) => !(itemKey(it) in codes));
    setIdx(first === -1 ? 0 : first);
    setStarted(true);
  };

  const submit = useCallback(
    (verdict: boolean) => {
      const it = items[idx];
      if (!it) return;
      setCodes((c) => ({ ...c, [itemKey(it)]: verdict }));
      fetch(`/api/coding/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coder: coder.trim(),
          responseId: it.responseId,
          brandNorm: it.brandNorm,
          brand: it.brand,
          verdict,
        }),
      }).catch(() => {
        // The verdict stays in local state; a re-click retries the write.
      });
      if (idx < items.length - 1) setIdx(idx + 1);
      else setIdx(items.length);
    },
    [items, idx, coder, token]
  );

  const skip = useCallback(() => {
    if (idx < items.length) setIdx(idx + 1);
  }, [idx, items.length]);

  useEffect(() => {
    if (!started) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "y") submit(true);
      else if (e.key === "n") submit(false);
      else if (e.key === "s") skip();
      else if (e.key === "ArrowLeft" && idx > 0) setIdx(idx - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started, submit, skip, idx]);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold mb-2">Link unavailable</h1>
        <p className="text-sm text-ink-2">{error}</p>
      </main>
    );
  }
  if (!payload) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <p className="text-sm text-ink-3">Opening the coding sample…</p>
      </main>
    );
  }

  if (!started) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 grid gap-6">
        <div>
          <h1 className="text-2xl font-semibold mb-2">{payload.name}</h1>
          <p className="text-sm text-ink-2 leading-relaxed">
            You&apos;ll read {items.length} AI-written answers about{" "}
            {payload.category || "a product category"}, one at a time. For
            each, answer one question about the highlighted brand:{" "}
            <span className="font-medium text-ink">{payload.question}</span>
          </p>
          <p className="text-sm text-ink-3 mt-2 leading-relaxed">
            {payload.definition} Go with your honest read — there are no
            trick questions, and you can change an answer by going back.
          </p>
          {codedCount > 0 && (
            <p className="text-sm text-primary mt-2">
              Welcome back — {codedCount} of {items.length} already coded.
            </p>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            begin();
          }}
          className="card p-6 grid gap-3 max-w-sm"
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Your name
            <input
              className="input w-full"
              value={coder}
              onChange={(e) => setCoder(e.target.value)}
              placeholder="So your work is credited"
              maxLength={60}
              required
            />
          </label>
          <button type="submit" className="btn-primary w-fit">
            {codedCount > 0 ? "Continue coding" : "Start coding"}
          </button>
        </form>
      </main>
    );
  }

  if (idx >= items.length) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 grid gap-4">
        <h1 className="text-2xl font-semibold">That&apos;s the set — thank you.</h1>
        <p className="text-sm text-ink-2">
          {codedCount} of {items.length} answers coded
          {codedCount < items.length ? " (the rest were skipped)" : ""}. Your
          verdicts are saved — you can close this page, or go back to revisit
          any answer.
        </p>
        <button
          type="button"
          className="text-sm text-primary font-medium w-fit"
          onClick={() => setIdx(0)}
        >
          ← review from the start
        </button>
      </main>
    );
  }

  const it = items[idx];
  const existing = codes[itemKey(it)];

  return (
    <main className="mx-auto max-w-2xl px-6 py-8 grid gap-4">
      <div className="flex items-center justify-between text-sm text-ink-3">
        <span>
          {idx + 1} of {items.length}
          {codedCount > 0 && ` · ${codedCount} coded`}
        </span>
        <span className="hidden sm:inline">keys: y / n / s · ← back</span>
      </div>
      <div className="h-1 rounded-full bg-line overflow-hidden">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${(codedCount / items.length) * 100}%` }}
        />
      </div>

      <div className="card p-5 grid gap-3">
        <p className="text-[13px] text-ink-3 leading-relaxed">
          Someone asked: <span className="italic">&ldquo;{it.prompt}&rdquo;</span>
        </p>
        <div className="max-h-[50vh] overflow-y-auto border-t border-line pt-3">
          <AnswerText text={it.text} highlight={[it.brand]} />
        </div>
      </div>

      <div className="card p-5 grid gap-3">
        <p className="text-base font-semibold">
          {it.brand} — {payload.question}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => submit(true)}
            className={`rounded-lg px-5 py-2 text-sm font-semibold border ${
              existing === true
                ? "bg-primary text-white border-primary"
                : "border-line hover:border-primary"
            }`}
          >
            Yes
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            className={`rounded-lg px-5 py-2 text-sm font-semibold border ${
              existing === false
                ? "bg-ink text-white border-ink"
                : "border-line hover:border-ink"
            }`}
          >
            No
          </button>
          <button
            type="button"
            onClick={skip}
            className="ml-auto text-sm text-ink-3 hover:text-ink"
          >
            skip →
          </button>
        </div>
        {idx > 0 && (
          <button
            type="button"
            onClick={() => setIdx(idx - 1)}
            className="text-sm text-ink-3 hover:text-ink w-fit"
          >
            ← previous answer
          </button>
        )}
      </div>
    </main>
  );
}
