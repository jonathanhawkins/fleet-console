import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A rule carrying a length something reported.
 *
 * The same object in both worlds, which is the point: operator space already
 * divides its regions with hairlines and machine space builds its entire
 * hierarchy out of them, so a rule that fills is the one progress indicator
 * neither world has to make an exception for. It is 2px on warm white and 1px
 * on the void, and its pill ends flatten to square in machine space on their
 * own — `--r-pill` is already 0 there.
 *
 * **It reports, it does not predict.** There is no indeterminate mode and no
 * internal animation: the fill is exactly the value the caller was told, and a
 * caller with nothing new to say leaves it where it is. `stalled` is how a
 * caller says *that* out loud, so a bar that has stopped because the source
 * stopped does not read as a bar that is merely slow.
 *
 * `now` / `max` exist because "14 of 26 subsystems" is a better thing for a
 * screen reader to say than "54%". Given neither, it falls back to percent.
 */

export interface ProgressRuleProps extends Omit<
  React.ComponentPropsWithoutRef<"div">,
  "role" | "children"
> {
  /** 0…1. Clamped, and NaN reads as 0 rather than as an unpainted bar. */
  value: number;
  /** Id of the element naming this rule. Required: a bare bar names nothing. */
  labelledBy: string;
  /** Accessible value pair. Omit both to fall back to percent. */
  now?: number;
  max?: number;
  tone?: "ink" | "warn" | "alert";
  /** The source stopped reporting. Holds the fill and says so in the colour. */
  stalled?: boolean;
}

const FILL_TONE: Record<NonNullable<ProgressRuleProps["tone"]>, string> = {
  ink: "bg-ink",
  warn: "bg-warn",
  alert: "bg-alert",
};

export function ProgressRule({
  value,
  labelledBy,
  now,
  max,
  tone = "ink",
  stalled = false,
  className,
  ...props
}: ProgressRuleProps) {
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const counted = now !== undefined && max !== undefined && max > 0;

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={counted ? max : 100}
      aria-valuenow={counted ? now : Math.round(fraction * 100)}
      aria-labelledby={labelledBy}
      className={cn(
        "h-0.5 w-full overflow-hidden rounded-pill bg-line machine:h-px",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "h-full rounded-pill transition-[width] duration-[var(--dur-enter)] ease-console",
          // A held fill does not animate, because nothing moved.
          stalled ? "bg-ink-soft transition-none" : FILL_TONE[tone],
        )}
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  );
}
