// Classify all candidates via the OpenAI Batch API — separate quota pool,
// 50% price, no RPD ceiling. Chunks sequentially; resumable per chunk.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import OpenAI from "/Users/tylersolloway/Documents/GitHub/answerpoll/node_modules/openai/index.mjs";

const DIR =
  "/private/tmp/claude-501/-Users-tylersolloway-Documents-Resondex/31011d25-22ff-456a-afe9-2bb72a192dd2/scratchpad";
const key = readFileSync(
  "/Users/tylersolloway/Documents/GitHub/answerpoll/.env.local",
  "utf8"
)
  .split("\n")
  .find((l) => l.startsWith("OPENAI_API_KEY="))
  ?.slice(15)
  .trim();
const client = new OpenAI({ apiKey: key, timeout: 120_000 });

const prompts = readFileSync(`${DIR}/wc48_candidates.jsonl`, "utf8")
  .trim()
  .split("\n")
  .map((l, i) => ({ i, ...JSON.parse(l) }));

const OUT = `${DIR}/wc48_labeled_batch.jsonl`;
const done = new Set();
if (existsSync(OUT)) {
  for (const l of readFileSync(OUT, "utf8").split("\n")) {
    if (l.trim()) done.add(JSON.parse(l).i);
  }
  console.log(`resuming: ${done.size} already labeled`);
} else {
  writeFileSync(OUT, "");
}
const todo = prompts.filter((p) => !done.has(p.i));
console.log(`to label: ${todo.length}`);

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    commercial: { type: "boolean" },
    theme: {
      type: ["string", "null"],
      enum: ["discovery", "recommendation", "comparison", "use_case", null],
    },
  },
  required: ["commercial", "theme"],
};

const SYSTEM =
  "Label this chat prompt.\n" +
  "commercial=true ONLY if the person is themselves choosing, buying, or " +
  "selecting a real product, service, app, tool, brand, or provider for actual " +
  "use — shopping or vendor-selection intent. Services count (banks, insurance, " +
  "schools, hospitals, travel).\n" +
  "commercial=false for: requests to WRITE or GENERATE any content (marketing " +
  "copy, SEO text, product descriptions, listings, reviews, essays, scripts), " +
  "fiction/roleplay, homework, coding help, general knowledge, how-to " +
  "instructions, business ideas, and anything where no real purchase/selection " +
  "decision is being made.\n" +
  "If commercial=true, also label theme: 'discovery' (what exists / best-of), " +
  "'recommendation' (advice for their situation), 'comparison' (weighing named " +
  "or implied alternatives), 'use_case' (constraint-driven: budget, " +
  "reliability, specific scenario). If commercial=false, theme=null.";

const CHUNK = 4500;
const byIndex = new Map(prompts.map((p) => [p.i, p]));

for (let c = 0; c * CHUNK < todo.length; c++) {
  const chunk = todo.slice(c * CHUNK, (c + 1) * CHUNK);
  const lines = chunk.map((p) =>
    JSON.stringify({
      custom_id: String(p.i),
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: p.text.slice(0, 600) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "label", strict: true, schema: SCHEMA },
        },
      },
    })
  );
  const inputPath = `${DIR}/batch_input_${c}.jsonl`;
  writeFileSync(inputPath, lines.join("\n") + "\n");

  const file = await client.files.create({
    file: new File([readFileSync(inputPath)], `batch_input_${c}.jsonl`),
    purpose: "batch",
  });
  const batch = await client.batches.create({
    input_file_id: file.id,
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
  });
  console.log(`chunk ${c}: batch ${batch.id} submitted (${chunk.length} prompts)`);

  // Poll until terminal.
  let b = batch;
  while (!["completed", "failed", "expired", "cancelled"].includes(b.status)) {
    await new Promise((r) => setTimeout(r, 60_000));
    b = await client.batches.retrieve(batch.id);
    console.log(
      `chunk ${c}: ${b.status} — done ${b.request_counts?.completed ?? 0}/${b.request_counts?.total ?? chunk.length}, failed ${b.request_counts?.failed ?? 0}`
    );
  }
  if (b.status !== "completed") {
    console.log(`chunk ${c}: TERMINAL ${b.status} — ${JSON.stringify(b.errors ?? {}).slice(0, 500)}`);
    process.exit(1);
  }
  const content = await client.files.content(b.output_file_id);
  const text = await content.text();
  const outLines = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const i = Number(r.custom_id);
    const p = byIndex.get(i);
    let label = { commercial: false, theme: null, failed: true };
    const body = r.response?.body;
    if (r.response?.status_code === 200 && body?.choices?.[0]?.message?.content) {
      try {
        label = JSON.parse(body.choices[0].message.content);
      } catch {}
    }
    outLines.push(JSON.stringify({ ...p, ...label }));
  }
  appendFileSync(OUT, outLines.join("\n") + "\n");
  console.log(`chunk ${c}: saved ${outLines.length} labels`);
}
console.log("ALL CHUNKS DONE");
