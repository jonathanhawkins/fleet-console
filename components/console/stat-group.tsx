"use client";

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
 * ## The arrival inks
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
 * machine reported.
 *
 * ## `acknowledge`: the figure that moved
 *
 * A number changing in place is the quietest event a screen can stage, and an
 * operator watching the map does not see it happen. `acknowledge` gives the
 * figure a one-shot beat when its value moves: a rule drawn beneath it in its
 * own ink, over a wash of the status colour, both dissolving inside 800 ms
 * (`.stat-group__ack`, operator.css). The rule paints in `currentColor` and
 * the wash in `--ack-wash`, which only the status tones set, so the gesture
 * inherits whatever ordering the band gave its tones instead of restating it —
 * and a count falling back to a plain-ink zero is acknowledged by the rule
 * alone, because good news is worth noticing and is not worth an alarm.
 *
 * It is deliberately *not* on `color`: the arrival ink above is the one thing
 * this element's colour is allowed to say, and a second colour beat would put
 * the two in a fight the fast one wins. Pseudo-elements are also free of the
 * text, so nothing here can affect the figure's contrast at rest.
 *
 * Opt-in, because the signal is only worth what it is spent on: a band where
 * every number acknowledged itself would acknowledge nothing.
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
    /**
     * `--ack-wash` is the status half of the `acknowledge` beat, and only the
     * status tones set it: a figure whose tone is plain ink washes in nothing
     * and is acknowledged by its rule alone. Colour as an *area* is read by
     * luminance, not by hue, so a neutral wash behind a zero would outweigh a
     * clay one behind a raised count and stand the band's ordering on its
     * head. Left undefined, the wash falls back to transparent.
     */
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
      nominal: "text-nominal-ink [--ack-wash:var(--nominal)]",
      warn: "text-warn-ink [--ack-wash:var(--warn)]",
      alert: "text-alert-ink [--ack-wash:var(--alert)]",
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
  /** Play a one-shot beat when `value` moves. Off by default; see above. */
  acknowledge?: boolean;
}

export function StatGroup({
  className,
  label,
  value,
  unit,
  pending = false,
  acknowledge = false,
  size,
  tone,
  ...props
}: StatGroupProps) {
  const figureRef = React.useRef<HTMLElement>(null);
  const lastRead = React.useRef<React.ReactNode>(null);
  const hasRead = React.useRef(false);

  React.useEffect(() => {
    // Nothing has been reported yet, so there is no *change* to acknowledge —
    // the em-dash inking up into the first figure is its own beat, and firing
    // this on top of it would stage two arrivals for one piece of news.
    if (!acknowledge || pending) return;
    const previous = lastRead.current;
    const seenBefore = hasRead.current;
    lastRead.current = value;
    hasRead.current = true;
    if (!seenBefore || Object.is(previous, value)) return;

    const figure = figureRef.current;
    if (!figure) return;
    figure.removeAttribute("data-ack");
    // A layout read between the removal and the write flushes the style
    // change, which is what lets the one-shot run again on the next change
    // instead of only the first.
    figure.getBoundingClientRect();
    figure.setAttribute("data-ack", "");
  }, [acknowledge, pending, value]);

  return (
    <div
      data-slot="stat-group"
      data-pending={pending || undefined}
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    >
      <dt className={sectionLabelVariants()}>{label}</dt>
      <dd
        ref={figureRef}
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
          acknowledge && "stat-group__ack",
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
