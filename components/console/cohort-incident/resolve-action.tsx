"use client";

import { useCohortRecordStore, type CohortIncident } from "@/lib/stores";
import { ConsoleButton } from "../console-button";

/**
 * The close-out. One press and no confirmation: it writes a line in a log and
 * sends nothing to the fleet, and a gate in front of the cheapest action is
 * how gates stop meaning anything. Outline, never the dark pill.
 */
export function ResolveAction({
  cohort,
  closedAt,
}: {
  cohort: CohortIncident;
  closedAt: number | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <ConsoleButton
          size="md"
          variant="secondary"
          data-slot="cohort-resolve"
          onClick={() => useCohortRecordStore.getState().resolve(cohort, closedAt)}
        >
          Resolve incident
        </ConsoleButton>
      </div>
      <p className="text-label tracking-normal text-ink-soft">
        Files the incident in the session log. Nothing is sent to the fleet.
      </p>
    </div>
  );
}
