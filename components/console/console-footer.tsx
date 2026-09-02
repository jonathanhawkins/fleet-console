import * as React from "react";
import { DISCLAIMER } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { SimReset } from "./sim-reset";

/**
 * The disclaimer, on every page, from the root layout (CLAUDE.md
 * non-negotiable #5). Rendering it here rather than per page is the only way
 * that promise stays true as routes are added.
 *
 * Quiet, but --ink-soft rather than --muted: at 13px the muted grey is 3.31:1
 * and under AA. Legal-ish copy is exactly the copy that must not be the least
 * readable thing on the page.
 */
export type ConsoleFooterProps = React.ComponentPropsWithoutRef<"footer">;

export function ConsoleFooter({ className, ...props }: ConsoleFooterProps) {
  return (
    <footer
      data-slot="console-footer"
      className={cn("mt-auto shrink-0 border-t border-line bg-bg", className)}
      {...props}
    >
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-baseline justify-between gap-x-10 gap-y-3 px-5 py-7 sm:px-8 md:px-16 lg:px-24">
        {/* unwrapped: the disclaimer is ~700px at 13px, so it sits on one line
            from tablet up and only wraps where the page is genuinely narrow */}
        <p className="text-small text-ink-soft">{DISCLAIMER}</p>
        {/* The demo's own controls belong next to the sentence admitting it is
            a demo, at the same volume as that sentence. */}
        <SimReset />
      </div>
    </footer>
  );
}
