import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { AutoRefresh } from "@/components/client/auto-refresh";
import { THEME_INIT_SCRIPT } from "@/components/client/theme-toggle";
import { SiteHeader } from "@/components/site-header";
import { txt } from "@/lib/format";
import { requestTime } from "@/lib/now";
import { loadSnapshot } from "@/lib/snapshot";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Trading Lab status", template: "%s | Trading Lab" },
  description: "Private, read-only status of the paper-trading research lab.",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0f1519" },
    { media: "(prefers-color-scheme: light)", color: "#f2f4f5" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const result = await loadSnapshot();
  const snap = result.status === "ok" ? result.snapshot : null;
  return (
    <html lang="en-AU" className={`dark ${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <a
          href="#main"
          className="bg-primary text-primary-foreground sr-only z-50 rounded-md px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <SiteHeader result={result} now={requestTime().getTime()} />
        {result.status === "ok" && result.source === "fixture" ? (
          <div className="bg-info-soft text-info border-b">
            <p className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-1.5 text-xs sm:px-6">
              <FlaskConical aria-hidden className="size-3.5" />
              Fixture data (DASHBOARD_FIXTURE=1). Nothing on this page is live.
            </p>
          </div>
        ) : null}
        <main id="main" className="mx-auto grid max-w-6xl gap-5 px-4 py-5 sm:px-6 sm:py-6">
          {children}
        </main>
        <footer className="text-muted-foreground mx-auto max-w-6xl px-4 pb-8 text-xs sm:px-6">
          <p>
            Read-only view: this site cannot place, cancel or change anything.{" "}
            <Link href="/glossary" className="hover:text-foreground underline underline-offset-2">
              Glossary
            </Link>
            .
            {snap ? (
              <>
                {" "}
                Snapshot <span className="font-mono">{txt(snap.run_id)}</span>, schema v{txt(snap.schema_version)},{" "}
                {txt(snap.redaction)} redaction
                {typeof snap.withheld === "number" && snap.withheld > 0 ? `, ${snap.withheld} fields withheld` : ""}.
              </>
            ) : null}
          </p>
        </footer>
        <AutoRefresh />
      </body>
    </html>
  );
}
