import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Answerpoll — how AI assistants rank your brand",
  description:
    "Measure how often LLMs mention and recommend your brand for the searches your buyers actually make.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#f9f9f7] text-[#0b0b0b] dark:bg-[#0d0d0d] dark:text-white">
        <header className="border-b border-black/10 dark:border-white/10 bg-[#fcfcfb] dark:bg-[#1a1a19]">
          <div className="mx-auto max-w-5xl px-6 py-4 flex items-baseline gap-3">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Answerpoll
            </Link>
            <span className="text-sm text-[#52514e] dark:text-[#c3c2b7]">
              how AI assistants rank your brand
            </span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl px-6 py-8 flex-1">
          {children}
        </main>
      </body>
    </html>
  );
}
