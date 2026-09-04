"use client";

import * as React from "react";
import Link from "next/link";

const isDev = process.env.NODE_ENV !== "production";

/**
 * The page-level error boundary Next wraps around every route's content
 * (app/layout.tsx's chrome — footer, the telemetry provider — survives
 * underneath it; only the page that threw is replaced). This is about a
 * render failing, not a link failing: the transport already has its own
 * honest states for that (ConnectionStatus). What lands here is the same
 * register as app/not-found.tsx on purpose — a console with two rooms
 * (CLAUDE.md) does not grow a third-looking crash page for this either.
 *
 * Every route pays for whatever this file imports — Next bundles a page's
 * error boundary into that route's own client JS, eagerly, so the fallback
 * is ready the instant something throws. `@/components/console` is built for
 * pages that render on the server; pulled into a boundary that is always a
 * client component, its cva/Radix/icon graph stopped being free. The button
 * styling below is that library's actual primary/secondary pill classes,
 * copied by hand rather than imported, so the look is identical and the
 * per-route cost is just this file's own markup.
 *
 * Deliberately does not cover the root layout itself (app/layout.tsx) — this
 * boundary only wraps `children`, and the one concrete way that layout could
 * throw (an unguarded transport construction) is closed at the source in
 * telemetry-provider.tsx instead of behind a second, costlier boundary here.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    if (isDev) console.error("[app/error]", error);
  }, [error]);

  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-5 py-6 sm:px-8 sm:py-8 md:px-16 md:py-10 lg:px-24"
    >
      <div
        role="alert"
        className="flex flex-1 flex-col items-center justify-center gap-7 py-16 text-center"
      >
        <h1 className="text-display text-ink">This page did not load</h1>
        <p className="max-w-[34ch] text-body text-balance text-ink-soft">
          Something in this page failed to render. Try again, or go back to the fleet.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-pill border border-transparent bg-ink px-5 text-small text-bg shadow-[var(--elev-pill)] transition-colors duration-[var(--dur-micro)] ease-console hover:bg-ink-hover"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-pill border border-line-strong bg-bg px-5 text-small text-ink shadow-[var(--elev-pill)] transition-colors duration-[var(--dur-micro)] ease-console hover:bg-surface"
          >
            Back to fleet
          </Link>
        </div>
      </div>
    </main>
  );
}
