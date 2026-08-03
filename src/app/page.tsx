"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Project, Run } from "@/lib/types";

type ProjectWithRun = Project & { latestRun: Run | null };

export default function HomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectWithRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [audience, setAudience] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .finally(() => setLoaded(true));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand,
        category,
        audience: audience || undefined,
        competitors: competitors
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
      }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!res.ok) {
      setError(data.error ?? "something went wrong");
      return;
    }
    router.push(`/projects/${data.project.id}`);
  }

  const inputCls =
    "w-full rounded-md border border-black/15 dark:border-white/15 bg-white dark:bg-[#1a1a19] px-3 py-2 text-sm outline-none focus:border-[#2a78d6] dark:focus:border-[#3987e5]";

  return (
    <div className="grid gap-10 md:grid-cols-[1fr_1fr]">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight mb-2">
          Where does your brand rank when buyers ask AI?
        </h1>
        <p className="text-sm text-[#52514e] dark:text-[#c3c2b7] mb-6 leading-relaxed">
          Answerpoll asks an LLM the questions your buyers ask — repeatedly, so
          the answer is a measurement, not an anecdote — then scores how often
          you and your competitors get mentioned, where you rank, and how
          you&apos;re framed.
        </p>
        <form onSubmit={onSubmit} className="grid gap-4">
          <label className="grid gap-1 text-sm font-medium">
            Your brand
            <input
              className={inputCls}
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="e.g. Resondex"
              required
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Category (plural, as a buyer would say it)
            <input
              className={inputCls}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. market research firms"
              required
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Competitors (comma-separated)
            <input
              className={inputCls}
              value={competitors}
              onChange={(e) => setCompetitors(e.target.value)}
              placeholder="e.g. Qualtrics, Ipsos, Kantar"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Audience <span className="font-normal text-[#898781]">(optional)</span>
            <input
              className={inputCls}
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="e.g. mid-market CPG brands"
            />
          </label>
          {error && <p className="text-sm text-[#d03b3b]">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-[#2a78d6] dark:bg-[#3987e5] text-white px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 w-fit"
          >
            {submitting ? "Creating…" : "Create tracker"}
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#898781] mb-3">
          Trackers
        </h2>
        {!loaded ? (
          <p className="text-sm text-[#898781]">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-[#898781]">
            No trackers yet — create one to get started.
          </p>
        ) : (
          <ul className="grid gap-2">
            {projects.map((p) => (
              <li key={p.id}>
                <a
                  href={`/projects/${p.id}`}
                  className="block rounded-lg border border-black/10 dark:border-white/10 bg-[#fcfcfb] dark:bg-[#1a1a19] px-4 py-3 hover:border-[#2a78d6] dark:hover:border-[#3987e5]"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-sm">{p.name}</span>
                    <span className="text-xs text-[#898781]">
                      {p.latestRun
                        ? `last run: ${p.latestRun.status}`
                        : "no runs yet"}
                    </span>
                  </div>
                  <div className="text-xs text-[#52514e] dark:text-[#c3c2b7] mt-1">
                    {p.brand} · {p.category}
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
