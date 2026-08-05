# Prompt-style calibration research

The battery generator's style targets are calibrated to real commercial
prompts, measured from the WildChat-1M corpus of actual ChatGPT
conversations (AI2). Pipeline:

Scaled calibration (v4, n=1,006):

1. `sample_wildchat.py` — pilot: random sample of English first-turn user
   prompts from WildChat-1M (seed=42). Found commercial intent in ~1% of
   conversations — the incidence estimate.
2. Full-corpus harvest — 40 commercial query phrases against the
   WildChat-4.8M full-text-search index (Hugging Face datasets-server),
   17,033 unique English first-turn candidates.
3. Classification — every candidate labeled individually by gpt-4o-mini via
   the OpenAI Batch API (commercial/vendor-selection screen with
   content-writing exclusion, plus intent-theme label). 1,006 verified
   commercial prompts (harvest precision 5.9%).
4. Aggregate statistics → `src/lib/engine/style_profile.json`: median 17
   words (bootstrap 95% CI 15–19), 55% under 20 words, 29% over 40, 41.5%
   lowercase starts, 65% no terminal punctuation, 24.5% multi-sentence.
   Theme shares: discovery 58.8%, recommendation 27.3%, comparison 7.8%,
   use_case 6.1% — the generator's 7/3/1/1 battery quota comes from these.
5. `judge_pairs.mjs` — forced-choice realism test (one real + one generated,
   judge must pick the fake; 50% = indistinguishable). v4 across 5
   categories, 50 pairs: judge caught the fake 28% ± 12pp — significantly
   BELOW chance. Honest reading: the sets are separable, with inverted
   labels — generated prompts are systematically judged more polished/human
   than real traffic, which is full of typos and non-native grammar.
6. Messiness experiment (`run_messiness_experiment.mjs`,
   `analyze_messiness.py`) — does that residual polish gap bias the
   measurement? Paired batteries, identical semantics: clean vs messified
   (typos, grammar slips, casing errors). 12 prompts x 10 repeats x 2
   conditions = 240 answers, full completion+extraction pipeline. Result:
   no significant mention-rate difference for any top-10 brand (largest gap
   7pp, all p > 0.29 before correction), identical brands-per-answer
   (10.1 vs 10.2). Surface messiness does not change brand visibility
   measurements, so the battery's polish is a disclosed non-issue rather
   than a bias. (Power: ~18pp detectable at 80%, n=120/condition;
   single sector — team messaging apps.)

Caveats: keyword-conditioned harvest (calibrates the style/theme mix of
commercial prompts, not their incidence); search index flagged partial by
HF; residual classification noise ~10%; single-family classifier (OpenAI) —
cross-provider validation with a Claude judge is the planned next step.
Raw prompts are NOT committed — WildChat's license (AI2 ImpACT) permits our
analysis but redistribution of conversation text is avoided; only aggregate
statistics ship.
