import type { Metadata } from "next";
import { Inter, Instrument_Serif } from "next/font/google";
import Link from "next/link";
import { authEnabled, getAuth } from "@/lib/auth";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  style: "italic",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Procerno — how AI assistants rank your brand",
  description:
    "Procerno measures how often AI assistants name your brand for the questions your buyers ask — mention rates, rank, and share of voice, sampled until they're statistics.",
};

function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect x="3" y="12" width="4.4" height="9" rx="2.2" fill="var(--primary)" opacity="0.45" />
      <rect x="9.8" y="7" width="4.4" height="14" rx="2.2" fill="var(--primary)" opacity="0.7" />
      <rect x="16.6" y="2" width="4.4" height="19" rx="2.2" fill="var(--primary)" />
    </svg>
  );
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const auth = await getAuth();
  const signedIn = authEnabled() && auth !== null;
  return (
    <html
      lang="en"
      className={`${inter.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto max-w-5xl px-6 h-14 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2.5">
              <Mark />
              <span className="text-[17px] font-semibold tracking-tight">
                Procerno
              </span>
            </Link>
            <nav className="flex items-center gap-5 text-sm">
              {signedIn ? (
                <>
                  <Link
                    href="/app"
                    className="font-medium text-primary hover:opacity-80"
                  >
                    Trackers
                  </Link>
                  <span className="hidden sm:block text-[13px] text-ink-3">
                    {auth.email}
                  </span>
                  <form action="/auth/signout" method="post">
                    <button
                      type="submit"
                      className="text-[13px] font-medium text-ink-3 hover:text-ink"
                    >
                      Sign out
                    </button>
                  </form>
                </>
              ) : authEnabled() ? (
                <>
                  <Link
                    href="/#pricing"
                    className="text-ink-2 hover:text-ink font-medium"
                  >
                    Pricing
                  </Link>
                  <Link
                    href="/login"
                    className="font-medium text-primary hover:opacity-80"
                  >
                    Sign in
                  </Link>
                </>
              ) : (
                <Link
                  href="/app"
                  className="font-medium text-primary hover:opacity-80"
                >
                  Open app
                </Link>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl px-6 py-10 flex-1">
          {children}
        </main>
        <footer className="border-t border-line">
          <div className="mx-auto max-w-5xl px-6 py-5 flex items-center justify-between text-[13px] text-ink-3">
            <span>© 2026 Procerno</span>
            <span>every answer sampled, every rate with its interval</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
