import { store } from "../store";
import { buildCanonicalizer } from "./metrics";
import { apiKeyConfigured, openaiClient } from "./providers";

const HEALTH_MODEL = process.env.SUGGEST_MODEL ?? "gpt-5-mini";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          // Anchors each verdict to its prompt. Position alone silently
          // attached flags to the wrong prompt whenever the model returned
          // results short, long, or out of order.
          id: { type: "string" },
          defective: { type: "boolean" },
          reason: { type: ["string", "null"] },
          alternatives: { type: "array", items: { type: "string" } },
        },
        required: ["id", "defective", "reason", "alternatives"],
      },
    },
  },
  required: ["results"],
} as const;

/**
 * Post-run health check: a prompt whose answers recall mostly out-of-category
 * brands was probably measuring the wrong conversation. Runs after every
 * completed run — a battery that was healthy at launch can drift as the
 * assistants change — flagging defective prompts and proposing anchored
 * alternatives for refielding. Flags are advisory and recomputed each run;
 * nothing is retired automatically.
 */
export async function analyzePromptHealth(
  projectId: string,
  runId: string
): Promise<void> {
  if (!apiKeyConfigured()) return;
  const project = await store.getProject(projectId);
  if (!project) return;
  const [prompts, responses, mentions, dictionary] = await Promise.all([
    store.listPrompts(projectId),
    store.listResponses(runId),
    store.listMentionsForRun(runId),
    store.getDictionary(projectId),
  ]);
  const canon = buildCanonicalizer(dictionary);

  const unbranded = prompts.filter((p) => p.theme !== "branded" && !p.retired);
  const mentionsByResponse = new Map<string, string[]>();
  for (const m of mentions) {
    const list = mentionsByResponse.get(m.response_id) ?? [];
    list.push(canon.canonical(m.brand));
    mentionsByResponse.set(m.response_id, list);
  }
  // Weigh brands by how many answers named them, not by how many distinct
  // names appeared. A prompt whose answers are overwhelmingly on-category but
  // which picked up a long tail of one-off strays used to read as heavily
  // defective, because every stray counted the same as the category leader.
  const perPrompt = unbranded.map((p) => {
    const rows = responses.filter((r) => r.prompt_id === p.id);
    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const b of new Set(mentionsByResponse.get(r.id) ?? [])) {
        counts.set(b, (counts.get(b) ?? 0) + 1);
      }
    }
    const brands = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([brand, answers]) => ({ brand, answers }));
    return { prompt: p, answers: rows.length, brands };
  });

  const res = await openaiClient().chat.completions.create({
    model: HEALTH_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You audit a brand-visibility study's prompts after a run. " +
          `The study measures the category "${project.category}". For each ` +
          "prompt you get its id, how many answers it collected, and the " +
          "brands those answers recalled with the number of answers naming " +
          "each. Judge by that weight, not by the length of the brand list: " +
          "one stray brand named in a single answer is noise, while a " +
          "non-category brand named in most answers is evidence. Echo each " +
          "prompt's id back on its result. Mark a " +
          "prompt defective=true when a substantial share of recall " +
          "is OUTSIDE the category — evidence the prompt was read as being " +
          "about something broader or different (e.g. it asked for 'a tool' " +
          "without naming the category at all, so answers ranged across " +
          "unrelated kinds of product). A few stray adjacent brands in an " +
          "otherwise " +
          "on-category answer set are normal — do not flag those. For each " +
          "defective prompt: reason = one plain sentence naming what the " +
          "answers drifted to; alternatives = exactly 2 rewritten prompts " +
          "that keep the original intent, length, and casual register but " +
          "anchor the category unmistakably. Never include brand names in " +
          "alternatives. For healthy prompts: reason=null, alternatives=[]. " +
          "Return one result per prompt.",
      },
      {
        role: "user",
        content: JSON.stringify(
          perPrompt.map((x) => ({
            id: x.prompt.id,
            prompt: x.prompt.text,
            answers: x.answers,
            recalled_brands: x.brands,
          }))
        ),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "health", strict: true, schema: SCHEMA },
    },
  });
  const results = (
    JSON.parse(res.choices[0]?.message?.content ?? '{"results":[]}') as {
      results: {
        id: string;
        defective: boolean;
        reason: string | null;
        alternatives: string[];
      }[];
    }
  ).results;

  // Match on the prompt's own id. A verdict whose id we did not send is
  // discarded rather than guessed at, and a prompt the model skipped keeps
  // whatever flag it already had instead of inheriting its neighbour's.
  const byId = new Map(results.map((r) => [r.id, r]));
  let flagged = 0;
  let matched = 0;
  for (const x of perPrompt) {
    const r = byId.get(x.prompt.id);
    if (!r) continue;
    matched++;
    if (r.defective) flagged++;
    await store.setPromptFlag(
      x.prompt.id,
      r.defective
        ? {
            reason: r.reason ?? "answers drifted off-category",
            alternatives: r.alternatives.slice(0, 2),
          }
        : null
    );
  }
  if (matched !== perPrompt.length) {
    console.warn(
      `prompt health check (${project.brand}): ${perPrompt.length - matched} of ${perPrompt.length} prompts got no verdict — their flags are unchanged`
    );
  }
  console.log(
    `prompt health check (${project.brand}): ${flagged}/${matched} prompts flagged`
  );
}
