"use client";

import { useState } from "react";
import type { DictionaryEntry } from "@/lib/types";

const OTHER_CANONICAL = "Other";

/**
 * Parents view: group analyzable brands under their parent company for
 * rollups. Drag a brand into a parent box (or onto the create zone to start
 * a new parent); changes save immediately. Brand-level analysis is
 * untouched — the parent is an extra label, not a merge.
 */
export default function ParentsTab({
  projectId,
  dict,
  onApplied,
}: {
  projectId: string;
  dict: DictionaryEntry[];
  onApplied: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});

  const brands = dict.filter(
    (e) => e.status === "active" && e.canonical !== OTHER_CANONICAL
  );
  const parents = [
    ...new Set(brands.map((b) => b.parent).filter((p): p is string => !!p)),
  ].sort((a, b) => a.localeCompare(b));
  const unparented = brands.filter((b) => !b.parent);

  async function post(body: Record<string, unknown>) {
    setSaving(true);
    try {
      await fetch(`/api/projects/${projectId}/dictionary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await onApplied();
    } finally {
      setSaving(false);
    }
  }

  function dropProps(parent: string | null | "__new__") {
    return {
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const entryId = e.dataTransfer.getData("text/brand");
        if (!entryId) return;
        const brand = brands.find((b) => b.id === entryId);
        if (!brand) return;
        const target =
          parent === "__new__"
            ? (brand.display_name ?? brand.canonical)
            : parent;
        if (brand.parent === target) return;
        post({ entryId, action: "set_parent", parent: target });
      },
    };
  }

  function pill(b: DictionaryEntry) {
    return (
      <span
        key={b.id}
        draggable
        onDragStart={(e) => e.dataTransfer.setData("text/brand", b.id)}
        className="inline-flex items-center rounded-full border border-line bg-white px-2.5 py-1 text-[13px] font-medium text-ink cursor-grab active:cursor-grabbing select-none"
      >
        {b.display_name ?? b.canonical}
      </span>
    );
  }

  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-ink-3 -mt-1">
        Group brands under their parent company for rollup views. Brand-level
        numbers stay exactly as they are — the parent is an extra layer, and
        dragging a brand out again removes it. Changes save as you go
        {saving ? " — saving…" : "."}
      </p>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-2">
          Independent brands ({unparented.length}) — drag into a parent
        </p>
        <div
          className="flex flex-wrap gap-1.5 rounded-lg border border-dashed border-line p-3 min-h-12"
          {...dropProps(null)}
        >
          {unparented.map(pill)}
          {unparented.length === 0 && (
            <span className="text-xs text-ink-3 self-center">
              every brand has a parent — drop one here to make it independent
              again
            </span>
          )}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {parents.map((p) => (
          <div key={p} className="card p-4" {...dropProps(p)}>
            <input
              value={labelDrafts[p] ?? p}
              onChange={(e) =>
                setLabelDrafts({ ...labelDrafts, [p]: e.target.value })
              }
              onBlur={() => {
                const next = (labelDrafts[p] ?? p).trim();
                if (next && next !== p) {
                  post({
                    action: "rename_parent",
                    parent: p,
                    displayName: next,
                  });
                }
                setLabelDrafts((d) => {
                  const rest = { ...d };
                  delete rest[p];
                  return rest;
                });
              }}
              className="w-full bg-transparent text-sm font-semibold mb-2 outline-none border-b border-transparent focus:border-line"
              title="Parent company label — rename applies to all its brands"
            />
            <div className="flex flex-wrap gap-1.5 min-h-9">
              {brands.filter((b) => b.parent === p).map(pill)}
            </div>
          </div>
        ))}
        <div
          className="card p-4 border-dashed grid place-items-center text-xs text-ink-3 min-h-20"
          {...dropProps("__new__")}
        >
          drop a brand here to start a new parent company
        </div>
      </div>
    </div>
  );
}
