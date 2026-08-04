// Per-prompt commercial-intent classification — no batch alignment risk.
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
const client = new OpenAI({ apiKey: key });

const prompts = readFileSync(`${DIR}/wildchat_prompts.jsonl`, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l).text);

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { commercial: { type: "boolean" } },
  required: ["commercial"],
};

const SYSTEM =
  "Label this chat prompt. commercial=true ONLY if the person is seeking " +
  "recommendations, comparisons, or advice about choosing, buying, or selecting " +
  "real-world products, services, tools, apps, companies, or providers for actual " +
  "use — shopping or vendor-selection intent. Everything else is false: fiction, " +
  "roleplay, homework, math, coding help, translations, general knowledge, how-to " +
  "instructions, content-writing requests, image-generation prompts.";

async function classify(text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text.slice(0, 500) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "label", strict: true, schema: SCHEMA },
        },
      });
      return JSON.parse(res.choices[0].message.content).commercial;
    } catch {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return false;
}

const results = new Array(prompts.length);
let cursor = 0;
let done = 0;
async function worker() {
  while (cursor < prompts.length) {
    const i = cursor++;
    results[i] = await classify(prompts[i]);
    if (++done % 400 === 0) console.log(`${done}/${prompts.length}`);
  }
}
await Promise.all(Array.from({ length: 20 }, worker));

const commercial = prompts.filter((_, i) => results[i]);
writeFileSync(
  `${DIR}/commercial_prompts_v2.json`,
  JSON.stringify(commercial, null, 2)
);
console.log(`commercial: ${commercial.length}/${prompts.length}`);
