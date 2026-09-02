import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Battery, stated twice: once as the number an operator would repeat on a
 * call, once as a length the eye reads without stopping.
 *
 * The bar is 3px and unlabelled — no ticks, no percentage inside it, no
 * gradient from green to red. A gauge that dramatises a healthy number teaches
 * the operator to ignore it, which is exactly the wrong lesson for the one
 * measurement that will eventually matter. It stays ink until the charge is
 * genuinely low, and then it is the only warm thing in the identity row.
 *
 * `value: null` is "no reading yet", and it is a state of *this* component
 * rather than something the identity row swaps it out for. A meter
 * replaced by an em-dash is one line where the settled meter is two, so the
 * identity row grew by 11px on the first snapshot and pushed the instrument
 * stack down with it. Keeping the same two-line box in both states means the
 * first reading fills a gauge that is already standing — which is also the
 * honest picture: the gauge exists, it has not been told anything yet.
 */

/** Below this, the meter changes colour. A house robot at 20 % has an errand. */
export const BATTERY_LOW_PCT = 20;

export interface BatteryMeterProps extends Omit<
  React.ComponentPropsWithoutRef<"span">,
  "children"
> {
  /** Percent, 0–100, or null for "no reading yet". */
  value: number | null;
  /** Width of the track. Defaults to a fixed measure so it reads as a gauge. */
  trackClassName?: string;
}

export function BatteryMeter({
  className,
  value,
  trackClassName,
  ...props
}: BatteryMeterProps) {
  const known = value !== null;
  const pct = known ? Math.min(100, Math.max(0, value)) : 0;
  const low = known && pct < BATTERY_LOW_PCT;

  return (
    <span
      data-slot="battery-meter"
      data-low={low || undefined}
      data-pending={known ? undefined : ""}
      className={cn("flex flex-col gap-2", className)}
      {...props}
    >
      <span className={cn("tnum", low && "text-warn-ink", !known && "text-ink-soft")}>
        {known ? (
          `${Math.round(pct)}%`
        ) : (
          <>
            <span aria-hidden>—</span>
            <span className="sr-only">No reading yet</span>
          </>
        )}
      </span>
      {/* aria-hidden: the figure above is the same fact, in words. */}
      <span
        aria-hidden
        className={cn(
          "block h-[3px] w-28 overflow-hidden rounded-pill bg-line",
          trackClassName,
        )}
      >
        <span
          className={cn(
            "block h-full rounded-pill transition-[width] duration-[var(--dur-enter)] ease-console",
            low ? "bg-warn" : "bg-ink",
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}
