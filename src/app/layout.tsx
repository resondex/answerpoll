import type { Metadata } from "next";
import { Inter, Instrument_Serif } from "next/font/google";
import Link from "next/link";
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
  title: "Answerpoll — how AI assistants rank your brand",
  description:
    "Answerpoll measures how often AI assistants name your brand for the questions your buyers ask — mention rates, rank, and share of voice, sampled until they're statistics.",
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

export default function RootLayout({ children }: LayoutProps<"/">) {
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
                Answerpoll
              </span>
            </Link>
            <span className="hidden sm:block text-[13px] text-ink-3">
              how AI assistants rank your brand
            </span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl px-6 py-10 flex-1">
          {children}
        </main>
        <footer className="border-t border-line">
          <div className="mx-auto max-w-5xl px-6 py-5 flex items-center justify-between text-[13px] text-ink-3">
            <span>© 2026 Answerpoll</span>
            <span>every answer sampled, every rate with its interval</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
