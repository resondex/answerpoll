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
        We email you a sign-in link — no password to remember.
      </p>
      {sent ? (
        <div className="card p-6 grid gap-4">
          <div className="text-sm leading-relaxed">
            <p className="font-semibold mb-1">Check your email.</p>
            <p className="text-ink-2">
              We sent a sign-in link to{" "}
              <span className="font-medium">{email}</span>. Open it on this
              device and you&apos;re in.
            </p>
          </div>
          {/* Whether the email carries a passcode as well as a link is decided
              by the Supabase email template, which cannot be edited on the
              built-in mail service. Leading with the code box asked people for
              something the email did not contain, so the passcode is now a
              fallback the reader opens only if they actually have one. */}
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-3 hover:text-ink">
              Email included a 6-digit code?
            </summary>
          <form onSubmit={verifyCode} className="grid gap-3 mt-3">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              className="input w-40 text-center text-xl tracking-[0.4em] font-semibold"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="••••••"
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
            </div>
          </form>
          </details>
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setCode("");
              setError(null);
            }}
            className="text-sm text-ink-3 hover:text-ink w-fit"
          >
            use a different email
          </button>
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
            {busy ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      )}
    </div>
  );
}
