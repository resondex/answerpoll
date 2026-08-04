# Prompt-style calibration research

The battery generator's style targets are calibrated to real commercial
prompts, measured from the WildChat-1M corpus of actual ChatGPT
conversations (AI2). Pipeline:

1. `sample_wildchat.py` — random sample of English first-turn user prompts
   via the Hugging Face datasets-server API (seed=42, reproducible).
2. `classify_v2.mjs` — per-prompt LLM screen for genuine commercial /
   vendor-selection intent, plus a content-writing exclusion pass.
3. Aggregate style statistics → `src/lib/engine/style_profile.json`
   (length percentiles, casing, punctuation, person, sentence counts).
   These numbers are quantitative targets in the generation prompt.
4. `judge_pairs.mjs` — forced-choice realism test: a judge model sees one
   real and one generated prompt and must pick the fake. Chance (50%) means
   indistinguishable. Current calibrated generator: at/below chance.

Raw sampled prompts are NOT committed — WildChat's license (AI2 ImpACT)
permits our analysis but redistribution of conversation text is avoided.
Only aggregate statistics ship. Finding for context: genuine commercial
intent appears in roughly 1% of English first turns, so scaling the
calibration n requires sampling ~50–100k conversations.
