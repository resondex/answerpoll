"use client";

import { useMemo, type ReactNode } from "react";

export interface EngineOption {
  id: string;
  label: string;
  vendor: string;
  available: boolean;
  keyEnv?: string;
  mode: "instinct" | "search";
}

export type EngineModeChoice = "instinct" | "search" | "both";

/** Default panel per mode — one default-tier engine per vendor that can
 * serve it, filtered to what this deployment can actually reach. */
export function defaultEnginesFor(
  choice: EngineModeChoice,
  options: EngineOption[]
): string[] {
  const wanted: string[] = [];
  if (choice !== "search") {
    wanted.push("gpt-5-mini", "claude-sonnet-5", "gemini-flash-latest");
  }
  if (choice !== "instinct") {
    wanted.push("gpt-5-mini-search", "claude-sonnet-5-search", "sonar");
  }
  return wanted.filter((id) =>
    options.some((e) => e.id === id && e.available)
  );
}

const MODE_INFO: Record<
  "instinct" | "search",
  { title: string; blurb: string; pros: string[]; cons: string[] }
> = {
  instinct: {
    title: "Instinct",
    blurb:
      "The model answers from its trained knowledge — no web access. What the AI believes about your category on its own.",
    pros: [
      "Stable, reproducible baseline — changes only when the model changes",
      "Measures brand equity inside the AI itself",
      "Cheapest to sample",
    ],
    cons: [
      "Consumer apps often search on buyer questions, so this can differ from what buyers see",
      "No citations — source and owned-vs-earned analysis impossible here",
    ],
  },
  search: {
    title: "Search-enabled",
    blurb:
      "The assistant may search the web mid-answer — how the consumer apps behave. The engine decides per answer whether to search, and that choice is recorded.",
    pros: [
      "Closest mirror of what buyers actually see",
      "Answers carry citations — unlocks source landscape and owned vs earned",
      "Content work can move these answers within weeks",
    ],
    cons: [
      "Results shift with the live web — a trend move can mean the web changed, not the model",
      "Slightly noisier run to run; small per-search cost",
    ],
  },
};

function ModeInfoDot({ mode }: { mode: "instinct" | "search" }) {
  const info = MODE_INFO[mode];
  return (
    <span className="group relative inline-flex">
      <span
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-line text-[10px] font-semibold text-ink-3"
        aria-label={`About ${info.title}`}
      >
        i
      </span>
      <span className="pointer-events-none absolute left-1/2 top-5 z-30 hidden w-72 -translate-x-1/2 rounded-lg border border-line bg-surface p-3 text-left normal-case tracking-normal shadow-lg group-hover:block">
        <span className="block text-[13px] font-semibold">{info.title}</span>
        <span className="mt-1 block text-[12px] font-normal leading-snug text-ink-2">
          {info.blurb}
        </span>
        <span className="mt-2 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Strengths
        </span>
        {info.pros.map((t) => (
          <span key={t} className="block text-[12px] font-normal leading-snug text-ink-2">
            + {t}
          </span>
        ))}
        <span className="mt-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Trade-offs
        </span>
        {info.cons.map((t) => (
          <span key={t} className="block text-[12px] font-normal leading-snug text-ink-2">
            − {t}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * Engine chooser shared by setup, the run modal, and the core-panel editor:
 * a three-way mode selector (Instinct / Search-enabled / Both) that presets
 * the panel, with per-engine checkboxes grouped by mode for fine-tuning.
 */
export function EnginePicker({
  options,
  selected,
  onToggle,
  onPreset,
  badge,
}: {
  options: EngineOption[];
  selected: string[];
  onToggle: (id: string, checked: boolean) => void;
  /** Called with the mode's default panel when a mode chip is clicked. */
  onPreset?: (engines: string[], choice: EngineModeChoice) => void;
  /** Optional extra chip per engine row (e.g. "core"). */
  badge?: (id: string) => ReactNode;
}) {
  const activeChoice: EngineModeChoice | null = useMemo(() => {
    const modes = new Set(
      selected
        .map((id) => options.find((e) => e.id === id)?.mode)
        .filter(Boolean)
    );
    if (modes.size === 2) return "both";
    if (modes.has("instinct")) return "instinct";
    if (modes.has("search")) return "search";
    return null;
  }, [selected, options]);

  const group = (mode: "instinct" | "search") => {
    const list = options.filter((e) => e.mode === mode);
    if (list.length === 0) return null;
    return (
      <div key={mode} className="grid gap-1">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-3">
          {MODE_INFO[mode].title}
          <ModeInfoDot mode={mode} />
        </span>
        <div className="grid gap-1 sm:grid-cols-2">
          {list.map((e) => (
            <label
              key={e.id}
              className={`flex items-center gap-2 text-sm ${e.available ? "cursor-pointer" : "opacity-50"}`}
              title={
                e.available
                  ? `${e.vendor} · ${e.id}`
                  : `${e.keyEnv ?? "API key"} is not configured in this deployment`
              }
            >
              <input
                type="checkbox"
                disabled={!e.available}
                checked={selected.includes(e.id)}
                onChange={(ev) => onToggle(e.id, ev.target.checked)}
                className="h-4 w-4 accent-[var(--color-primary)]"
              />
              <span className="font-medium">{e.label}</span>
              <span className="text-xs text-ink-3">{e.vendor}</span>
              {badge?.(e.id)}
              {!e.available && (
                <span className="text-[11px] text-ink-3">
                  · add {e.keyEnv}
                </span>
              )}
            </label>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="grid gap-3">
      {onPreset && (
        <div className="flex flex-wrap items-center gap-1.5">
          {(["instinct", "search", "both"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => onPreset(defaultEnginesFor(choice, options), choice)}
              className={`rounded-full border px-3 py-1 text-[13px] font-medium transition-colors ${
                activeChoice === choice
                  ? "border-[var(--color-primary)] bg-primary-soft text-primary"
                  : "border-line text-ink-2 hover:border-ink-3"
              }`}
            >
              {choice === "both"
                ? "Both"
                : MODE_INFO[choice].title}
            </button>
          ))}
          <span className="text-[12px] text-ink-3">
            — presets the panel; fine-tune below
          </span>
        </div>
      )}
      {group("instinct")}
      {group("search")}
    </div>
  );
}
