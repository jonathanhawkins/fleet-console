import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { SectionLabel, type SectionLabelProps } from "./section-label";

/**
 * The panel both worlds are built from.
 *
 * Operator space separates a card from the page with warmth, not weight: greige
 * on warm white, a hairline, at most a single-direction shadow.
 * Machine space has no elevation at all — every card collapses to a 1px outlined
 * box on the void, which is how the EVA boards build hierarchy. That collapse is
 * automatic: --elev-* and --radius are already 0 there.
 */
export const consoleCardVariants = cva(
  [
    "rounded-lg",
    "machine:rounded-none machine:border machine:border-line machine:bg-transparent machine:shadow-none",
  ],
  {
    variants: {
      variant: {
        plain: "border border-transparent bg-surface",
        outlined: "border border-line bg-bg",
        raised: "border border-line bg-bg shadow-[var(--elev-raised)]",
      },
      padding: {
        none: "",
        default: "p-6 machine:p-4",
      },
    },
    defaultVariants: { variant: "plain", padding: "default" },
  },
);

export interface ConsoleCardProps
  extends
    React.ComponentPropsWithoutRef<"section">,
    VariantProps<typeof consoleCardVariants> {
  /** Optional section label rendered above the content, with a hairline. */
  label?: React.ReactNode;
  /**
   * Promote the label to a real heading. A card that names a region of the page
   * (the map, the unit rail) owes the document a heading; a card that is one row
   * of a list does not.
   */
  labelAs?: SectionLabelProps["as"];
  /** Optional trailing slot on the label row — a chip, a count, a button. */
  action?: React.ReactNode;
}

export function ConsoleCard({
  className,
  variant,
  padding,
  label,
  labelAs,
  action,
  children,
  ...props
}: ConsoleCardProps) {
  const hasHeader = label != null || action != null;
  // padding="none" is what a card hosting a map, a canvas or a virtualized list
  // asks for: the *body* runs to the edge, but the label row still needs its own
  // inset or it sits flush against the border.
  const flush = padding === "none";

  return (
    <section
      data-slot="console-card"
      className={cn(consoleCardVariants({ variant, padding }), className)}
      {...props}
    >
      {hasHeader ? (
        <header
          className={cn(
            // flex-wrap, because the action slot is caller-supplied and a
            // header cannot know how wide it will be: the fleet rail's search
            // + order + count is wider than a phone, and without this it was
            // clipped rather than wrapped — the count sat entirely off-screen
            // with nothing to scroll it back.
            "flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2",
            "border-b border-line",
            flush
              ? "px-5 py-3.5 machine:px-4 machine:py-2.5"
              : "mb-5 pb-3 machine:mb-3 machine:pb-2",
          )}
        >
          {label != null ? <SectionLabel as={labelAs}>{label}</SectionLabel> : <span />}
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}
