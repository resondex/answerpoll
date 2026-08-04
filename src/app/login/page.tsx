"use client";

import { useState } from "react";
import Link from "next/link";
import {
  authEnabledClient,
  createSupabaseBrowser,
} from "@/lib/supabase_browser";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (!authEnabledClient()) {
    return (
      <div className="max-w-md mx-auto card p-6 text-sm text-ink-2 leading-relaxed">
        Auth is switched off in this environment — the app is open at{" "}
        <Link href="/app" className="font-medium text-primary">
          /app
        </Link>
        . Set the Supabase env vars to enable sign-in.
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const supabase = createSupabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setSending(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSent(true);
  }

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-2">Sign in</h1>
      <p className="text-sm text-ink-2 mb-6">
        A sign-in link lands in your inbox — passwords stay out of the picture.
      </p>
      {sent ? (
        <div className="card p-6 text-sm leading-relaxed">
          <p className="font-semibold mb-1">Check your email.</p>
          <p className="text-ink-2">
            We sent a sign-in link to <span className="font-medium">{email}</span>.
            It signs you straight into your trackers.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="card p-6 grid gap-4">
          <label className="grid gap-1.5 text-sm font-medium">
            Email
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
            />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="submit" disabled={sending} className="btn-primary w-fit">
            {sending ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      )}
    </div>
  );
}
