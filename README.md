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

Every run executes real queries — `OPENAI_API_KEY` is required to launch one.
A run of 14 prompts × 5 repeats = 70 completions + 70 extraction calls; with
`gpt-5-mini` + `gpt-4o-mini` that's roughly a dollar or two per run.

## Architecture

- **Next.js 16 (App Router)** — UI + API routes in one deployable.
- **Dual-driver storage** behind one async interface (`src/lib/store/`):
  Postgres (`postgres.js`) when `DATABASE_URL` is set — required on Vercel,
  whose serverless filesystem doesn't persist — and zero-config SQLite at
  `data/answerpoll.db` otherwise. Schema is created on first use by either
  driver.
- **`src/lib/engine/`** — the measurement engine, UI-independent:
  - `prompts.ts` — prompt battery generation
  - `providers.ts` — the OpenAI provider behind a provider interface (add
    Anthropic/Perplexity/Gemini here later)
  - `runner.ts` — prompt × repeat execution with concurrency + retry
  - `metrics.ts` — mention rate, Wilson CIs, average rank, share of voice
- Runs execute in-process: fire-and-forget locally, `waitUntil` with
  `maxDuration = 300` on Vercel. Big real runs (high repeats × slow models)
  can approach that ceiling — the eventual fix is a queue or chunked
  processing endpoint.

## Deploying (Vercel)

1. Import `tsolloway/answerpoll` at vercel.com/new (framework auto-detected).
2. Provision a Postgres database — Supabase (use the pooled/pgbouncer
   connection string) or Neon via Vercel's storage marketplace.
3. Set env vars in the Vercel project: `DATABASE_URL`, `OPENAI_API_KEY`.
4. Deploy, then point the `answerpoll.com` DNS (Cloudflare) at Vercel per
   Vercel's domain instructions.

## Roadmap (not yet built)

- More engines: Anthropic, Perplexity (citations → whose content drives
  answers), Gemini.
- Auth + multi-tenancy (Supabase), billing.
- Prompt editing / custom prompts per tracker.

## Scheduled runs

Set "Automatic runs" (weekly/monthly) on a tracker. A daily Vercel cron
(`vercel.json`, 06:00 UTC) launches a run for every tracker that's due.
Requires a `CRON_SECRET` env var in Vercel — any random string; Vercel sends
it as the bearer token on cron invocations and the endpoint rejects
everything else.
