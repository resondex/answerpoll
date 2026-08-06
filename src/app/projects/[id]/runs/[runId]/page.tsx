import { redirect } from "next/navigation";

/**
 * The run dashboard merged into the tracker page — old deep links land on
 * the unified dashboard with the requested run selected.
 */
export default async function RunRedirect({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;
  redirect(`/projects/${id}?run=${runId}`);
}
