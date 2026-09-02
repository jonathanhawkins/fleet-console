import * as React from "react";
import { cn } from "@/lib/utils";
import { ProductMark } from "./product-mark";

/**
 * The top bar, shared by every operator route.
 *
 * One thin rule of chrome, in the grammar of the reference nav: mark hard left,
 * everything else hard right, nothing in the middle. Page-specific content —
 * fleet KPIs, unit identity — belongs below it in the page, not in here, so
 * that /unit/[id] can reuse this untouched.
 *
 * The "Simulated data" tag sits with the mark rather than in a corner: it is
 * a statement about the product, not a status of the session, and every screen
 * of this demo has to carry it (PRD §2).
 */
export type ConsoleHeaderProps = React.ComponentPropsWithoutRef<"header">;

function SimulatedTag() {
  return (
    <span className="inline-flex items-center rounded-pill border border-line-strong px-2.5 py-0.5 text-label text-ink-soft uppercase">
      Simulated data
    </span>
  );
}

export function ConsoleHeader({ className, children, ...props }: ConsoleHeaderProps) {
  return (
    <header
      data-slot="console-header"
      className={cn("shrink-0 border-b border-line bg-bg", className)}
      {...props}
    >
      {/* The phone step exists because 32px of gutter on a 375px screen is 17%
          of the display spent on margin. 20px still reads generous next to
          15px body copy, and it is the inset a flush ConsoleCard header already
          uses — so the full-bleed fleet map's label lands on the same left edge
          as everything stacked above and below it. */}
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 sm:px-8 md:px-16 lg:px-24">
        <ProductMark />
        <SimulatedTag />
        {children != null ? (
          <div className="ml-auto flex flex-wrap items-center gap-x-6 gap-y-2">
            {children}
          </div>
        ) : null}
      </div>
    </header>
  );
}
