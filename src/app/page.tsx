import Link from "next/link";

const STEPS = [
  {
    title: "Ask what buyers ask.",
    body: "Questions calibrated to real buyer conversations - weighted to what's actually asked, validated in the open. You review every prompt before it runs.",
  },
  {
    title: "Sample until it's a statistic.",
    body: "Each prompt runs repeatedly against the model. Repeats capture the answer-to-answer variation, so every rate arrives with a 95% confidence interval.",
  },
  {
    title: "Score who gets named.",
    body: "Every answer is parsed for brand mentions - yours, your competitors', and the ones the model volunteers - with position, framing, and share of voice.",
  },
];

const FEATURES = [
  {
    title: "Brand leaderboard",
    body: "Mention rate and average position for every brand in the conversation - including competitors you didn't know you had.",
  },
  {
    title: "Trend over time",
    body: "Re-run weekly or monthly and watch the line move. Confidence bands show whether a shift is real or sampling noise.",
  },
  {
    title: "Topic rollups",
    body: "Visibility split by question type, so you know whether you're losing discovery questions or comparison questions.",
  },
  {
    title: "Raw data, yours",
    body: "Every sampled answer and every extracted mention downloads as tidy CSV or JSON. Every number we show is reproducible from data you hold.",
  },
];

const TIERS = [
  {
    name: "Free",
    price: "$0",
    cadence: "forever",
    cta: { label: "Start free", href: "/login" },
    highlight: false,
    features: [
      "1 brand tracker",
      "Manual runs on demand",
      "Full dashboard: leaderboard, topics, positions",
      "Raw data exports (CSV + JSON)",
    ],
  },
  {
    name: "Pro",
    price: "$99",
    cadence: "per month",
    cta: { label: "Talk to us", href: "mailto:tyler@resondex.com?subject=Procerno%20Pro" },
    highlight: true,
    features: [
      "5 brand trackers",
      "Scheduled runs - weekly or monthly, automatic",
      "Trend history with confidence bands",
      "Priority support",
      "Early access to new engines as they ship",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    cadence: "annual",
    cta: { label: "Talk to us", href: "mailto:tyler@resondex.com?subject=Procerno%20Enterprise" },
    highlight: false,
    features: [
      "Unlimited trackers",
      "Custom prompt batteries built with you",
      "Analyst-grade reporting by Resondex",
      "Methodology consultation",
    ],
  },
];

export default function LandingPage() {
  return (
    <div className="grid gap-20">
      <section className="text-center max-w-2xl mx-auto pt-8">
        <h1 className="text-[2.6rem] leading-[1.15] font-semibold tracking-tight mb-4">
          When buyers ask AI,
          <br />
          who gets <em className="font-serif text-primary">named</em>?
        </h1>
        <p className="text-[17px] text-ink-2 leading-relaxed mb-8">
          Procerno polls the answer engines. It asks an LLM the questions your
          buyers ask - sampled repeatedly, so every number is a measurement with
          a confidence interval - and scores how often you get named, where you
          rank, and how you&apos;re framed.
        </p>
        <div className="flex items-center justify-center gap-4">
          <Link href="/login" className="btn-primary text-[15px] px-6 py-3">
            Start measuring
          </Link>
          <a
            href="#pricing"
            className="text-[15px] font-medium text-primary hover:opacity-80"
          >
            See pricing →
          </a>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.title} className="card p-6">
            <div className="section-label mb-2">Step {i + 1}</div>
            <h2 className="font-semibold text-[17px] mb-2">{s.title}</h2>
            <p className="text-sm text-ink-2 leading-relaxed">{s.body}</p>
          </div>
        ))}
      </section>

      <section>
        <div className="text-center max-w-xl mx-auto mb-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-2">
            Measurement, engineered.
          </h2>
          <p className="text-[15px] text-ink-2 leading-relaxed">
            LLM answers change every time you ask. One query is an anecdote  - 
            Procerno samples, reports the uncertainty, and hands you the raw
            data behind every number.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="card p-6">
              <h3 className="font-semibold text-[15px] mb-1.5">{f.title}</h3>
              <p className="text-sm text-ink-2 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-2">
            Pricing
          </h2>
          <p className="text-[15px] text-ink-2">
            Start free with one tracker. Grow into scheduled measurement.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3 items-start">
          {TIERS.map((t) => (
            <div
              key={t.name}
              className={`card p-6 ${
                t.highlight ? "border-primary shadow-[0_0_0_1px_var(--primary)]" : ""
              }`}
            >
              <div className="flex items-baseline justify-between mb-4">
                <h3 className="font-semibold text-[17px]">{t.name}</h3>
                {t.highlight && (
                  <span className="rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-semibold text-primary">
                    popular
                  </span>
                )}
              </div>
              <div className="mb-5">
                <span className="text-3xl font-semibold tabular-nums">
                  {t.price}
                </span>
                <span className="text-sm text-ink-3"> {t.cadence}</span>
              </div>
              <ul className="grid gap-2 mb-6">
                {t.features.map((f) => (
                  <li key={f} className="text-sm text-ink-2 flex gap-2">
                    <span className="text-primary font-semibold">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              {t.cta.href.startsWith("/") ? (
                <Link
                  href={t.cta.href}
                  className={t.highlight ? "btn-primary w-full justify-center" : "btn-primary w-full justify-center opacity-90"}
                >
                  {t.cta.label}
                </Link>
              ) : (
                <a href={t.cta.href} className="btn-primary w-full justify-center">
                  {t.cta.label}
                </a>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="text-center max-w-xl mx-auto pb-8">
        <h2 className="text-2xl font-semibold tracking-tight mb-3">
          Your buyers are already asking.
        </h2>
        <p className="text-[15px] text-ink-2 mb-6">
          Find out who the answer engines recommend - and where you stand.
        </p>
        <Link href="/login" className="btn-primary text-[15px] px-6 py-3">
          Start free
        </Link>
      </section>
    </div>
  );
}
