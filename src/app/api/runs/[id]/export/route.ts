import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { computeRunMetrics } from "@/lib/engine/metrics";

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: (string | number | null)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

/**
 * Download a run's results.
 *   ?format=json               — full metrics payload
 *   ?format=csv&table=brands   — brand summary (default table)
 *   ?format=csv&table=prompts  — per-prompt target visibility
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const run = await store.getRun(id);
  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const [metrics, project] = await Promise.all([
    computeRunMetrics(id),
    store.getProject(run.project_id),
  ]);
  if (!metrics || !project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "csv";
  const table = url.searchParams.get("table") ?? "brands";
  const stamp = (run.completed_at ?? run.created_at).slice(0, 10);
  const slug = project.brand.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  if (format === "json") {
    return new NextResponse(
      JSON.stringify({ project, run, metrics }, null, 2),
      {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="answerpoll_${slug}_${stamp}.json"`,
        },
      }
    );
  }

  let rows: (string | number | null)[][];
  if (table === "prompts") {
    rows = [
      ["prompt", "theme", "responses", "target_mentions", "target_rate", "target_avg_position"],
      ...metrics.prompts.map((p) => [
        p.text,
        p.theme,
        p.responses,
        p.targetMentions,
        p.targetRate.toFixed(4),
        p.targetAvgRank?.toFixed(2) ?? null,
      ]),
    ];
  } else {
    rows = [
      ["brand", "type", "mention_count", "mention_rate", "ci_low", "ci_high", "avg_position", "share_of_voice", "recommended", "mentioned", "negative"],
      ...metrics.brands.map((b) => [
        b.brand,
        b.isTarget ? "target" : b.isCompetitor ? "competitor" : "emerged",
        b.mentionCount,
        b.mentionRate.toFixed(4),
        b.ciLow.toFixed(4),
        b.ciHigh.toFixed(4),
        b.avgRank?.toFixed(2) ?? null,
        b.shareOfVoice.toFixed(4),
        b.framing.recommended,
        b.framing.mentioned,
        b.framing.negative,
      ]),
    ];
  }

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="answerpoll_${slug}_${table}_${stamp}.csv"`,
    },
  });
}
