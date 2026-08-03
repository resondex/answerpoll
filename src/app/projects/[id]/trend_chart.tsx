"use client";

import type { ProjectTrend } from "@/lib/types";

const W = 640;
const H = 240;
const PAD = { top: 16, right: 120, bottom: 28, left: 40 };
const MAX_COMPETITOR_LINES = 4;

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Highlight-one trend chart: the target brand is the single accent-colored
 * line (with its CI band); competitors are uniform gray lines identified by
 * direct labels at the line ends — identity rides on labels, never on color.
 */
export default function TrendChart({ trend }: { trend: ProjectTrend }) {
  const { runs, series } = trend;
  const target = series.find((s) => s.isTarget)!;
  const competitors = series
    .filter((s) => !s.isTarget)
    .sort(
      (a, b) =>
        (b.points[b.points.length - 1]?.rate ?? 0) -
        (a.points[a.points.length - 1]?.rate ?? 0)
    );
  const shown = competitors.slice(0, MAX_COMPETITOR_LINES);
  const hidden = competitors.length - shown.length;

  const yMax = Math.max(
    0.1,
    ...[target, ...shown].flatMap((s) => s.points.map((p) => p.ciHigh ?? p.rate))
  );
  const x = (i: number) =>
    runs.length === 1
      ? (PAD.left + W - PAD.right) / 2
      : PAD.left + (i / (runs.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / yMax) * (H - PAD.top - PAD.bottom);

  const path = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");

  // CI band polygon for the target: ciHigh forward, ciLow back.
  const band = [
    ...target.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.ciHigh)}`),
    ...target.points
      .map((p, i) => `L${x(i)},${y(p.ciLow)}`)
      .reverse(),
    "Z",
  ].join(" ");

  // End labels with simple collision avoidance (14px minimum gap).
  const labels = [target, ...shown]
    .map((s) => ({
      brand: s.brand,
      isTarget: s.isTarget,
      yPos: y(s.points[s.points.length - 1].rate),
    }))
    .sort((a, b) => a.yPos - b.yPos);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].yPos - labels[i - 1].yPos < 14) {
      labels[i].yPos = labels[i - 1].yPos + 14;
    }
  }

  const gridValues = [0, 0.25, 0.5, 0.75, 1].filter((v) => v <= yMax * 1.02);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`Mention rate across ${runs.length} runs`}
      >
        {gridValues.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--line)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 8}
              y={y(v) + 4}
              textAnchor="end"
              fontSize="11"
              fill="var(--ink-3)"
            >
              {pct(v)}
            </text>
          </g>
        ))}

        <path d={band} fill="var(--primary)" opacity="0.12" />

        {shown.map((s) => (
          <g key={s.brand}>
            <path
              d={path(s.points.map((p) => p.rate))}
              fill="none"
              stroke="var(--neutral-bar)"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            {s.points.map((p, i) => (
              <circle
                key={i}
                cx={x(i)}
                cy={y(p.rate)}
                r="6"
                fill="transparent"
              >
                <title>{`${s.brand} — ${runs[i].date}: ${pct(p.rate)} (95% CI ${pct(p.ciLow)}–${pct(p.ciHigh)})`}</title>
              </circle>
            ))}
          </g>
        ))}

        <path
          d={path(target.points.map((p) => p.rate))}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {target.points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.rate)} r="4" fill="var(--primary)">
            <title>{`${target.brand} — ${runs[i].date}: ${pct(p.rate)} (95% CI ${pct(p.ciLow)}–${pct(p.ciHigh)})`}</title>
          </circle>
        ))}

        {labels.map((l) => (
          <text
            key={l.brand}
            x={W - PAD.right + 10}
            y={l.yPos + 4}
            fontSize="12"
            fontWeight={l.isTarget ? 600 : 400}
            fill={l.isTarget ? "var(--primary)" : "var(--ink-3)"}
          >
            {l.brand}
          </text>
        ))}

        {runs.map((r, i) => (
          <text
            key={r.runId}
            x={x(i)}
            y={H - 8}
            textAnchor="middle"
            fontSize="11"
            fill="var(--ink-3)"
          >
            {r.date.slice(5)}
          </text>
        ))}
      </svg>
      <p className="text-xs text-ink-3 mt-2">
        Mention rate per run · shaded band is the {target.brand} 95% confidence
        interval
        {hidden > 0
          ? ` · top ${MAX_COMPETITOR_LINES} competitors shown, ${hidden} more in the summary table`
          : ""}
        .
      </p>
    </div>
  );
}
