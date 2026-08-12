"use client";

import { useState } from "react";

/**
 * The shared table norms: every table in the product is sortable by any
 * column and downloadable as csv or Excel, and every hover escapes its
 * scroll container. Kept in one place so the Brief and the Workbench can
 * never drift apart.
 */

export function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number | null)[][]
) {
  const esc = (v: string | number | null) => {
    const x = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function downloadXlsx(
  sheet: string,
  header: string[],
  rows: (string | number | null)[][]
) {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sheet, header, rows }),
  });
  if (!res.ok) return;
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sheet}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Every table's download control: the same rows, either format. */
export function Download({
  name,
  header,
  rows,
}: {
  name: string;
  header: string[];
  rows: () => (string | number | null)[][];
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex justify-end gap-3">
      <button type="button"
        onClick={() => downloadCsv(`${name}.csv`, header, rows())}
        className="text-[12px] font-medium text-primary hover:opacity-80">
        ↓ csv
      </button>
      <button type="button" disabled={busy}
        onClick={async () => {
          setBusy(true);
          await downloadXlsx(name, header, rows());
          setBusy(false);
        }}
        className="text-[12px] font-medium text-primary hover:opacity-80 disabled:opacity-50">
        {busy ? "…" : "↓ excel"}
      </button>
    </div>
  );
}

/** Instant tooltip. Rendered position:fixed so it escapes overflow-x
 * scroll containers (tables) instead of being clipped at their edge. */
export function Tip({ tip, children }: { tip: string; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      className="inline-block"
      onMouseEnter={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.top });
      }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && (
        <span
          style={{
            position: "fixed",
            left: Math.min(
              Math.max(pos.x, Math.min(176, window.innerWidth / 2)),
              window.innerWidth - Math.min(176, window.innerWidth / 2)
            ),
            top: pos.y - 8,
            transform: "translate(-50%, -100%)",
            zIndex: 50,
            maxWidth: Math.min(336, window.innerWidth - 16),
          }}
          className="pointer-events-none w-max rounded-lg border border-line bg-surface px-3 py-2 text-left text-[12px] font-normal normal-case tracking-normal text-ink-2 shadow-lg"
        >
          {tip}
        </span>
      )}
    </span>
  );
}

/** Header text with the sort arrow bound to its final word, so a wrapping
 * label can never drop the arrow onto a line of its own. */
export function HeadLabel({ label, arrow }: { label: string; arrow: string }) {
  const words = label.split(" ");
  const last = words.pop() ?? "";
  return (
    <>
      {words.length > 0 && `${words.join(" ")} `}
      <span className="whitespace-nowrap">
        {last}
        <span className="inline-block w-2.5 text-left">{arrow}</span>
      </span>
    </>
  );
}

export interface Col<T> {
  id: string;
  label: string;
  num?: boolean;
  color?: (r: T) => string | undefined;
  val: (r: T) => string | number | null;
  render?: (r: T) => React.ReactNode;
}

/** Every workbench table: sortable headers, one-click CSV. */
export function SortTable<T>({
  cols,
  rows,
  filename,
  defaultSort,
  onRowClick,
  activeRow,
}: {
  cols: Col<T>[];
  rows: T[];
  filename: string;
  defaultSort?: { id: string; dir: 1 | -1 };
  onRowClick?: (r: T) => void;
  activeRow?: (r: T) => boolean;
}) {
  const [sort, setSort] = useState<{ id: string; dir: 1 | -1 }>(
    defaultSort ?? { id: cols[1]?.id ?? cols[0].id, dir: -1 }
  );
  const col = cols.find((c) => c.id === sort.id);
  const sorted = !col ? rows : [...rows].sort((a, b) => {
    const va = col.val(a);
    const vb = col.val(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
    return sort.dir === 1 ? cmp : -cmp;
  });
  return (
    <div className="mt-3 grid gap-1">
      <Download
        name={filename.replace(/\.csv$/, "")}
        header={cols.map((c) => c.label)}
        rows={() => rows.map((r) => cols.map((c) => c.val(r)))}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
              {cols.map((c, i) => (
                <th
                  key={c.id}
                  onClick={() =>
                    setSort((prev) =>
                      prev.id === c.id
                        ? { id: c.id, dir: prev.dir === 1 ? -1 : 1 }
                        : { id: c.id, dir: -1 }
                    )
                  }
                  className={`py-2 ${i === cols.length - 1 ? "" : "pr-4"} font-semibold cursor-pointer select-none hover:opacity-70 ${c.num ? "text-center" : ""}`}
                >
                  {/* The arrow always occupies its slot, so sorting a
                      different column never re-measures the header. */}
                  <HeadLabel
                    label={c.label}
                    arrow={sort.id === c.id ? (sort.dir === -1 ? "↓" : "↑") : ""}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, ri) => (
              <tr key={ri}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={`border-b border-line/60 ${onRowClick ? "cursor-pointer hover:bg-primary-soft/20" : ""} ${activeRow?.(r) ? "bg-primary-soft/25" : ""}`}>
                {cols.map((c, i) => (
                  <td
                    key={c.id}
                    className={`py-2 ${i === cols.length - 1 ? "" : "pr-4"} ${c.num ? "text-center tabular-nums" : ""}`}
                    style={c.color ? { color: c.color(r) } : undefined}
                  >
                    {c.render ? c.render(r) : c.val(r) ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

