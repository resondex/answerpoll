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
          defective: { type: "boolean" },
          reason: { type: ["string", "null"] },
          alternatives: { type: "array", items: { type: "string" } },
        },
        required: ["defective", "reason", "alternatives"],
      },
    },
  },
  required: ["results"],
} as const;

/**
 * Post-first-run health check: a prompt whose answers recall mostly
 * out-of-category brands was probably measuring the wrong conversation.
 * Runs once, after a project's first completed run, before the study enters
 * scheduled rotation — flags defective prompts and proposes anchored
 * alternatives for refielding. Flags are advisory; nothing is retired
 * automatically.
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
  const perPrompt = unbranded.map((p) => {
    const rows = responses.filter((r) => r.prompt_id === p.id);
    const brands = [
      ...new Set(rows.flatMap((r) => mentionsByResponse.get(r.id) ?? [])),
    ];
    return { prompt: p, brands };
  });

  const res = await openaiClient().chat.completions.create({
    model: HEALTH_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You audit a brand-visibility study's prompts after its first run. " +
          `The study measures the category "${project.category}". For each ` +
          "prompt you get the distinct brands its answers recalled. Mark a " +
          "prompt defective=true when a substantial share of recalled brands " +
          "are OUTSIDE the category — evidence the prompt was read as being " +
          "about something broader or different (e.g. it said 'a tool' " +
          "without naming the category, so answers covered password managers " +
          "and monitoring). A few stray adjacent brands in an otherwise " +
          "on-category answer set are normal — do not flag those. For each " +
          "defective prompt: reason = one plain sentence naming what the " +
          "answers drifted to; alternatives = exactly 2 rewritten prompts " +
          "that keep the original intent, length, and casual register but " +
          "anchor the category unmistakably. Never include brand names in " +
          "alternatives. For healthy prompts: reason=null, alternatives=[]. " +
          "Return one result per prompt, in order.",
      },
      {
        role: "user",
        content: JSON.stringify(
          perPrompt.map((x) => ({ prompt: x.prompt.text, recalled_brands: x.brands }))
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
        defective: boolean;
        reason: string | null;
        alternatives: string[];
      }[];
    }
  ).results;

  for (let i = 0; i < perPrompt.length; i++) {
    const r = results[i];
    if (!r) continue;
    await store.setPromptFlag(
      perPrompt[i].prompt.id,
      r.defective
        ? {
            reason: r.reason ?? "answers drifted off-category",
            alternatives: r.alternatives.slice(0, 2),
          }
        : null
    );
  }
  const flagged = results.filter((r) => r?.defective).length;
  console.log(
    `prompt health check (${project.brand}): ${flagged}/${perPrompt.length} prompts flagged`
  );
}
