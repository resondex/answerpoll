# Answerpoll

**How AI assistants rank your brand.** Answerpoll asks an LLM the questions your
buyers actually ask — repeatedly, so the answer is a measurement rather than an
anecdote — then scores how often your brand and your competitors get mentioned,
where you rank inside the answer, and how you're framed.

Working name; rename freely.

## How it works

1. **Create a tracker** — brand, category (phrased the way a buyer would), named
   competitors, optional audience.
2. **Prompt battery** — ~14 buyer-intent prompts are generated per tracker
   (discovery / recommendation / comparison / use-case themes, plus two branded
   probes). Branded prompts are excluded from headline rates, since asking about
   a brand by name guarantees a mention.
3. **Run** — every prompt is sent to the chosen OpenAI model N times
   (default 5). Repeats capture the stochasticity of LLM answers; more repeats
   mean tighter confidence intervals.
4. **Extraction** — each answer is passed through a cheap structured-output
   extraction call that lists every brand mentioned, in order, with framing
   (recommended / mentioned / negative). Brands the model volunteers on its own
   are captured too, so emergent competitors surface automatically.
5. **Dashboard** — mention rate with a Wilson 95% CI, average in-answer
   position, share of voice, a brand leaderboard, per-prompt breakdown, and
   sample verbatims.

## Running locally

```bash
npm install
cp .env.example .env.local   # add OPENAI_API_KEY for real runs
npm run dev
```

With no `OPENAI_API_KEY`, the app runs in **mock mode**: a synthetic LLM
generates plausible ranked answers so the entire pipeline (runs, extraction,
metrics, dashboard) works with zero API spend. The UI banners mock runs clearly.

A run of 14 prompts × 5 repeats = 70 completions + 70 extraction calls; with
`gpt-5-mini` + `gpt-4o-mini` that's roughly a dollar or two per run.

## Architecture

- **Next.js 16 (App Router)** — UI + API routes in one deployable.
- **SQLite (better-sqlite3)** at `data/answerpoll.db` — zero-config local store.
  The data layer is isolated in `src/lib/db.ts` so a move to Supabase Postgres
  (for hosted multi-tenant SaaS) is a single-file swap.
- **`src/lib/engine/`** — the measurement engine, UI-independent:
  - `prompts.ts` — prompt battery generation
  - `providers.ts` — OpenAI + mock providers behind one interface (add
    Anthropic/Perplexity/Gemini here later)
  - `runner.ts` — prompt × repeat execution with concurrency + retry
  - `metrics.ts` — mention rate, Wilson CIs, average rank, share of voice
- Runs execute in-process (fire-and-forget, UI polls). Fine for local/dev; a
  hosted deployment should move `executeRun` to a queue or background worker
  (Vercel cron + chunked processing, or a small worker on Fly/Railway).

## Roadmap (not yet built)

- More engines: Anthropic, Perplexity (citations → whose content drives
  answers), Gemini.
- Trend view: re-run monthly, chart mention rate over time.
- Auth + multi-tenancy (Supabase), billing, scheduled runs.
- Prompt editing / custom prompts per tracker.
