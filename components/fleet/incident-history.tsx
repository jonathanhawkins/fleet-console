"use client";

import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import {
  selectAlerts,
  selectUnitHistory,
  useAuditStore,
  useFleetStore,
  useIncidentStore,
  type IncidentRecord,
} from "@/lib/stores";
import { cn } from "@/lib/utils";
import { incidentRef } from "./incident-ref";
import { clockTime, formatDuration } from "./alert-lifecycle";
import { verdictLine } from "./incident-banner";
import { incidentSpans, incidentTimes, openIncidentReport } from "./incident-report";
import { isoTime, SectionLabel } from "@/components/console";

/**
 * What the descent left behind.
 *
 * The point of the whole golden path is that the operator comes back with
 * something, and this is the something: a record with a time on it, the
 * diagnosis in the page's own voice, and the actions they acknowledged while
 * they were down there. Without it, the descent is a light show — the operator
 * pressed a button, watched a scan, and returned to a page identical to the one
 * they left.
 *
 * Rendered from the incident store's history, so it is written by
 * `completeAscent()` and by nothing else. An aborted scan leaves no row, which
 * is correct: a diagnostic that did not reach a verdict is not an incident, it
 * is an interruption.
 *
 * Sentence case and plain verbs, like the rest of operator space. The machine's
 * uppercase summary stays in machine space where it belongs.
 *
 * ## No entrance animation on the row — measured, then deliberately omitted
 *
 * The alert feed's rows arrive on `alert-enter` (180 ms, a 6 px settle, mount
 * only) and this row is structurally its twin, so it looked like the obvious
 * place to reuse the beat. It is not, for two reasons that only showed up in a
 * real descent.
 *
 * **It would play where nobody can see it.** The record is written by
 * `completeAscent()`, which fires while the machine-space surface is still
 * covering the page — the stage outlives the session by one 250 ms exit wipe.
 * Timed through a full descent and return (compressed sim, `next dev`): the row
 * mounts 36 ms after RETURN on a desktop and 43 ms on a phone, and the
 * descending surface does not clear its top edge until 76 ms / 98 ms, or its
 * bottom until 97 ms / 123 ms. On `--ease-console` an 180 ms entrance is
 * already 72 % done at the first of those instants and 87 % done at the last.
 * What the operator would actually see is not an arrival — it is the payoff row
 * of the whole product being uncovered at four-fifths opacity and finishing
 * afterwards, which reads as a row that has not finished painting.
 *
 * **It would be the second entrance for one event.** This row does not appear
 * unannounced; it is *revealed*, by the surface travelling down off it, and
 * then the whole operator page restores from its descent desaturation over
 * 150 ms. Those two motions are the arrival, and they are page-wide and
 * spatially consistent. A region-local fade inside them is a third motion
 * competing with both, at the exact moment the operator is looking for what
 * they came back with.
 *
 * So the row lands still and solid. The right beat for this arrival already
 * exists and belongs to the ascent.
 */

export interface IncidentHistoryProps extends Omit<
  React.ComponentPropsWithoutRef<"div">,
  "children"
> {
  unitId: string;
}

export function IncidentHistory({ className, unitId, ...props }: IncidentHistoryProps) {
  const history = useIncidentStore(useShallow(selectUnitHistory(unitId)));

  // Nothing has been diagnosed on this unit; an empty "no incidents" panel
  // would be a section whose only content is its own absence.
  if (history.length === 0) return null;

  return (
    <div
      data-slot="incident-history"
      className={cn("flex flex-col divide-y divide-line", className)}
      {...props}
    >
      {history.map((record) => (
        <article
          key={record.id}
          data-incident={record.id}
          className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <p className="text-body text-ink">{verdictLine(record.report)}</p>
            <time
              dateTime={isoTime(record.report.ts)}
              className="tnum text-small text-ink-soft"
            >
              {clockTime(record.report.ts)}
            </time>
          </div>

          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
            {/* The id is the way in to the full report. It was already
                the row's reference — the string an operator reads down a phone
                — so it is the honest thing to make pressable rather than adding
                a "View report" control beside it and having two objects on the
                row that mean the same record. */}
            <button
              type="button"
              onClick={() => openIncidentReport(record.id)}
              aria-label={`Open incident report ${incidentRef(record.unitId, record.report.ts)}`}
              className={cn(
                "-mx-1 rounded-md px-1 tnum text-small text-ink-soft underline",
                "decoration-line-strong underline-offset-4",
                "transition-colors duration-[var(--dur-press)] ease-console",
                "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/70",
                "focus-visible:outline-none",
              )}
            >
              {incidentRef(record.unitId, record.report.ts)}
            </button>
            {record.acknowledged.length > 0 ? (
              <p className="text-small text-ink-soft">
                Acknowledged: {record.acknowledged.join(", ").toLowerCase()}
              </p>
            ) : record.report.anomaly === "none" ? null : (
              // Said plainly rather than omitted: "no actions were taken" is
              // itself a fact about an incident, and the row that leaves it out
              // reads the same as the row where someone dispatched a technician.
              //
              // A clean pass is the exception, and the reason is the same one:
              // it is a fact only where there were actions to take. The healthy
              // verdict's recommendation is "no action required" and its card
              // offers no buttons (verdict-card.tsx), so "No actions
              // acknowledged" there would report a lapse that was never
              // possible.
              <p className="text-small text-ink-soft">No actions acknowledged.</p>
            )}
            <IncidentResolutionSpan record={record} />
          </div>
        </article>
      ))}
    </div>
  );
}

/**
 * How long the whole thing took, on the row that says it happened.
 *
 * The row already carries the moment the verdict landed. What it never carried
 * is the shape of the incident around that moment — an alert raised at 18:07
 * and closed at 19:42 is a very different call from one closed at 18:09, and
 * both rows read identically without this.
 *
 * Derived, never stored: the linkage is the alert's own resolution ref, and the
 * two ends are the wire's detection time and the console's closure time. It
 * appears only where both exist, which is the same rule the whole report is
 * written under — an open incident has no elapsed time, it has a running one,
 * and that is the banner's job rather than the archive's.
 *
 * Right-aligned and in the quietest voice on the row, because it is a figure
 * rather than a finding: the eye should reach the diagnosis first and find this
 * when it goes looking for it.
 */
function IncidentResolutionSpan({ record }: { record: IncidentRecord }) {
  const alerts = useFleetStore(selectAlerts);
  const meta = useFleetStore((s) => s.alertMeta);
  const audit = useAuditStore((s) => s.entries);

  const mttr = React.useMemo(
    () => incidentSpans(incidentTimes(record, alerts, meta, audit)).mttr,
    [record, alerts, meta, audit],
  );
  if (mttr === undefined) return null;

  return (
    <span className="ml-auto flex items-baseline gap-2">
      <SectionLabel as="span">Raised → resolved</SectionLabel>
      <span className="tnum text-small text-ink-soft">{formatDuration(mttr)}</span>
    </span>
  );
}
