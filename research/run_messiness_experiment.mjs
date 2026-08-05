// Clean-vs-messy battery experiment via Batch API: completions then extraction.
import { readFileSync, writeFileSync } from "fs";
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

const sector = process.argv[2] ?? "exp_batteries.json";
const exp = JSON.parse(readFileSync(`${DIR}/${sector}`, "utf8"));
const REPEATS = 10;
const RUN_MODEL = "gpt-5-mini";
const stem = sector.replace(".json", "");

async function runBatch(lines, tag) {
  const path = `${DIR}/${stem}_${tag}_input.jsonl`;
  writeFileSync(path, lines.join("\n") + "\n");
  const file = await client.files.create({
    file: new File([readFileSync(path)], `${stem}_${tag}.jsonl`),
    purpose: "batch",
  });
  const batch = await client.batches.create({
    input_file_id: file.id,
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
  });
  console.log(`${tag}: batch ${batch.id} submitted (${lines.length} requests)`);
  let b = batch;
  while (!["completed", "failed", "expired", "cancelled"].includes(b.status)) {
    await new Promise((r) => setTimeout(r, 45_000));
    b = await client.batches.retrieve(batch.id);
    console.log(
      `${tag}: ${b.status} ${b.request_counts?.completed ?? 0}/${b.request_counts?.total ?? lines.length}`
    );
  }
  if (b.status !== "completed") throw new Error(`${tag} terminal: ${b.status}`);
  const content = await client.files.content(b.output_file_id);
  return (await content.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// --- Stage 1: completions ---
const compLines = [];
for (const [cond, prompts] of [["clean", exp.clean], ["messy", exp.messy]]) {
  prompts.forEach((text, pi) => {
    for (let r = 0; r < REPEATS; r++) {
      compLines.push(
        JSON.stringify({
          custom_id: `${cond}_${pi}_${r}`,
          method: "POST",
          url: "/v1/chat/completions",
          body: { model: RUN_MODEL, messages: [{ role: "user", content: text }] },
        })
      );
    }
  });
}
const compResults = await runBatch(compLines, "completions");
const answers = new Map();
for (const r of compResults) {
  const text = r.response?.body?.choices?.[0]?.message?.content ?? "";
  answers.set(r.custom_id, text);
}
writeFileSync(
  `${DIR}/${stem}_answers.json`,
  JSON.stringify([...answers.entries()], null, 2)
);

// --- Stage 2: extraction ---
const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    mentions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          brand: { type: "string" },
          framing: { type: "string", enum: ["recommended", "mentioned", "negative"] },
        },
        required: ["brand", "framing"],
      },
    },
  },
  required: ["mentions"],
};
const extLines = [...answers.entries()]
  .filter(([, text]) => text.length > 0)
  .map(([id, text]) =>
    JSON.stringify({
      custom_id: id,
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You extract brand mentions from an AI assistant's answer. List every " +
              "company, brand, product, or provider name mentioned, in order of first " +
              "appearance. Classify framing: 'recommended' if endorsed/ranked " +
              "favorably, 'negative' if criticized, otherwise 'mentioned'. " +
              `Names to watch for (extract others too): ${exp.knownBrands.join(", ")}.`,
          },
          { role: "user", content: text.slice(0, 16000) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "brand_mentions", strict: true, schema: EXTRACT_SCHEMA },
        },
      },
    })
  );
const extResults = await runBatch(extLines, "extraction");
const rows = [];
for (const r of extResults) {
  const [cond, pi, rep] = r.custom_id.split("_");
  let mentions = [];
  try {
    mentions = JSON.parse(r.response.body.choices[0].message.content).mentions;
  } catch {}
  const seen = new Set();
  mentions = mentions.filter((m) => {
    const k = m.brand.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  rows.push({ cond, prompt: Number(pi), repeat: Number(rep), mentions });
}
writeFileSync(`${DIR}/${stem}_extracted.json`, JSON.stringify(rows, null, 2));
console.log(`EXPERIMENT DATA READY: ${rows.length} answers extracted`);
