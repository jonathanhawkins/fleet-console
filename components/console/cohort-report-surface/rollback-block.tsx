"use client";

import { clockTime, formatDuration } from "../alert-lifecycle";
import { type rollbackChronology } from "../cohort-report";

/**
 * The remediation as an operation: one unit at a time, in the order the fleet
 * worked them, with each step's offset from the order.
 */
export function RollbackBlock({
  steps,
  orderedAt,
  completedAt,
  fw,
}: {
  steps: readonly ReturnType<typeof rollbackChronology>[number][];
  orderedAt?: number;
  completedAt?: number;
  fw: string;
}) {
  if (orderedAt === undefined && steps.length === 0) {
    return <p className="text-small text-ink-soft">No rollback was ordered for {fw}.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-ink">
        {orderedAt === undefined ? (
          "Restorations recorded without an order on file."
        ) : (
          <>
            Ordered <span className="tnum">{clockTime(orderedAt)}</span> ·{" "}
            {steps.length === 0
              ? "no unit has completed yet"
              : `${steps.length} units, one at a time`}
          </>
        )}
      </p>

      {steps.length > 0 ? (
        <ol className="flex flex-col divide-y divide-line">
          {steps.map((step) => (
            <li
              key={step.unitId}
              data-step={step.unitId}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
            >
              <span className="w-12 shrink-0 tnum text-small text-ink">
                {step.unitId}
              </span>
              <span className="tnum text-small text-ink-soft">
                restored {clockTime(step.at)}
                {step.fwAfter === undefined ? null : ` to ${step.fwAfter}`}
              </span>
              {step.sinceOrder === undefined ? null : (
                <span className="ml-auto tnum text-label tracking-normal text-ink-soft">
                  +{formatDuration(step.sinceOrder)}
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : null}

      {completedAt !== undefined ? (
        <p className="text-label tracking-normal text-ink-soft">
          Fleet reported the staged rollback complete at{" "}
          <span className="tnum">{clockTime(completedAt)}</span>.
        </p>
      ) : null}
    </div>
  );
}
