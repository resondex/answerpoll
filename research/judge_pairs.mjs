// Forced-choice: which of the pair was AI-generated? 50% = indistinguishable.
import { readFileSync } from "fs";
import OpenAI from "/Users/tylersolloway/Documents/GitHub/answerpoll/node_modules/openai/index.mjs";
const key = readFileSync("/Users/tylersolloway/Documents/GitHub/answerpoll/.env.local","utf8").split("\n").find(l=>l.startsWith("OPENAI_API_KEY="))?.slice(15).trim();
const client = new OpenAI({ apiKey: key });
const real = JSON.parse(readFileSync("commercial_prompts_v3_real.json","utf8"));
const v2 = JSON.parse(readFileSync("v2_prompts.json","utf8"));
const v3 = JSON.parse(readFileSync("v3_prompts.json","utf8"));

const SCHEMA = { type:"object", additionalProperties:false, properties:{ ai_generated:{type:"string", enum:["A","B"]} }, required:["ai_generated"] };
// Simple deterministic shuffle for A/B position
function coin(i){ return (i * 2654435761 % 97) % 2 === 0; }

async function pairTest(gen, label) {
  let caught = 0;
  const n = Math.min(real.length, gen.length);
  await Promise.all(Array.from({length: n}, async (_, i) => {
    const genFirst = coin(i);
    const A = genFirst ? gen[i] : real[i];
    const B = genFirst ? real[i] : gen[i];
    const res = await client.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content:
          "One of these two chat prompts was typed by a real human user; the other was AI-generated to imitate a user. Decide which one is AI-generated. You must choose." },
        { role: "user", content: `A: ${A}\n\nB: ${B}` },
      ],
      response_format: { type:"json_schema", json_schema:{ name:"j", strict:true, schema:SCHEMA } },
    });
    const pick = JSON.parse(res.choices[0].message.content).ai_generated;
    const correct = (pick === "A") === genFirst;
    if (correct) caught++;
  }));
  console.log(`${label}: judge caught the fake ${caught}/${n} (${Math.round(100*caught/n)}%) — 50% = indistinguishable`);
}
await pairTest(v2, "v2 (persona)   ");
await pairTest(v3, "v3 (calibrated)");
