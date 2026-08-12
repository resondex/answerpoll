import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireAuth, requireRun } from "@/lib/auth";
import { buildCanonicalizer } from "@/lib/engine/metrics";
import { engineMode } from "@/lib/engine/providers";

export const maxDuration = 30;

/**
 * The evidence endpoint: sampled answers with their coding, filtered the way
 * an analyst asks for them. Returns a page of answers plus the true match
 * count, so the reader can always say "showing N of M" — four answers must
 * never look like the whole picture.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const loaded = await requireRun(id, auth);
  if (loaded instanceof NextResponse) return loaded;
  const { run, project } = loaded;

  const q = new URL(req.url).searchParams;
  const promptId = q.get("promptId") || null;
  const engine = q.get("engine") || null;
  const mode = q.get("mode");
  const brand = q.get("brand") || null;
  const framing = q.get("framing") || null; // recommended | mentioned | negative | absent
  const outcome = q.get("outcome") || null; // chosen | lost | no_pick
  const limit = Math.min(Number(q.get("limit") ?? 40), 100);
  const offset = Math.max(Number(q.get("offset") ?? 0), 0);

  const [responses, mentions, prompts, dictionary] = await Promise.all([
    store.listResponses(id),
    store.listMentionsForRun(id),
    store.listPrompts(project.id),
    store.getDictionary(project.id),
  ]);
  const canon = buildCanonicalizer(dictionary);
  const promptById = new Map(prompts.map((p) => [p.id, p]));
  const brandNorm = brand ? canon.norm(brand) : null;

  const byResponse = new Map<string, { brand: string; rank: number; framing: string }[]>();
  for (const m of mentions) {
    const list = byResponse.get(m.response_id) ?? [];
    list.push({ brand: canon.canonical(m.brand), rank: m.rank, framing: m.framing });
    byResponse.set(m.response_id, list);
  }
  for (const list of byResponse.values()) list.sort((a, b) => a.rank - b.rank);

  const brandFramingIn = (responseId: string): string | null => {
    if (!brandNorm) return null;
    const hit = (byResponse.get(responseId) ?? []).find(
      (x) => canon.norm(x.brand) === brandNorm
    );
    return hit ? hit.framing : "absent";
  };

  const matched = responses
    .filter((r) => {
      const p = promptById.get(r.prompt_id);
      if (!p || p.theme === "branded") return false;
      if (promptId && r.prompt_id !== promptId) return false;
      const model = r.model || run.model;
      if (engine && model !== engine) return false;
      if (mode && engineMode(model) !== mode) return false;
      if (brandNorm) {
        const f = brandFramingIn(r.id);
        if (framing === "absent") {
          if (f !== "absent") return false;
        } else if (framing) {
          if (f !== framing) return false;
        } else if (f === "absent") {
          return false; // a brand filter without a framing means "named"
        }
      }
      if (outcome) {
        const pickNorm = r.top_pick_brand ? canon.norm(r.top_pick_brand) : null;
        if (outcome === "no_pick" && r.outcome === "pick") return false;
        if (outcome === "chosen" && (!brandNorm || pickNorm !== brandNorm)) return false;
        if (outcome === "lost") {
          if (r.outcome !== "pick") return false;
          if (brandNorm && pickNorm === brandNorm) return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      const pa = promptById.get(a.prompt_id)!;
      const pb = promptById.get(b.prompt_id)!;
      return (
        prompts.indexOf(pa) - prompts.indexOf(pb) || a.repeat_idx - b.repeat_idx
      );
    });

  const page = matched.slice(offset, offset + limit).map((r) => {
    const p = promptById.get(r.prompt_id)!;
    return {
      id: r.id,
      model: r.model || run.model,
      mode: engineMode(r.model || run.model),
      promptId: r.prompt_id,
      promptText: p.text,
      theme: p.theme,
      repeat: r.repeat_idx + 1,
      outcome: r.outcome,
      topPick: r.top_pick_brand ? canon.canonical(r.top_pick_brand) : null,
      brands: byResponse.get(r.id) ?? [],
      text: r.text,
    };
  });

  return NextResponse.json({
    total: matched.length,
    answers: page,
    prompts: prompts
      .filter((p) => p.theme !== "branded")
      .map((p) => ({ id: p.id, text: p.text })),
    engines: [...new Set(responses.map((r) => r.model || run.model))].sort(),
  });
}
