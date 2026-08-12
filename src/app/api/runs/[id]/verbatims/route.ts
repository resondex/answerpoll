import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getPlanFor, requireAuth, requireRun } from "@/lib/auth";
import { buildCanonicalizer } from "@/lib/engine/metrics";
import { apiKeyConfigured, openaiClient } from "@/lib/engine/providers";

export const maxDuration = 120;
const CACHE_MS = 365 * 24 * 3600 * 1000;

/**
 * On-demand negative-verbatim extraction for any brand: a second read of the
 * stored answers, asking only for quotes about the requested brand. Cached
 * per (run, brand, dictionary version); the frozen coder stays frozen.
 * Plan-gated: free has no Risk view; pro reads the client's verbatims (which
 * ship in metrics already); all-brand extraction is the top tiers' feature.
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
  const brand = new URL(req.url).searchParams.get("brand")?.trim().slice(0, 120);
  if (!brand) return NextResponse.json({ error: "brand required" }, { status: 400 });
  const plan = await getPlanFor(auth);
  if (plan === "free") {
    return NextResponse.json({ error: "upgrade required" }, { status: 402 });
  }
  const dictionary = await store.getDictionary(project.id);
  const canon = buildCanonicalizer(dictionary);
  const norm = canon.norm(brand);
  if (plan !== "enterprise" && norm !== canon.norm(project.brand)) {
    return NextResponse.json(
      { error: "competitor verbatims require a higher tier" },
      { status: 402 }
    );
  }
  if (!apiKeyConfigured()) {
    return NextResponse.json({ error: "extraction unavailable" }, { status: 503 });
  }
  const cacheKey = `verbatims:v1:${id}:${norm}:${project.dictionary_version}`;
  const hit = await store.cacheGet(cacheKey, CACHE_MS);
  if (hit) return NextResponse.json({ verbatims: JSON.parse(hit) });

  const [responses, mentions, prompts] = await Promise.all([
    store.listResponses(id),
    store.listMentionsForRun(id),
    store.listPrompts(project.id),
  ]);
  const promptText = new Map(prompts.map((p) => [p.id, p.text]));
  const negativeIds = new Set(
    mentions
      .filter((m) => m.framing === "negative" && canon.norm(m.brand) === norm)
      .map((m) => m.response_id)
  );
  const rows = responses.filter((r) => negativeIds.has(r.id)).slice(0, 12);
  const display = canon.canonical(brand);
  const client = openaiClient();
  const out = await Promise.all(
    rows.map(async (r) => {
      try {
        const res = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                `From the answer, extract how "${display}" is criticized. Return ` +
                "quote: ONE verbatim sentence (max 200 chars) that frames it " +
                "negatively, and interpretation: one plain sentence on the criticism.",
            },
            { role: "user", content: r.text },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "verbatim",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  quote: { type: ["string", "null"] },
                  interpretation: { type: ["string", "null"] },
                },
                required: ["quote", "interpretation"],
              },
            },
          },
        });
        const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
        return {
          promptText: promptText.get(r.prompt_id) ?? "",
          quote: parsed.quote ?? null,
          interpretation: parsed.interpretation ?? null,
        };
      } catch {
        return { promptText: promptText.get(r.prompt_id) ?? "", quote: null, interpretation: null };
      }
    })
  );
  await store.cacheSet(cacheKey, JSON.stringify(out));
  return NextResponse.json({ verbatims: out, model: run.model });
}
