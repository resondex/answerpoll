"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DictionaryEntry } from "@/lib/types";

const OTHER_CANONICAL = "Other";

interface Pill {
  name: string; // original casing, shown on the pill
  norm: string;
  entryId: string; // entry that owns the name right now (server state)
  kind: "canonical" | "alias";
  homeStatus: DictionaryEntry["status"];
  locked: boolean; // active canonicals anchor their bucket — not draggable
  confirmed: boolean;
  moved: boolean; // user dragged it this session → white
}

interface Bucket {
  key: string; // entryId | "__other__" | "__ignore__" | "new:<entryId>"
  kind: "brand" | "new" | "other" | "ignore";
  entryId: string | null;
  label: string;
  originalLabel: string;
  pills: Pill[];
}

interface Suggestion {
  entryId: string;
  name: string;
  action: "merge" | "approve" | "ignore";
  mergeIntoId: string | null;
  mergeIntoName: string | null;
  rationale: string;
}

function norm(s: string) {
  return s.trim().toLowerCase();
}

/**
 * Identify view: every raw name the answers surfaced is a pill; buckets are
 * the analyzable groupings. Drag to re-file, confirm to commit. Red = never
 * confirmed, blue = confirmed earlier, white = moved this session.
 */
export default function IdentifyTab({
  projectId,
  dict,
  onApplied,
}: {
  projectId: string;
  dict: DictionaryEntry[];
  onApplied: () => Promise<void>;
}) {
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  // Delayed indicator: cached suggestions resolve in <1s — flashing
  // "Sorting…" for that beat reads as flicker, so it only shows when the
  // pass is genuinely slow.
  const [showSorting, setShowSorting] = useState(false);
  useEffect(() => {
    if (!suggesting) {
      setShowSorting(false);
      return;
    }
    const t = setTimeout(() => setShowSorting(true), 600);
    return () => clearTimeout(t);
  }, [suggesting]);
  const [confirming, setConfirming] = useState(false);
  const [dragNorm, setDragNorm] = useState<string | null>(null);
  const [suggestSummary, setSuggestSummary] = useState<{
    merged: number;
    proposed: number;
    ignored: number;
  } | null>(null);
  // Entry ids the suggestion pass has already placed — avoids re-suggesting.
  const suggestedFor = useRef<Set<string>>(new Set());

  const buildBuckets = useCallback(
    (entries: DictionaryEntry[]): Bucket[] => {
      const out: Bucket[] = [];
      const aliasOwners = new Set(
        entries
          .filter((e) => e.status === "active")
          .flatMap((e) => e.aliases)
      );
      const other = entries.find(
        (e) => e.canonical === OTHER_CANONICAL && e.status === "active"
      );
      for (const e of entries) {
        if (e.status !== "active" || e === other) continue;
        out.push({
          key: e.id,
          kind: "brand",
          entryId: e.id,
          label: e.display_name ?? e.canonical,
          originalLabel: e.display_name ?? e.canonical,
          pills: [
            {
              name: e.canonical,
              norm: norm(e.canonical),
              entryId: e.id,
              kind: "canonical",
              homeStatus: "active",
              locked: false,
              confirmed: e.confirmed.includes(norm(e.canonical)),
              moved: false,
            },
            ...e.aliases.map((a) => ({
              name: a,
              norm: a,
              entryId: e.id,
              kind: "alias" as const,
              homeStatus: "active" as const,
              locked: false,
              confirmed: e.confirmed.includes(a),
              moved: false,
            })),
          ],
        });
      }
      out.push({
        key: "__other__",
        kind: "other",
        entryId: other?.id ?? null,
        label: OTHER_CANONICAL,
        originalLabel: OTHER_CANONICAL,
        pills: (other?.aliases ?? []).map((a) => ({
          name: a,
          norm: a,
          entryId: other!.id,
          kind: "alias" as const,
          homeStatus: "active" as const,
          locked: false,
          confirmed: other!.confirmed.includes(a),
          moved: false,
        })),
      });
      out.push({
        key: "__ignore__",
        kind: "ignore",
        entryId: null,
        label: "Ignore",
        originalLabel: "Ignore",
        pills: entries
          .filter(
            (e) =>
              e.status === "rejected" &&
              // Merge remnants live on as aliases elsewhere — one pill only.
              !aliasOwners.has(norm(e.canonical)) &&
              e.canonical !== OTHER_CANONICAL
          )
          .map((e) => ({
            name: e.canonical,
            norm: norm(e.canonical),
            entryId: e.id,
            kind: "canonical" as const,
            homeStatus: "rejected" as const,
            locked: false,
            confirmed: e.confirmed.includes(norm(e.canonical)),
            moved: false,
          })),
      });
      return out;
    },
    []
  );

  // Rebuild from server state whenever the dictionary changes.
  useEffect(() => {
    setBuckets(buildBuckets(dict));
  }, [dict, buildBuckets]);

  const pendingEntries = dict.filter((e) => e.status === "pending");
  const unplacedPending = pendingEntries.filter(
    (e) => !buckets.some((b) => b.pills.some((p) => p.entryId === e.id))
  );

  // Pre-organize newly discovered names by suggestion.
  useEffect(() => {
    const fresh = pendingEntries.filter(
      (e) => !suggestedFor.current.has(e.id)
    );
    if (fresh.length === 0 || suggesting) return;
    fresh.forEach((e) => suggestedFor.current.add(e.id));
    setSuggesting(true);
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/dictionary/suggest`, {
          method: "POST",
        });
        if (!res.ok) return;
        const suggestions: Suggestion[] = (await res.json()).suggestions ?? [];
        const summary = { merged: 0, proposed: 0, ignored: 0 };
        setBuckets((prev) => {
          const next = prev.map((b) => ({ ...b, pills: [...b.pills] }));
          for (const s of suggestions) {
            const entry = pendingEntries.find((e) => e.id === s.entryId);
            if (!entry) continue;
            if (next.some((b) => b.pills.some((p) => p.entryId === s.entryId)))
              continue;
            const pill: Pill = {
              name: entry.canonical,
              norm: norm(entry.canonical),
              entryId: entry.id,
              kind: "canonical",
              homeStatus: "pending",
              locked: false,
              confirmed: false,
              moved: false,
            };
            let target: Bucket | undefined;
            if (s.action === "merge" && s.mergeIntoId) {
              target = next.find((b) => b.entryId === s.mergeIntoId);
            } else if (s.action === "ignore") {
              target = next.find((b) => b.key === "__ignore__");
            }
            if (s.action === "approve" || !target) {
              summary.proposed++;
              next.splice(next.length - 2, 0, {
                key: `new:${entry.id}`,
                kind: "new",
                entryId: entry.id,
                label: entry.canonical,
                originalLabel: entry.canonical,
                pills: [pill],
              });
            } else {
              if (target.kind === "ignore") summary.ignored++;
              else summary.merged++;
              target.pills.push(pill);
            }
          }
          return next;
        });
        setSuggestSummary(summary);
      } finally {
        setSuggesting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEntries.length, projectId]);

  function placePills(pills: Pill[], toKey: string, next: Bucket[]): Bucket[] {
    const anchor = pills.find((p) => p.kind === "canonical") ?? pills[0];
    if (toKey === "__new__") {
      next.splice(next.length - 2, 0, {
        key: `new:${anchor.entryId}:${anchor.norm}`,
        kind: "new",
        entryId: anchor.kind === "canonical" ? anchor.entryId : null,
        label: anchor.name,
        originalLabel: anchor.name,
        pills,
      });
      return next;
    }
    const target = next.find((b) => b.key === toKey);
    if (!target) return next;
    target.pills = [...target.pills, ...pills];
    return next;
  }

  function movePill(pillNorm: string, toKey: string) {
    setBuckets((prev) => {
      const src = prev.find((b) => b.pills.some((p) => p.norm === pillNorm));
      if (!src || src.key === toKey) return prev;
      const pill = src.pills.find((p) => p.norm === pillNorm)!;
      // Dragging a group's anchor name takes the whole group with it — the
      // grouping IS the anchor's entry, so its variants travel together.
      const groupMove =
        pill.kind === "canonical" &&
        pill.homeStatus === "active" &&
        src.kind === "brand";
      const moving = (groupMove ? src.pills : [pill]).map((p) => ({
        ...p,
        moved: true,
      }));
      const movingNorms = new Set(moving.map((p) => p.norm));
      const next = prev
        .map((b) => ({
          ...b,
          pills:
            b.key === src.key
              ? b.pills.filter((p) => !movingNorms.has(p.norm))
              : [...b.pills],
        }))
        // Groups with no pills left disappear.
        .filter(
          (b) =>
            (b.kind !== "new" && b.kind !== "brand") || b.pills.length > 0
        );
      return placePills(moving, toKey, next);
    });
  }

  /** A staged (never-suggested) pending name entering the board on drop. */
  function dropStaged(entryId: string, name: string, toKey: string) {
    setBuckets((prev) => {
      if (prev.some((b) => b.pills.some((p) => p.entryId === entryId)))
        return prev;
      return placePills(
        [
          {
            name,
            norm: norm(name),
            entryId,
            kind: "canonical",
            homeStatus: "pending",
            locked: false,
            confirmed: false,
            moved: true,
          },
        ],
        toKey,
        prev.map((b) => ({ ...b, pills: [...b.pills] }))
      );
    });
  }

  async function confirmAll() {
    setConfirming(true);
    try {
      type Act = Record<string, unknown>;
      const approves: Act[] = [];
      const renames: Act[] = [];
      const moves: Act[] = [];
      const merges: Act[] = [];
      for (const b of buckets) {
        // Entries whose anchor pill sits in this bucket: their merge/reject
        // carries all their aliases, so alias pills of the same entry that
        // traveled along need no separate action.
        const groupedHere = new Set(
          b.pills
            .filter((p) => p.kind === "canonical" && p.homeStatus === "active")
            .map((p) => p.entryId)
        );
        const covered = (p: Pill) =>
          p.kind === "alias" && groupedHere.has(p.entryId);
        if (b.kind === "new") {
          // A name promoted to its own brand. Canonical anchors approve in
          // place; alias anchors are detached into a fresh entry, and the
          // rest of the bucket targets the anchor by name (its id may not
          // exist until the batch runs).
          const anchor =
            b.pills.find((p) => p.kind === "canonical") ?? b.pills[0];
          if (anchor) {
            if (anchor.kind === "canonical") {
              approves.push({ entryId: anchor.entryId, action: "approve" });
              if (b.label.trim() && b.label.trim() !== anchor.name) {
                renames.push({
                  entryId: anchor.entryId,
                  action: "rename",
                  displayName: b.label.trim(),
                });
              }
            } else {
              approves.push({
                entryId: anchor.entryId,
                action: "promote_alias",
                alias: anchor.name,
                ...(b.label.trim() && b.label.trim() !== anchor.name
                  ? { displayName: b.label.trim() }
                  : {}),
              });
            }
            for (const p of b.pills) {
              if (p === anchor || covered(p)) continue;
              const target =
                anchor.kind === "canonical"
                  ? { mergeIntoId: anchor.entryId }
                  : { mergeIntoName: anchor.name };
              if (p.kind === "alias") {
                moves.push({
                  entryId: p.entryId,
                  action: "move_alias",
                  alias: p.name,
                  to: "entry",
                  ...target,
                });
              } else {
                merges.push({ entryId: p.entryId, action: "merge", ...target });
              }
            }
          }
        } else if (b.kind === "brand") {
          if (b.label.trim() && b.label.trim() !== b.originalLabel) {
            renames.push({
              entryId: b.entryId,
              action: "rename",
              displayName: b.label.trim(),
            });
          }
          for (const p of b.pills) {
            if (p.entryId === b.entryId || covered(p)) continue; // home/rode along
            if (p.kind === "alias") {
              moves.push({
                entryId: p.entryId,
                action: "move_alias",
                alias: p.name,
                to: "entry",
                mergeIntoId: b.entryId,
              });
            } else {
              merges.push({
                entryId: p.entryId,
                action: "merge",
                mergeIntoId: b.entryId,
              });
            }
          }
        } else if (b.kind === "other") {
          for (const p of b.pills) {
            if ((b.entryId && p.entryId === b.entryId) || covered(p)) continue;
            if (p.kind === "alias") {
              moves.push({
                entryId: p.entryId,
                action: "move_alias",
                alias: p.name,
                to: "other",
              });
            } else {
              merges.push({ entryId: p.entryId, action: "merge_other" });
            }
          }
        } else {
          for (const p of b.pills) {
            if (p.homeStatus === "rejected" || covered(p)) continue;
            if (p.kind === "alias") {
              moves.push({
                entryId: p.entryId,
                action: "move_alias",
                alias: p.name,
                to: "ignore",
              });
            } else {
              merges.push({ entryId: p.entryId, action: "reject" });
            }
          }
        }
      }
      const actions = [...approves, ...renames, ...moves, ...merges];
      if (actions.length > 0) {
        await fetch(`/api/projects/${projectId}/dictionary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actions }),
        });
      }
      const allNames = buckets.flatMap((b) => b.pills.map((p) => p.name));
      if (allNames.length > 0) {
        await fetch(`/api/projects/${projectId}/dictionary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "confirm", names: allNames }),
        });
      }
      suggestedFor.current.clear();
      await onApplied();
    } finally {
      setConfirming(false);
    }
  }

  const unconfirmedCount = buckets.reduce(
    (n, b) => n + b.pills.filter((p) => !p.confirmed || p.moved).length,
    0
  );

  /** Drop handlers for a bucket — spread on the whole card so any point in
   * the box accepts the pill, not just the pill row. */
  function dropProps(toKey: string) {
    return {
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const n = e.dataTransfer.getData("text/pill");
        if (n) movePill(n, toKey);
        const staged = e.dataTransfer.getData("text/staged");
        if (staged) {
          const s = JSON.parse(staged) as { entryId: string; name: string };
          dropStaged(s.entryId, s.name, toKey);
        }
        setDragNorm(null);
      },
    };
  }

  function bucketBody(b: Bucket) {
    return (
      <div className="flex flex-wrap gap-1.5 min-h-9 rounded-lg p-1 -m-1">
        {b.pills.map((p) => (
          <span
            key={p.norm}
            draggable={!p.locked}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/pill", p.norm);
              setDragNorm(p.norm);
            }}
            onDragEnd={() => setDragNorm(null)}
            title={
              p.kind === "canonical" && p.homeStatus === "active"
                ? "Group anchor — dragging it moves the whole group"
                : p.confirmed && !p.moved
                  ? "Confirmed"
                  : p.moved
                    ? "Moved — will be saved on confirm"
                    : "New — needs your confirmation"
            }
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[13px] font-medium select-none ${
              p.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"
            } ${
              p.moved
                ? "bg-white border-line text-ink"
                : p.confirmed
                  ? "bg-primary-soft border-primary/30 text-primary"
                  : "bg-danger/10 border-danger/30 text-danger"
            } ${dragNorm === p.norm ? "opacity-40" : ""}`}
          >
            {p.name}
          </span>
        ))}
        {b.pills.length === 0 && (
          <span className="text-xs text-ink-3 self-center px-1">
            drop names here
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-danger/60" /> new —
            confirm below
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-primary/60" />{" "}
            confirmed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full border border-line bg-white" />{" "}
            moved this session
          </span>
        </div>
        <button
          type="button"
          onClick={confirmAll}
          disabled={confirming || unconfirmedCount === 0}
          className="btn-primary px-3 py-1.5 text-[13px] inline-flex items-center gap-2"
        >
          {confirming && (
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin"
            />
          )}
          {confirming
            ? "Saving…"
            : unconfirmedCount > 0
              ? `Confirm layout (${unconfirmedCount})`
              : "All confirmed"}
        </button>
      </div>
      {(showSorting || (suggestSummary && !suggesting)) && (
        <p className="text-[13px] text-ink-3">
          {suggesting ? (
            <>
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 mr-1.5 align-[-1px] rounded-full border-2 border-line border-t-primary animate-spin"
              />
              Sorting {unplacedPending.length || "new"} names into suggested
              groups…
            </>
          ) : (
            <>
              Suggestions placed: {suggestSummary!.merged} grouped into
              existing brands, {suggestSummary!.proposed} proposed as new
              brands, {suggestSummary!.ignored} ignored. Rearrange anything,
              then confirm.
            </>
          )}
        </p>
      )}
      {unplacedPending.length > 0 && !suggesting && (
        <div className="rounded-lg border border-dashed border-line p-3">
          <p className="text-xs text-ink-3 mb-2">
            New names — drag into a group:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unplacedPending.map((e) => (
              <span
                key={e.id}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(
                    "text/staged",
                    JSON.stringify({ entryId: e.id, name: e.canonical })
                  );
                }}
                className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2.5 py-1 text-[13px] font-medium text-danger cursor-grab"
              >
                {e.canonical}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {buckets
          .filter((b) => b.kind === "brand")
          .map((b) => (
            <div key={b.key} className="card p-4" {...dropProps(b.key)}>
              <input
                value={b.label}
                onChange={(e) =>
                  setBuckets((prev) =>
                    prev.map((x) =>
                      x.key === b.key ? { ...x, label: e.target.value } : x
                    )
                  )
                }
                className="w-full bg-transparent text-sm font-semibold mb-2 outline-none border-b border-transparent focus:border-line"
                title="Grouping label — used across all reports and dashboards"
              />
              {bucketBody(b)}
            </div>
          ))}
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-2">
          Proposed new brands (
          {buckets.filter((b) => b.kind === "new").length}) — each analyzes as
          its own brand
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {buckets
            .filter((b) => b.kind === "new")
            .map((b) => (
              <div key={b.key} className="card p-3" {...dropProps(b.key)}>
                <input
                  value={b.label}
                  onChange={(e) =>
                    setBuckets((prev) =>
                      prev.map((x) =>
                        x.key === b.key ? { ...x, label: e.target.value } : x
                      )
                    )
                  }
                  className="w-full bg-transparent text-[13px] font-semibold mb-1.5 outline-none border-b border-transparent focus:border-line"
                  title="Grouping label — used across all reports and dashboards"
                />
                {bucketBody(b)}
              </div>
            ))}
          <div
            className="card p-3 border-dashed grid place-items-center text-xs text-ink-3 min-h-16"
            {...dropProps("__new__")}
          >
            drop a name here to make it its own brand
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {buckets
          .filter((b) => b.kind === "other" || b.kind === "ignore")
          .map((b) => (
            <div
              key={b.key}
              className="card p-4 bg-surface-2/50"
              {...dropProps(b.key)}
            >
              <div
                className="text-sm font-semibold mb-2 text-ink-2"
                title={
                  b.kind === "other"
                    ? "Grouped into the analysis as Other — label is fixed"
                    : "Excluded from the analysis — raw data stays intact"
                }
              >
                {b.label}
              </div>
              {bucketBody(b)}
            </div>
          ))}
      </div>
      <p className="text-xs text-ink-3">
        Drag a name onto a group to file it. Labels on your groups are yours
        to edit and flow through every report; the underlying match strings
        are never destroyed, so any decision can be reversed later.
      </p>
    </div>
  );
}
