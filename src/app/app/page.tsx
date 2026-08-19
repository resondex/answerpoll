"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Project, PromptTheme, Run, SetupDraft } from "@/lib/types";
import {
  EnginePicker,
  defaultEnginesFor,
  type EngineOption,
} from "@/app/components/engine_picker";

type ProjectWithRun = Project & { latestRun: Run | null };

/** Repeats for the run setup launches — matches the dashboard's default. */
const FIRST_RUN_REPEATS = 5;

interface DraftPrompt {
  text: string;
  theme: PromptTheme;
}

/** A grid-built cell as returned by /api/setup/grid, editable in review. */
interface GridCellUi {
  stage: string;
  layer: string;
  situation: string | null;
  angle: string;
  text: string;
}

interface GridData {
  moderators: Record<string, unknown> & { rationale?: string };
  stages: { key: string; label: string; layer: string }[];
  situations: { label: string; description: string }[];
  cells: GridCellUi[];
}

const LAYERS = [
  "awareness",
  "consideration",
  "decision",
  "retention",
  "loyalty",
] as const;

/** The chips the classification banner shows, in reading order. */
function moderatorChips(m: GridData["moderators"]): string[] {
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
  const [studyName, setStudyName] = useState("");
  const [competitors, setCompetitors] = useState<string[]>([]);
  const [compDraft, setCompDraft] = useState("");
  const [audience, setAudience] = useState("");
  const [engineOptions, setEngineOptions] = useState<EngineOption[]>([]);
  const [engineSet, setEngineSet] = useState<string[]>([]);
  const [prompts, setPrompts] = useState<DraftPrompt[] | null>(null);
  // The two battery builders: the classic suggested list, and the decision
  // grid. Both feed the same create call; neither replaces the other.
  const [batteryMode, setBatteryMode] = useState<"classic" | "grid">("classic");
  const [grid, setGrid] = useState<GridData | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  // Snapshot of the details the current battery was generated from — when the
  // live fields drift from it, we offer regeneration; when they match, we don't.
  const [servedProfile, setServedProfile] = useState<{
    category: string;
    competitors: string[];
    audience: string;
  } | null>(null);

  const [drafts, setDrafts] = useState<SetupDraft[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
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
    void refreshDrafts();
    fetch("/api/admin").then((r) => setIsAdmin(r.ok)).catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/engines")
      .then((r) => r.json())
      .then((d) => {
        const list = (d.engines ?? []) as EngineOption[];
        setEngineOptions(list);
        // Default: both modes — instinct baseline + consumer-real search.
        setEngineSet(defaultEnginesFor("both", list));
      })
      .catch(() => {});
  }, []);

  async function refreshDrafts() {
    const res = await fetch("/api/drafts");
    if (res.ok) setDrafts((await res.json()).drafts ?? []);
  }

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
    setStudyName("");
    setCompetitors([]);
    setCompDraft("");
    setAudience("");
    setPrompts(null);
    setServedProfile(null);
    setDraftId(null);
    setEditing(false);
    setError(null);
    setModalOpen(true);
    void setup();
  }

  function resumeDraft(d: SetupDraft) {
    setBrand(d.brand);
    setCategory(d.category);
    setCompetitors(d.competitors);
    setCompDraft("");
    setAudience(d.audience ?? "");
    setPrompts(d.prompts);
    setServedProfile(
      d.prompts
        ? {
            category: d.category,
            competitors: d.competitors,
            audience: d.audience ?? "",
          }
        : null
    );
    setDraftId(d.id);
    setEditing(false);
    setError(null);
    setModalOpen(true);
  }

  async function saveForLater() {
    setSavingDraft(true);
    setError(null);
    const res = await fetch("/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: draftId ?? undefined,
        brand,
        category,
        audience: audience || undefined,
        competitors: allCompetitors(),
        prompts,
      }),
    });
    setSavingDraft(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "saving failed");
      return;
    }
    await refreshDrafts();
    setModalOpen(false);
  }

  async function deleteDraft(id: string) {
    await fetch(`/api/drafts/${id}`, { method: "DELETE" });
    setDrafts(drafts.filter((d) => d.id !== id));
  }

  async function setup() {
    setSuggesting(true);
    setError(null);
    // Profile only — the battery is a second, separate call. One serverless
    // function running two reasoning-model calls back to back can exceed the
    // platform's time limit and die as "estimation failed"; split, each call
    // stays comfortably inside it and progress is visible between them.
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, skipBattery: true }),
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
    setServedProfile({
      category: data.profile.category,
      competitors: data.profile.competitors,
      audience: data.profile.audience,
    });
    // Classic mode drafts its battery right away, as before — just as its
    // own call. Grid mode waits for the compose button.
    if (batteryMode === "classic") {
      await generateWith({
        category: data.profile.category,
        competitors: data.profile.competitors,
        audience: data.profile.audience,
      });
    }
  }

  // Committed pills only — text sitting in the add-another box isn't a change.
  const detailsDirty =
    servedProfile !== null &&
    (category.trim() !== servedProfile.category.trim() ||
      (audience || "").trim() !== servedProfile.audience.trim() ||
      competitors.join("|") !== servedProfile.competitors.join("|"));

  function allCompetitors(): string[] {
    const draft = compDraft.trim().replace(/,+$/, "");
    const list = draft ? [...competitors, draft] : competitors;
    return [...new Set(list)];
  }

  function addCompetitor() {
    setCompetitors(allCompetitors());
    setCompDraft("");
  }

  function removeCompetitor(name: string) {
    setCompetitors(competitors.filter((c) => c !== name));
  }

  async function generateWith(p: {
    category: string;
    competitors: string[];
    audience: string;
  }) {
    setGenerating(true);
    setError(null);
    const res = await fetch("/api/prompts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: studyName.trim() || undefined,
        brand,
        category: p.category,
        audience: p.audience || undefined,
        competitors: p.competitors,
        force: true,
      }),
    });
    const data = await res.json();
    setGenerating(false);
    if (!res.ok) {
      setError(data.error ?? "prompt generation failed");
      return;
    }
    setPrompts(data.prompts);
    setServedProfile({
      category: p.category,
      competitors: p.competitors,
      audience: p.audience || "",
    });
    setEditing(false);
  }

  async function generate() {
    await generateWith({
      category,
      competitors: allCompetitors(),
      audience: audience || "",
    });
  }

  async function generateGrid() {
    setGridLoading(true);
    setError(null);
    const res = await fetch("/api/setup/grid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand,
        category,
        competitors: allCompetitors(),
        audience: audience || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setGridLoading(false);
    if (!res.ok) {
      setError(data.error ?? "grid generation failed");
      return;
    }
    setGrid(data.instrument);
  }

  async function create() {
    const usingGrid = batteryMode === "grid";
    if (usingGrid ? !grid : !prompts) return;
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: studyName.trim() || undefined,
        brand,
        category,
        audience: audience || undefined,
        competitors: allCompetitors(),
        engines: engineSet,
        ...(usingGrid
          ? {
              grid: {
                moderators: grid!.moderators,
                cells: grid!.cells.filter((c) => c.text.trim().length > 0),
              },
            }
          : { prompts: prompts!.filter((p) => p.text.trim().length > 0) }),
      }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!res.ok) {
      setError(data.error ?? "something went wrong");
      return;
    }
    if (draftId) {
      await fetch(`/api/drafts/${draftId}`, { method: "DELETE" });
    }
    // The battery was reviewed and edited on the step above, so there is
    // nothing left for the reader to approve — launch the first run here
    // rather than landing them on an empty dashboard holding a Run button.
    // A launch failure is not fatal: the tracker exists either way, and the
    // dashboard's own Run control reports the reason.
    const panel: string[] = data.project.engine_set?.length
      ? data.project.engine_set
      : engineSet;
    try {
      await fetch(`/api/projects/${data.project.id}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: panel[0] ?? "gpt-5-mini",
          ...(panel.length > 0 ? { models: panel } : {}),
          repeats: FIRST_RUN_REPEATS,
        }),
      });
    } catch {
      // Network hiccup on launch only — the tracker is already created.
    }
    router.push(`/projects/${data.project.id}`);
  }

  const detailsReady = brand.trim() && category.trim();

  return (
    <div className="grid gap-10 max-w-2xl">
      <section>
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">
            Your trackers
          </h1>
          {isAdmin && (
            <Link
              href="/admin"
              className="text-sm font-medium text-primary hover:opacity-80"
            >
              Admin →
            </Link>
          )}
        </div>
        <p className="text-[15px] text-ink-2 mb-8 leading-relaxed max-w-lg">
          One tracker per brand and category — every run samples the questions
          your buyers ask and scores who gets named.
        </p>

        <form onSubmit={start} className="card p-6 grid gap-4">
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
              We&apos;ll estimate your market
              {batteryMode === "classic"
                ? " and draft the question battery"
                : ", then compose your decision grid"}{" "}
              — you review everything before it runs.
            </span>
          </label>
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] text-ink-3 mr-1">Battery:</span>
            {(
              [
                ["classic", "Classic prompts"],
                ["grid", "Decision grid"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setBatteryMode(mode)}
                className={`rounded-full px-3 py-1 text-[12px] font-medium border ${
                  batteryMode === mode
                    ? "border-primary bg-primary-soft text-primary"
                    : "border-line text-ink-3 hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
            {batteryMode === "grid" && (
              <span className="text-[11px] text-ink-3 ml-1">
                every stage of the buying decision, composed for your category
              </span>
            )}
          </div>
        </form>
      </section>

      {drafts.length > 0 && (
        <section>
          <h2 className="section-label mb-3">Saved setups</h2>
          <ul className="grid gap-2">
            {drafts.map((d) => (
              <li
                key={d.id}
                className="card flex items-center justify-between gap-4 px-5 py-3.5"
              >
                <div className="min-w-0">
                  <span className="font-semibold text-[15px]">{d.brand}</span>
                  <span className="text-[13px] text-ink-2">
                    {" "}
                    · {d.category || "setup in progress"}
                    {d.prompts ? ` · ${d.prompts.length} prompts drafted` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <button
                    type="button"
                    onClick={() => resumeDraft(d)}
                    className="text-sm font-semibold text-primary hover:opacity-80"
                  >
                    Continue →
                  </button>
                  <button
                    type="button"
                    aria-label={`delete ${d.brand} setup`}
                    onClick={() => deleteDraft(d.id)}
                    className="text-ink-3 hover:text-danger text-lg leading-none"
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

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
            className="card w-full max-w-3xl bg-surface p-6 grid gap-4 my-auto"
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
              <div className="grid gap-4 py-8 text-center justify-items-center">
                <span
                  aria-hidden="true"
                  className="h-7 w-7 rounded-full border-[3px] border-line border-t-primary animate-spin"
                />
                <p className="text-sm font-medium">
                  {batteryMode === "grid"
                    ? "Estimating your market…"
                    : "Estimating your market and drafting questions…"}
                </p>
                <p className="text-[13px] text-ink-3">
                  {batteryMode === "grid"
                    ? "category · competitors · audience — the grid composes next"
                    : "category · competitors · audience · prompt battery"}
                </p>
              </div>
            ) : (
              <>
                <label className="grid gap-1.5 text-sm font-medium">
                  Study name{" "}
                  <span className="font-normal text-ink-3">
                    (optional — the client / target brand stays {brand})
                  </span>
                  <input
                    className="input w-full"
                    value={studyName}
                    onChange={(e) => setStudyName(e.target.value)}
                    placeholder={`e.g. ${brand} AI visibility — Q3`}
                  />
                </label>

                <label className="grid gap-1.5 text-sm font-medium">
                  Category
                  <input
                    className="input w-full"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
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
                    onChange={(e) => setAudience(e.target.value)}
                    placeholder="e.g. mid-market CPG brands"
                  />
                </label>

                <div className="grid gap-1.5">
                  <span className="text-sm font-medium">
                    AI engines{" "}
                    <span className="font-normal text-ink-3">
                      (the tracker&apos;s core panel — every run and the trend
                      measure these)
                    </span>
                  </span>
                  <EnginePicker
                    options={engineOptions}
                    selected={engineSet}
                    onToggle={(engId, checked) =>
                      setEngineSet((prev) =>
                        checked
                          ? [...prev, engId]
                          : prev.filter((m) => m !== engId)
                      )
                    }
                    onPreset={(list) => setEngineSet(list)}
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] text-ink-3 mr-1">Battery:</span>
                  {(
                    [
                      ["classic", "Classic prompts"],
                      ["grid", "Decision grid"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setBatteryMode(mode)}
                      className={`rounded-full px-3 py-1 text-[12px] font-medium border ${
                        batteryMode === mode
                          ? "border-primary bg-primary-soft text-primary"
                          : "border-line text-ink-3 hover:text-ink"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  {batteryMode === "grid" && (
                    <span className="text-[11px] text-ink-3 ml-1">
                      every stage of the buying decision, composed for your
                      category
                    </span>
                  )}
                </div>

                {batteryMode === "grid" ? (
                  grid === null ? (
                    <button
                      type="button"
                      onClick={generateGrid}
                      disabled={!detailsReady || gridLoading}
                      className="btn-primary w-fit"
                    >
                      {gridLoading
                        ? "Composing the grid…"
                        : "Compose decision grid"}
                    </button>
                  ) : (
                    <div className="grid gap-3">
                      <div className="rounded-lg border border-line bg-surface-1 px-3.5 py-2.5 grid gap-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                            We read your category as
                          </span>
                          {moderatorChips(grid.moderators).map((c) => (
                            <span
                              key={c}
                              className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                        {typeof grid.moderators.rationale === "string" && (
                          <p className="text-[12px] text-ink-3">
                            {grid.moderators.rationale} — edit any cell below;
                            regenerate by switching details.
                          </p>
                        )}
                      </div>
                      <div className="grid gap-3 max-h-96 overflow-y-auto pr-1">
                        {LAYERS.map((layer) => {
                          const cells = grid.cells
                            .map((c, i) => ({ ...c, i }))
                            .filter((c) => c.layer === layer);
                          if (cells.length === 0) return null;
                          return (
                            <div key={layer} className="grid gap-1.5">
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                                {layer}
                              </span>
                              {cells.map((c) => (
                                <div key={c.i} className="flex items-start gap-2">
                                  <span className="w-40 shrink-0 pt-1.5 text-[11px] leading-tight text-ink-3">
                                    {(grid.stages.find((s) => s.key === c.stage)
                                      ?.label ?? c.stage)}
                                    {c.situation ? ` · ${c.situation}` : ""}
                                    {c.angle !== "generic"
                                      ? ` · ${c.angle === "defensive" ? "your churn moment" : `vs ${c.angle}`}`
                                      : ""}
                                  </span>
                                  <textarea
                                    className="input w-full resize-none field-sizing-content text-sm"
                                    rows={1}
                                    value={c.text}
                                    onChange={(e) =>
                                      setGrid({
                                        ...grid,
                                        cells: grid.cells.map((q, j) =>
                                          j === c.i
                                            ? { ...q, text: e.target.value }
                                            : q
                                        ),
                                      })
                                    }
                                  />
                                  <button
                                    type="button"
                                    aria-label="remove cell"
                                    onClick={() =>
                                      setGrid({
                                        ...grid,
                                        cells: grid.cells.filter(
                                          (_, j) => j !== c.i
                                        ),
                                      })
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
                    </div>
                  )
                ) : prompts === null ? (
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
                      {!editing && (
                        <button
                          type="button"
                          onClick={() => setEditing(true)}
                          className="text-[13px] font-medium text-primary hover:opacity-80"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                    {detailsDirty && (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/8 px-3.5 py-2.5 text-[13px]">
                        <span>
                          You changed the details — these prompts were written
                          for the previous ones.
                        </span>
                        <button
                          type="button"
                          onClick={generate}
                          disabled={generating}
                          className="btn-primary shrink-0 px-3 py-1.5 text-[13px]"
                        >
                          {generating ? "Regenerating…" : "Regenerate prompts"}
                        </button>
                      </div>
                    )}
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
                          <div key={i} className="flex items-start gap-2">
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
                            <textarea
                              className="input w-full resize-none field-sizing-content"
                              rows={2}
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

                {/* Say what the button will spend before it spends it. */}
                {(batteryMode === "grid" ? grid !== null : prompts !== null) && (
                  <p className="text-[13px] text-ink-3">
                    Creating this tracker starts your first run:{" "}
                    {(batteryMode === "grid"
                      ? grid!.cells.filter((c) => c.text.trim()).length
                      : prompts!.filter((p) => p.text.trim()).length)}{" "}
                    questions × {FIRST_RUN_REPEATS} repeats ×{" "}
                    {engineSet.length || 1} assistant
                    {engineSet.length === 1 ? "" : "s"} ={" "}
                    {(batteryMode === "grid"
                      ? grid!.cells.filter((c) => c.text.trim()).length
                      : prompts!.filter((p) => p.text.trim()).length) *
                      FIRST_RUN_REPEATS *
                      (engineSet.length || 1)}{" "}
                    answers. It runs in the background — you can watch it land.
                  </p>
                )}

                <div className="flex items-center gap-4 border-t border-line pt-4">
                  <button
                    type="button"
                    onClick={saveForLater}
                    disabled={savingDraft || !brand.trim()}
                    className="text-sm font-medium text-primary hover:opacity-80 disabled:opacity-50"
                  >
                    {savingDraft ? "Saving…" : "Save for later"}
                  </button>
                  <span className="flex-1" />
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
                      (batteryMode === "grid"
                        ? grid === null ||
                          grid.cells.filter((c) => c.text.trim()).length < 4
                        : prompts === null ||
                          prompts.filter((p) => p.text.trim()).length < 4) ||
                      // Now that this button spends money, an empty panel must
                      // not silently fall back to a single engine.
                      engineSet.length === 0
                    }
                    className="btn-primary inline-flex items-center gap-2"
                  >
                    {submitting && (
                      <span
                        aria-hidden="true"
                        className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin"
                      />
                    )}
                    {submitting
                      ? "Starting your first run…"
                      : "Create tracker & run"}
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
