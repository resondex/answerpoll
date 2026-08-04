"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Project, PromptTheme, Run } from "@/lib/types";

type ProjectWithRun = Project & { latestRun: Run | null };

interface DraftPrompt {
  text: string;
  theme: PromptTheme;
}

const THEMES: PromptTheme[] = [
  "discovery",
  "recommendation",
  "comparison",
  "use_case",
  "branded",
];

export default function AppHomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectWithRun[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [brand, setBrand] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [competitors, setCompetitors] = useState<string[]>([]);
  const [compDraft, setCompDraft] = useState("");
  const [audience, setAudience] = useState("");
  const [prompts, setPrompts] = useState<DraftPrompt[] | null>(null);

  const [editing, setEditing] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  function start(e: React.FormEvent) {
    e.preventDefault();
    if (!brand.trim()) return;
    setCategory("");
    setCompetitors([]);
    setCompDraft("");
    setAudience("");
    setPrompts(null);
    setEditing(false);
    setError(null);
    setModalOpen(true);
    void suggest();
  }

  async function suggest() {
    setSuggesting(true);
    setError(null);
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand }),
    });
    const data = await res.json().catch(() => ({}));
    setSuggesting(false);
    if (!res.ok) {
      setError(
        (data.error ?? "estimation failed") + " — fill in the details manually"
      );
      return;
    }
    setCategory(data.profile.category);
    setCompetitors(data.profile.competitors);
    setCompDraft("");
    setAudience(data.profile.audience);
    setPrompts(null);
  }

  function allCompetitors(): string[] {
    const draft = compDraft.trim().replace(/,+$/, "");
    const list = draft ? [...competitors, draft] : competitors;
    return [...new Set(list)];
  }

  function addCompetitor() {
    setCompetitors(allCompetitors());
    setCompDraft("");
    setPrompts(null);
  }

  function removeCompetitor(name: string) {
    setCompetitors(competitors.filter((c) => c !== name));
    setPrompts(null);
  }

  async function generate() {
    setGenerating(true);
    setError(null);
    const res = await fetch("/api/prompts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand,
        category,
        audience: audience || undefined,
        competitors: allCompetitors(),
      }),
    });
    const data = await res.json();
    setGenerating(false);
    if (!res.ok) {
      setError(data.error ?? "prompt generation failed");
      return;
    }
    setPrompts(data.prompts);
    setEditing(false);
  }

  async function create() {
    if (!prompts) return;
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand,
        category,
        audience: audience || undefined,
        competitors: allCompetitors(),
        prompts: prompts.filter((p) => p.text.trim().length > 0),
      }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!res.ok) {
      setError(data.error ?? "something went wrong");
      return;
    }
    router.push(`/projects/${data.project.id}`);
  }

  const detailsReady = brand.trim() && category.trim();

  return (
    <div className="grid gap-12 lg:grid-cols-[7fr_5fr]">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight mb-2">
          Your trackers
        </h1>
        <p className="text-[15px] text-ink-2 mb-8 leading-relaxed max-w-lg">
          One tracker per brand and category — every run samples the questions
          your buyers ask and scores who gets named.
        </p>

        <form onSubmit={start} className="card p-6 grid gap-4 max-w-lg">
          <div className="section-label">New tracker</div>
          <label className="grid gap-1.5 text-sm font-medium">
            Your brand
            <div className="flex gap-2">
              <input
                className="input w-full"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="e.g. Resondex"
                required
              />
              <button
                type="submit"
                disabled={!brand.trim()}
                className="btn-primary shrink-0"
              >
                Start
              </button>
            </div>
            <span className="text-xs font-normal text-ink-3">
              We&apos;ll estimate your market and draft the question battery —
              you review everything before it runs.
            </span>
          </label>
        </form>
      </section>

      <section>
        <h2 className="section-label mb-3">Trackers</h2>
        {!loaded ? (
          <div className="grid gap-2">
            <div className="card h-[72px] animate-pulse" />
            <div className="card h-[72px] animate-pulse" />
          </div>
        ) : projects.length === 0 ? (
          <div className="card px-5 py-8 text-center text-sm text-ink-3">
            Your first tracker will appear here.
          </div>
        ) : (
          <ul className="grid gap-2">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}`}
                  className="card block px-5 py-4 transition-colors hover:border-primary"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-semibold text-[15px]">{p.name}</span>
                    <RunHint run={p.latestRun} />
                  </div>
                  <div className="text-[13px] text-ink-2 mt-1">
                    {p.brand} · {p.category}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 sm:p-8 overflow-y-auto"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="card w-full max-w-xl bg-surface p-6 grid gap-4 my-auto"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-[17px] tracking-tight">
                Set up tracking for {brand}
              </h2>
              <button
                type="button"
                aria-label="close"
                onClick={() => setModalOpen(false)}
                className="text-ink-3 hover:text-ink text-xl leading-none"
              >
                ×
              </button>
            </div>

            {suggesting ? (
              <div className="grid gap-3 py-6 text-center">
                <p className="text-sm font-medium">
                  Estimating your market
                  <span className="pulse-dot inline-block ml-1">…</span>
                </p>
                <p className="text-[13px] text-ink-3">
                  category · competitors · audience
                </p>
              </div>
            ) : (
              <>
                <label className="grid gap-1.5 text-sm font-medium">
                  Category
                  <input
                    className="input w-full"
                    value={category}
                    onChange={(e) => {
                      setCategory(e.target.value);
                      setPrompts(null);
                    }}
                    placeholder="e.g. market research firms"
                  />
                </label>

                <label className="grid gap-1.5 text-sm font-medium">
                  Competitors
                  {competitors.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {competitors.map((c) => (
                        <span
                          key={c}
                          className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-3 py-1 text-[13px] font-medium text-primary"
                        >
                          {c}
                          <button
                            type="button"
                            aria-label={`remove ${c}`}
                            onClick={() => removeCompetitor(c)}
                            className="text-primary/70 hover:text-danger leading-none"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <input
                    className="input w-full"
                    value={compDraft}
                    onChange={(e) => setCompDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addCompetitor();
                      }
                    }}
                    onBlur={() => {
                      if (compDraft.trim()) addCompetitor();
                    }}
                    placeholder={
                      competitors.length === 0
                        ? "e.g. Qualtrics — press Enter after each"
                        : "add another…"
                    }
                  />
                </label>

                <label className="grid gap-1.5 text-sm font-medium">
                  Audience{" "}
                  <span className="font-normal text-ink-3">(optional)</span>
                  <input
                    className="input w-full"
                    value={audience}
                    onChange={(e) => {
                      setAudience(e.target.value);
                      setPrompts(null);
                    }}
                    placeholder="e.g. mid-market CPG brands"
                  />
                </label>

                {prompts === null ? (
                  <button
                    type="button"
                    onClick={generate}
                    disabled={!detailsReady || generating}
                    className="btn-primary w-fit"
                  >
                    {generating ? "Writing prompts…" : "Generate prompts"}
                  </button>
                ) : (
                  <div className="grid gap-2">
                    <div className="flex items-baseline justify-between">
                      <span className="section-label">Prompt battery</span>
                      <span className="flex gap-4">
                        {!editing && (
                          <button
                            type="button"
                            onClick={() => setEditing(true)}
                            className="text-[13px] font-medium text-primary hover:opacity-80"
                          >
                            Edit
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={generate}
                          disabled={generating}
                          className="text-[13px] font-medium text-primary hover:opacity-80"
                        >
                          {generating ? "Regenerating…" : "Regenerate"}
                        </button>
                      </span>
                    </div>
                    {!editing ? (
                      <div className="rounded-lg border border-line divide-y divide-line max-h-72 overflow-y-auto">
                        {prompts.map((p, i) => (
                          <div
                            key={i}
                            className="flex items-baseline gap-3 px-3.5 py-2 text-sm"
                          >
                            <span className="text-[11px] font-medium uppercase tracking-wide text-ink-3 w-28 shrink-0">
                              {p.theme.replace("_", " ")}
                            </span>
                            <span className="text-ink-2">{p.text}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="grid gap-2 max-h-72 overflow-y-auto pr-1">
                        {prompts.map((p, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <select
                              value={p.theme}
                              onChange={(e) =>
                                setPrompts(
                                  prompts.map((q, j) =>
                                    j === i
                                      ? {
                                          ...q,
                                          theme: e.target.value as PromptTheme,
                                        }
                                      : q
                                  )
                                )
                              }
                              className="input w-36 shrink-0 text-xs"
                            >
                              {THEMES.map((t) => (
                                <option key={t} value={t}>
                                  {t.replace("_", " ")}
                                </option>
                              ))}
                            </select>
                            <input
                              className="input w-full"
                              value={p.text}
                              onChange={(e) =>
                                setPrompts(
                                  prompts.map((q, j) =>
                                    j === i ? { ...q, text: e.target.value } : q
                                  )
                                )
                              }
                            />
                            <button
                              type="button"
                              aria-label="remove prompt"
                              onClick={() =>
                                setPrompts(prompts.filter((_, j) => j !== i))
                              }
                              className="text-ink-3 hover:text-danger text-lg leading-none px-1"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <div className="flex items-baseline justify-between">
                          <button
                            type="button"
                            onClick={() =>
                              setPrompts([
                                ...prompts,
                                { text: "", theme: "discovery" },
                              ])
                            }
                            className="text-[13px] font-medium text-primary hover:opacity-80"
                          >
                            + Add prompt
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPrompts(
                                prompts.filter(
                                  (p) => p.text.trim().length > 0
                                )
                              );
                              setEditing(false);
                            }}
                            className="text-[13px] font-medium text-primary hover:opacity-80"
                          >
                            Done editing
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {error && <p className="text-sm text-danger">{error}</p>}

                <div className="flex items-center justify-end gap-4 border-t border-line pt-4">
                  <button
                    type="button"
                    onClick={() => setModalOpen(false)}
                    className="text-sm font-medium text-ink-3 hover:text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={create}
                    disabled={
                      submitting ||
                      prompts === null ||
                      prompts.filter((p) => p.text.trim()).length < 4
                    }
                    className="btn-primary"
                  >
                    {submitting ? "Creating…" : "Create tracker"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RunHint({ run }: { run: Run | null }) {
  if (!run) return <span className="text-xs text-ink-3">ready to run</span>;
  const map: Record<Run["status"], { label: string; cls: string }> = {
    pending: { label: "queued", cls: "text-ink-3" },
    running: { label: "running", cls: "text-primary" },
    complete: { label: "measured", cls: "text-success" },
    failed: { label: "run failed", cls: "text-danger" },
  };
  const s = map[run.status];
  return <span className={`text-xs font-medium ${s.cls}`}>{s.label}</span>;
}
