import { store } from "../store";
import { computeRunMetrics, wilson } from "./metrics";
import type { ProjectTrend, TrendPoint, TrendSeries } from "../types";

/**
 * Mention rate, CI, and share of voice for the target brand and each named
 * competitor across every completed run, oldest first — the data behind the
 * trend chart and run-over-run deltas.
 */
export async function computeProjectTrend(
  projectId: string
): Promise<ProjectTrend | null> {
  const project = await store.getProject(projectId);
  if (!project) return null;
  const completed = (await store.listRuns(projectId))
    .filter((r) => r.status === "complete")
    .reverse();

  const tracked = [
    { brand: project.brand, isTarget: true },
    ...project.competitors.map((c) => ({ brand: c, isTarget: false })),
  ];
  const series: TrendSeries[] = tracked.map((t) => ({ ...t, points: [] }));
  const runs: ProjectTrend["runs"] = [];

  for (const run of completed) {
    const m = await computeRunMetrics(run.id);
    if (!m) continue;
    runs.push({
      runId: run.id,
      date: (run.completed_at ?? run.created_at).slice(0, 10),
      model: run.model,
      unbranded: m.unbrandedResponses,
    });
    const byNorm = new Map(
      m.brands.map((b) => [b.brand.trim().toLowerCase(), b])
    );
    for (const s of series) {
      const stats = byNorm.get(s.brand.trim().toLowerCase());
      let point: TrendPoint;
      if (stats) {
        point = {
          rate: stats.mentionRate,
          ciLow: stats.ciLow,
          ciHigh: stats.ciHigh,
          shareOfVoice: stats.shareOfVoice,
        };
      } else {
        // Zero mentions this run — absent from the metrics, present in the trend.
        const ci = wilson(0, m.unbrandedResponses);
        point = { rate: 0, ciLow: ci.low, ciHigh: ci.high, shareOfVoice: 0 };
      }
      s.points.push(point);
    }
  }

  return { runs, series };
}
