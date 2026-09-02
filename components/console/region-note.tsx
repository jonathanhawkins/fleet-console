import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * One line of quiet copy, centred in a region that has nothing to show.
 *
 * Deliberately not a shimmering skeleton: a skeleton animates a load, and most
 * of the states this covers are not loads — they are an empty alert feed, a
 * fleet that has not reported in, a map waiting on a connection. Saying so in
 * a sentence is both honest and calmer than a pulsing grey rectangle.
 */
export type RegionNoteProps = React.ComponentPropsWithoutRef<"div">;

export function RegionNote({ className, children, ...props }: RegionNoteProps) {
  return (
    <div
      data-slot="region-note"
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center px-6 py-10",
        className,
      )}
      {...props}
    >
      <p className="max-w-[30ch] text-center text-small text-balance text-ink-soft">
        {children}
      </p>
    </div>
  );
}
