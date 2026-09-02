"use client";

import { cn } from "@/lib/utils";
import { clockTime } from "../alert-lifecycle";
import { recoveryTier } from "../incident-report";
import { SectionLabel } from "../section-label";

/** The fleet-scale actions taken, each with its outcome and recovery tier. */
export function ActionsBlock({
  actions,
  tier,
}: {
  actions: readonly { label: string; outcome: string; at: number; refused: boolean }[];
  tier: string | null;
}) {
  if (actions.length === 0) {
    return (
      <p className="text-small text-ink-soft">
        No fleet-scale action was recorded on this incident.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-line">
        {actions.map((action) => (
          <li
            key={`${action.label}-${action.at}`}
            data-action={action.label}
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
          >
            <span className="text-small text-ink">{action.label}</span>
            <span
              className={cn(
                "tnum text-small",
                action.refused ? "text-alert-ink" : "text-ink-soft",
              )}
            >
              {action.outcome} · {clockTime(action.at)}
            </span>
            <span className="ml-auto">
              <TierTag action={action.label} />
            </span>
          </li>
        ))}
      </ul>
      {/* Derived from the tier, so it cannot claim a cheap incident on a
          report that names a dispatch. */}
      {tier === "remote operations" ? (
        <p className="text-label tracking-normal text-ink-soft">
          Every intervention on this incident ran over the link. No unit required a visit.
        </p>
      ) : null}
    </div>
  );
}

function TierTag({ action }: { action: string }) {
  const tier = recoveryTier(action);
  if (!tier) return null;
  return (
    <SectionLabel as="span" className="shrink-0">
      {tier}
    </SectionLabel>
  );
}
