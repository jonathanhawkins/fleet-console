import type { Metadata } from "next";
import Link from "next/link";
import { ConsoleButton, ConsoleHeader } from "@/components/console";

/**
 * Its own name, so a dead link does not preview as the front door.
 *
 * No address block: this route has no canonical URL to claim — it is whatever
 * was asked for and missing. Next marks the export's 404 `noindex` on its own.
 */
export const metadata: Metadata = {
  title: "Page not found",
  description: "This page is not part of the console. The link may be out of date.",
};

/**
 * Whatever the browser asked for is not one of this console's routes — a
 * mistyped `/unit/N-99`, a stale link to a unit the roster no longer has, a
 * path that never existed. Next writes this into `out/404.html` verbatim for
 * the static export, so it is the ONLY thing an operator with a bad link ever
 * sees; without it that request would fall through to the framework's own
 * unstyled scaffold — a third visual world in a product whose whole thesis is
 * that there are exactly two (CLAUDE.md).
 *
 * Same register as the unit page's own unknown-id state (app/unit/[id]/
 * unit-detail.tsx): a short, centred sentence and one way back, no apology.
 * Built from `@/components/console` alone — the header and the footer
 * disclaimer it renders inside (app/layout.tsx) are the only chrome a route
 * that matched nothing is entitled to.
 */
export default function NotFound() {
  return (
    <>
      <ConsoleHeader />
      <main
        id="main"
        className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-5 py-6 sm:px-8 sm:py-8 md:px-16 md:py-10 lg:px-24"
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-7 py-16 text-center">
          <h1 className="text-display text-ink">Page not found</h1>
          <p className="max-w-[34ch] text-body text-balance text-ink-soft">
            This page is not part of the console. The link may be out of date.
          </p>
          <ConsoleButton variant="secondary" asChild>
            <Link href="/">Back to fleet</Link>
          </ConsoleButton>
        </div>
      </main>
    </>
  );
}
