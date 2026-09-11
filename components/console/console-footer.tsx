import * as React from "react";
import { DISCLAIMER, REPO_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";

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

/**
 * `children` is the trailing slot beside the disclaimer. The root layout puts
 * the demo's own controls there (the sim reset, from components/fleet) — the
 * footer itself knows nothing about the simulator, which is what lets it
 * render in any composition.
 */
export function ConsoleFooter({ className, children, ...props }: ConsoleFooterProps) {
  return (
    <footer
      data-slot="console-footer"
      className={cn("mt-auto shrink-0 border-t border-line bg-bg", className)}
      {...props}
    >
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-baseline justify-between gap-x-10 gap-y-3 px-5 py-7 sm:px-8 md:px-16 lg:px-24">
        {/* unwrapped: the disclaimer is ~700px at 13px, so it sits on one line
            from tablet up and only wraps where the page is genuinely narrow.
            The source link rides with it rather than with the controls on the
            right: both are statements about what this page is, and neither
            does anything to the fleet. */}
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <p className="text-small text-ink-soft">{DISCLAIMER}</p>
          {/* A text control has no box to compress, so the press is the hover
              treatment arriving on pointer-down — the only feedback a phone,
              where hover never happens, would otherwise get. */}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "rounded-sm text-small text-ink-soft underline-offset-4",
              "transition-colors duration-[var(--dur-micro)] ease-console",
              "hover:text-ink hover:underline",
              "active:text-ink active:underline",
            )}
          >
            Source on GitHub
          </a>
        </div>
        {/* The demo's own controls belong next to the sentence admitting it is
            a demo, at the same volume as that sentence. */}
        {children}
      </div>
    </footer>
  );
}
