import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The careers-page move from the operator reference set: a small, wide-tracked,
 * uppercase label in muted ink
 * that names a region without competing with it. Machine space inherits the same
 * component and renders it as a mono system label — the type scale flips itself
 * (see --fs-label / --tr-label in app/globals.css), so there is no space prop.
 */
export const sectionLabelVariants = cva("inline-flex items-center text-label uppercase", {
  variants: {
    tone: {
      // The quiet tone is *not* --muted in operator space: at 11px that grey is
      // 3.31:1, under AA (see the --muted ruling in app/globals.css). Machine
      // space keeps its dim phosphor tier, where luminance *is* the hierarchy
      // and the contrast bar is met regardless.
      muted: "text-ink-soft machine:text-ink-muted",
      ink: "text-ink",
      // The status tones are the `-ink` slots, not the raw status hues, for the
      // reason the raw hues exist: sage/amber/clay are the PRD palette and are
      // spent on rings, dials, dots and tints, where the 3:1 non-text bar
      // applies. As 11px text they are 4.4:1 / 3.1:1 / 5.1:1 on the page and
      // worse on every tinted ground under them — `tone="nominal"` renders on
      // `--nominal-tint` (3.8:1) and `tone="warn"` on `--warn-tint` (2.7:1).
      // The `-ink` variants are the same hues pulled toward the charcoal
      // precisely to clear AA at label size (see app/globals.css), and they are
      // already what every other status-as-text surface here uses. Machine
      // space is untouched by the swap: there `--nominal-ink` and friends are
      // straight aliases of the status tokens, so the dark ladder is unchanged.
      // Pinned by section-label.contrast.test.ts.
      nominal: "text-nominal-ink",
      warn: "text-warn-ink",
      alert: "text-alert-ink",
    },
  },
  defaultVariants: { tone: "muted" },
});

export interface SectionLabelProps
  extends
    Omit<React.ComponentPropsWithoutRef<"div">, "color">,
    VariantProps<typeof sectionLabelVariants> {
  /** Run a hairline from the end of the label to the edge of its container. */
  rule?: boolean;
  /** Render as a different element — `h2` for real section headings. */
  as?: "div" | "p" | "span" | "h2" | "h3" | "figcaption";
}

export function SectionLabel({
  className,
  tone,
  rule = false,
  as: Comp = "div",
  children,
  ...props
}: SectionLabelProps) {
  if (!rule) {
    return (
      <Comp
        data-slot="section-label"
        className={cn(sectionLabelVariants({ tone }), className)}
        {...props}
      >
        {children}
      </Comp>
    );
  }

  return (
    <Comp
      data-slot="section-label"
      className={cn(sectionLabelVariants({ tone }), "flex w-full gap-4", className)}
      {...props}
    >
      <span className="shrink-0">{children}</span>
      {/* A border rather than a 1px filled box: this label heads the sections
          of a document that prints, and a browser drops background colour on
          paper by default — which took every section rule off the sheet. */}
      <span
        aria-hidden
        className="mt-[0.55em] h-0 flex-1 self-start border-t border-line"
      />
    </Comp>
  );
}
