"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  authEnabledClient,
  createSupabaseBrowser,
} from "@/lib/supabase_browser";

/**
 * Passwordless sign-in, two ways from one email: click the magic link, or
 * type the 6-digit passcode. The passcode path has no redirect dependency,
 * so it works even when the link opens in the wrong browser or the URL
 * allowlist is misconfigured.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createSupabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSent(true);
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createSupabaseBrowser();
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: code.trim(),
      type: "email",
    });
    setBusy(false);
    if (error) {
      setError(
        error.message.includes("expired") || error.message.includes("invalid")
          ? "That code didn't match — check for typos, or request a fresh one."
          : error.message
      );
      return;
    }
    router.push("/app");
    router.refresh();
  }

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-2">Sign in</h1>
      <p className="text-sm text-ink-2 mb-6">
        One email, two ways in: click the link, or type the passcode.
        Passwords stay out of the picture.
      </p>
      {sent ? (
        <div className="card p-6 grid gap-4">
          <div className="text-sm leading-relaxed">
            <p className="font-semibold mb-1">Check your email.</p>
            <p className="text-ink-2">
              We sent a sign-in email to{" "}
              <span className="font-medium">{email}</span>. Click its link, or
              enter the 6-digit passcode here:
            </p>
          </div>
          <form onSubmit={verifyCode} className="grid gap-3">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              className="input w-40 text-center text-xl tracking-[0.4em] font-semibold"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="••••••"
              autoFocus
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex items-center gap-4">
              <button
                type="submit"
                disabled={busy || code.length !== 6}
                className="btn-primary w-fit"
              >
                {busy ? "Verifying…" : "Sign in"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSent(false);
                  setCode("");
                  setError(null);
                }}
                className="text-sm text-ink-3 hover:text-ink"
              >
                use a different email
              </button>
            </div>
          </form>
        </div>
      ) : (
        <form onSubmit={sendCode} className="card p-6 grid gap-4">
          <label className="grid gap-1.5 text-sm font-medium">
            Email
            <input
              type="email"
              className="input w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
            />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="submit" disabled={busy} className="btn-primary w-fit">
            {busy ? "Sending…" : "Email me a sign-in code"}
          </button>
        </form>
      )}
    </div>
  );
}
