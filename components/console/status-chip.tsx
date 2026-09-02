import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * One chip, two grammars.
 *
 * Operator space wants a *quiet* status: a tinted pill in the status colour,
 * legible at a glance across a fleet list and shouting at nobody.
 * Machine space wants the EVA parts-status language: a solid, inverted block —
 * OPERATING on phosphor, DAMAGED on red, near-black text, radius 0.
 *
 * `tone="auto"` (the default) is the interesting one: the same element renders
 * quiet in operator space and inverted in machine space purely through the
 * `machine:` variant, so a chip that descends with the page changes register
 * without the caller knowing which world it is in.
 *
 * `tone="bare"` exists for one specific failure: a list where most rows share
 * the same status. Eight tinted pills reading NOMINAL out-shout the one
 * reading ALERT, which inverts the hierarchy the chip is there to create. Bare
 * drops the ground and keeps the word, so a healthy fleet reads as a quiet
 * column of sage and the exception is the only object on the page.
 */
export const statusChipVariants = cva(
  ["inline-flex items-center rounded-pill text-label uppercase", "whitespace-nowrap"],
  {
    variants: {
      status: {
        nominal: "",
        warn: "",
        alert: "",
      },
      tone: {
        // machine space is denser and square; the pill token already flattens
        // the radius, this tightens the box to match the reference boards.
        auto: "px-2.5 py-1 machine:px-1.5 machine:py-0",
        quiet: "px-2.5 py-1 machine:px-1.5 machine:py-0",
        inverted: "px-2.5 py-1 machine:px-1.5 machine:py-0",
        bare: "px-0 py-1 machine:py-0",
      },
    },
    compoundVariants: [
      // -- quiet: tinted ground, coloured ink -------------------------------
      // *-ink, not the raw palette token: the label is 11px and has to clear AA
      { status: "nominal", tone: "quiet", class: "bg-nominal-tint text-nominal-ink" },
      { status: "warn", tone: "quiet", class: "bg-warn-tint text-warn-ink" },
      { status: "alert", tone: "quiet", class: "bg-alert-tint text-alert-ink" },

      // -- inverted: solid ground, ground-coloured ink ----------------------
      { status: "nominal", tone: "inverted", class: "bg-nominal text-bg" },
      { status: "warn", tone: "inverted", class: "bg-warn text-bg" },
      { status: "alert", tone: "inverted", class: "bg-alert text-bg" },

      // -- auto: quiet in operator, inverted once the page descends ---------
      {
        status: "nominal",
        tone: "auto",
        class: "bg-nominal-tint text-nominal-ink machine:bg-nominal machine:text-bg",
      },
      {
        status: "warn",
        tone: "auto",
        class: "bg-warn-tint text-warn-ink machine:bg-warn machine:text-bg",
      },
      {
        status: "alert",
        tone: "auto",
        class: "bg-alert-tint text-alert-ink machine:bg-alert machine:text-bg",
      },

      // -- bare: the word alone, for dense same-status lists ----------------
      { status: "nominal", tone: "bare", class: "bg-transparent text-nominal-ink" },
      { status: "warn", tone: "bare", class: "bg-transparent text-warn-ink" },
      { status: "alert", tone: "bare", class: "bg-transparent text-alert-ink" },
    ],
    defaultVariants: { status: "nominal", tone: "auto" },
  },
);

export type StatusChipStatus = NonNullable<
  VariantProps<typeof statusChipVariants>["status"]
>;

export interface StatusChipProps
  extends
    React.ComponentPropsWithoutRef<"span">,
    VariantProps<typeof statusChipVariants> {}

export function StatusChip({
  className,
  status,
  tone,
  children,
  ...props
}: StatusChipProps) {
  return (
    <span
      data-slot="status-chip"
      data-status={status ?? "nominal"}
      className={cn(statusChipVariants({ status, tone }), className)}
      {...props}
    >
      {children}
    </span>
  );
}
