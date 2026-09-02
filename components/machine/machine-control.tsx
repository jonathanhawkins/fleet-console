"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A control in the board's own vocabulary: one word in a 1px box that inverts
 * while the pointer or the keyboard is on it.
 *
 * There is no ConsoleButton here for the same reason ScanPanel is not a
 * ConsoleCard. ConsoleButton is the operator's pill, and it collapses correctly
 * into machine space — square, mono, uppercase — but its active state is a 15 %
 * phosphor wash, which is what a *button* does when it is dimmed. These are not
 * buttons on a page; they are chips on an instrument, and this instrument
 * already has a word for "this one": the parts manifest stamps DAMAGED by
 * knocking the void out of a solid block (parts-manifest.tsx). Inversion is the
 * board's existing idiom for emphasis, so a control that inverts under the
 * cursor is speaking the language already on screen rather than importing a
 * second one.
 *
 * Two luminance tiers and nothing else — `strong` is a live object (the verdict
 * waiting to be reopened), `soft` is an available action (return, minimize).
 * Both invert to the same phosphor block, because "the cursor is here" is one
 * state, not two.
 *
 * Both tiers draw the same `--line-strong` box, and the tier is carried by the
 * *text*. The dimmer alternative was `--line`, which is `#1c1c1c` — the neutral
 * rule the grid divides panels with, not a step on the phosphor ramp. On the
 * void that is a four percent step, and rendering it proved the point: the
 * minimize control read as a smudge rather than as a box, which is a strange
 * thing for the only way into a feature. Hierarchy here comes from luminance
 * (PRD §5), and a colour from a different family is not a luminance tier.
 */

export interface MachineControlProps extends React.ComponentProps<"button"> {
  /** Resting luminance. `strong` is a live object; `soft` an available action. */
  tone?: "strong" | "soft";
}

export function MachineControl({
  className,
  tone = "soft",
  type = "button",
  ...props
}: MachineControlProps) {
  return (
    <button
      type={type}
      data-slot="machine-control"
      data-tone={tone}
      className={cn(
        "inline-flex h-6 shrink-0 items-center justify-center border px-2",
        "tnum text-label tracking-[0.1em] whitespace-nowrap uppercase",
        "transition-colors duration-[var(--dur-micro)] ease-console",
        // The focus ring is the global machine reticle (globals.css): 1px
        // phosphor at 3px offset, so it still reads as a ring around a block
        // that has itself gone phosphor.
        "hover:border-ink hover:bg-ink hover:text-bg",
        "focus-visible:border-ink focus-visible:bg-ink focus-visible:text-bg",
        "border-line-strong",
        tone === "strong" ? "text-ink" : "text-ink-soft",
        className,
      )}
      {...props}
    />
  );
}
