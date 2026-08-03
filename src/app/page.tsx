"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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

  return (
    <div className="grid gap-12 lg:grid-cols-[7fr_5fr]">
      <section>
        <h1 className="text-[2rem] leading-tight font-semibold tracking-tight mb-3">
          When buyers ask AI, who gets{" "}
          <em className="font-serif text-primary">named</em>?
        </h1>
        <p className="text-[15px] text-ink-2 mb-8 leading-relaxed max-w-lg">
          Answerpoll asks an LLM the questions your buyers ask — sampled
          repeatedly, so every rate carries a confidence interval — and measures
          how often you get named, where you rank, and how you&apos;re framed.
        </p>

        <form onSubmit={onSubmit} className="card p-6 grid gap-4 max-w-lg">
          <div className="section-label">New tracker</div>
          <label className="grid gap-1.5 text-sm font-medium">
            Your brand
            <input
              className="input"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="e.g. Resondex"
              required
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Category
            <input
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. market research firms"
              required
            />
            <span className="text-xs font-normal text-ink-3">
              plural, phrased the way a buyer would say it
            </span>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Competitors
            <input
              className="input"
              value={competitors}
              onChange={(e) => setCompetitors(e.target.value)}
              placeholder="e.g. Qualtrics, Ipsos, Kantar"
            />
            <span className="text-xs font-normal text-ink-3">
              comma-separated — brands the model volunteers get tracked too
            </span>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Audience <span className="font-normal text-ink-3">(optional)</span>
            <input
              className="input"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="e.g. mid-market CPG brands"
            />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary w-fit"
          >
            {submitting ? "Creating…" : "Create tracker"}
          </button>
        </form>
      </section>

      <section>
        <h2 className="section-label mb-3">Trackers</h2>
        {!loaded ? (
          <div className="grid gap-2">
            <div className="card h-[72px] animate-pulse" />
            <div className="card h-[72px] animate-pulse" />
          </div>
        ) : projects.length === 0 ? (
          <div className="card px-5 py-8 text-center text-sm text-ink-3">
            Your first tracker will appear here.
          </div>
        ) : (
          <ul className="grid gap-2">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}`}
                  className="card block px-5 py-4 transition-colors hover:border-primary"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-semibold text-[15px]">{p.name}</span>
                    <RunHint run={p.latestRun} />
                  </div>
                  <div className="text-[13px] text-ink-2 mt-1">
                    {p.brand} · {p.category}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunHint({ run }: { run: Run | null }) {
  if (!run) return <span className="text-xs text-ink-3">ready to run</span>;
  const map: Record<Run["status"], { label: string; cls: string }> = {
    pending: { label: "queued", cls: "text-ink-3" },
    running: { label: "running", cls: "text-primary" },
    complete: { label: "measured", cls: "text-success" },
    failed: { label: "run failed", cls: "text-danger" },
  };
  const s = map[run.status];
  return <span className={`text-xs font-medium ${s.cls}`}>{s.label}</span>;
}
