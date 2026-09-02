"use client";

import { cn } from "@/lib/utils";
import { jointLabel } from "@/components/console";

// The expansion's two controls. Comparison is offered only expanded: at 56 px
// the pair comparison is a glance down a column of the grid; expanding is the
// moment an operator measures one thing, and the only moment a second trace
// answers a question rather than adding a line.

/** A toggle (`aria-pressed`) that turns a layer of a drawing on and off; the name says which joint. */
export function CompareToggle({
  mirror,
  comparing,
  onToggle,
}: {
  mirror: string;
  comparing: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={comparing}
      aria-label={`Overlay ${jointLabel(mirror).toLowerCase()} on this trace for comparison`}
      data-slot="strip-compare"
      className={cn(
        "-mr-1.5 shrink-0 rounded-md px-1.5 text-label whitespace-nowrap uppercase",
        "transition-colors duration-[var(--dur-press)] ease-console",
        "text-ink-muted hover:bg-surface hover:text-ink-soft",
        "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
        // Pressed reads as a held-down chip: a coloured control over a
        // monochrome overlay would promise a legend that does not exist.
        "aria-pressed:bg-surface aria-pressed:text-ink",
        // An 11px label is a 14px hit target; a thumb needs 44.
        "[@media(pointer:coarse)]:flex [@media(pointer:coarse)]:min-h-11",
        "[@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:px-2.5",
      )}
    >
      Compare {mirror.endsWith("_R") ? "right" : "left"}
    </button>
  );
}

/** Invisible until pointed at or focused, always present on touch; rotates so it keeps its identity. */
export function ExpandCaret({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 8"
      className={cn(
        "size-2 shrink-0 text-ink-muted",
        "opacity-0 transition-[opacity,transform] duration-[var(--dur-micro)] ease-console",
        "group-hover/strip:opacity-100 group-focus-visible/strip:opacity-100",
        "[@media(pointer:coarse)]:opacity-100",
        expanded && "rotate-180 opacity-100",
      )}
    >
      <path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
