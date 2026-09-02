import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { sectionLabelVariants } from "./section-label";

/**
 * One fleet number, stated the way a spec sheet states one: a wide-tracked
 * label, then the figure, and nothing else. No card, no icon, no sparkline —
 * a fleet of healthy homes should read as a row of quiet facts.
 *
 * `pending` is the honest empty state and the default posture of the shell:
 * the store lands next wave, so every KPI renders an em-dash rather than a
 * plausible-looking number. Swapping `pending` for `value={n}` is the whole
 * migration.
 *
 * ## The arrival inks (D1)
 *
 * The em-dash and the first figure are the *same* `<dd>` — React patches the
 * class and the children, it does not replace the element — so the arrival is
 * expressible as a colour change on a box that was already standing, and one
 * `transition-colors` is the whole beat: the figure lands in the muted no-data
 * tone and inks up over `--dur-micro`. The board's battery bar has always
 * swept its width in on the first reading (battery-meter.tsx); this is the
 * same acknowledgement, in the one property a number has.
 *
 * It cannot flicker. A *value* update does not change this colour, so the
 * one-second ticker and the 10 Hz store commits move the digits underneath a
 * transition that never fires again; there is exactly one per box per session.
 * And it interpolates nothing — the number printed is always a number the
 * machine reported (fluid-audit judgment call 3).
 *
 * Renders a <dt>/<dd> pair, so it must live inside a <dl>.
 */
export const statGroupValueVariants = cva("tnum", {
  variants: {
    /**
     * `md` is the fleet header: three numbers that are the whole point of the
     * band. `sm` is the unit page's identity row, where the same grammar has
     * to sit beside a 44px unit id without arguing with it — one type step
     * down, not a different component.
     */
    size: {
      md: "text-title",
      sm: "text-heading",
    },
    tone: {
      ink: "text-ink",
      /**
       * A figure that is *not* the answer to the page's question. `ink` is a
       * number an operator is meant to read; `soft` is one they are meant to
       * be able to ignore — a zero on a watch that has nothing to report. It
       * is --ink-soft rather than --muted so it holds AA at either size step,
       * unlike the pending em-dash, which earns --muted by being 28px only.
       */
      soft: "text-ink-soft",
      nominal: "text-nominal-ink",
      warn: "text-warn-ink",
      alert: "text-alert-ink",
    },
  },
  defaultVariants: { size: "md", tone: "ink" },
});

export interface StatGroupProps
  extends
    React.ComponentPropsWithoutRef<"div">,
    VariantProps<typeof statGroupValueVariants> {
  /** Sentence case in source; the label step uppercases it. */
  label: React.ReactNode;
  /** The figure. Ignored while `pending`. */
  value?: React.ReactNode;
  /** Trailing unit, set smaller and softer than the figure. */
  unit?: React.ReactNode;
  /** No data yet: renders an em-dash instead of inventing one. */
  pending?: boolean;
}

export function StatGroup({
  className,
  label,
  value,
  unit,
  pending = false,
  size,
  tone,
  ...props
}: StatGroupProps) {
  return (
    <div
      data-slot="stat-group"
      data-pending={pending || undefined}
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    >
      <dt className={sectionLabelVariants()}>{label}</dt>
      <dd
        className={cn(
          statGroupValueVariants({ size, tone }),
          // See the note above: the em-dash and the figure are one element, so
          // the first reading arrives as an ink step rather than a swap.
          "transition-colors duration-[var(--dur-micro)] ease-console",
          // the one place the shell puts --muted on text: at 28px it is large
          // text, which is precisely what the token is reserved for. At the
          // `sm` step it is 18px medium — not large text by WCAG's definition
          // — so the em-dash drops to --ink-soft instead of failing AA.
          pending && ((size ?? "md") === "sm" ? "text-ink-soft" : "text-ink-muted"),
        )}
      >
        {pending ? (
          <>
            <span aria-hidden>—</span>
            <span className="sr-only">No data yet</span>
          </>
        ) : (
          <>
            {value}
            {unit != null ? (
              <span className="ml-1 text-body text-ink-soft">{unit}</span>
            ) : null}
          </>
        )}
      </dd>
    </div>
  );
}
