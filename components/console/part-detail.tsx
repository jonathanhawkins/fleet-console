"use client";

import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import {
  getUnitBuffers,
  selectUnit,
  selectUnitHistory,
  useFleetStore,
  useIncidentStore,
  type TelemetryMetric,
} from "@/lib/stores";
import { cn } from "@/lib/utils";
import {
  componentForJoint,
  componentLabel,
  componentStatus,
  SERVICE_DISCLAIMER,
  serviceDateLabel,
  serviceDueInDays,
  serviceRecord,
  type ComponentHighlight,
  type ComponentId,
} from "./component-spec";
import { ConsoleCard } from "./console-card";
import { incidentRef } from "./incident-history";
import { openIncidentReport } from "./incident-report";
import { envelope, jointLabel, METRIC_SPEC, METRICS } from "./joint-spec";
import { jointsForPart } from "./part-selection";
import { useNow } from "./relative-time";
import { SectionLabel } from "./section-label";
import { StatusChip } from "./status-chip";
import { ViewDiagnosticButton, useUnitDiagnostic } from "./run-diagnostic";
import { breachedRecently, stripTone, type StripTone } from "./telemetry-strip";

/**
 * What the console knows about one part, once an operator has asked.
 *
 * The charge against the first component view was that it was eye candy:
 * a robot you could turn, next to a list you could click, saying nothing a
 * drawing would not. This card is the answer to that, and everything on it is
 * chosen against one test — *does this change what the operator does next?*
 *
 * the live readings the same three measures the strips draw, for the joints
 * this part actually contains, in the same tone the
 * strips use, so the card and the grid can never disagree
 * the posture note a leg's torque and current read low during a safe sit
 * because the leg is holding nothing up, not because it
 * recovered — the one reading on this card that would
 * otherwise be misread
 * the service record when this was last touched and whether it is overdue,
 * which is the fact that turns "running hot" into "running
 * hot, thirty-three days past service"
 * the incident if this is the part the open incident is about, the way
 * back to the record and the verdict
 *
 * Four of the eight parts have no instrumented joints at all (the head, the
 * torso, both arms). The card renders for them anyway and says so plainly: a
 * selection that produced nothing would read as a broken control, and "this
 * part reports no telemetry" is a real answer to a real question.
 *
 * ## Where the numbers come from
 *
 * The rings, read non-reactively on the app's one-second ticker — the same
 * arrangement as the strip's live numeral (StripValue) and for the same reason
 * lib/stores/README.md gives: text is never bound to a version counter, because
 * a counter moves ten times a second and an operator cannot read a number that
 * does. The card re-renders once per second and prints whatever the rings hold
 * at that instant.
 */

export interface PartDetailProps {
  unitId: string;
  /** The selected part. The card renders nothing without one — see ComponentView. */
  part: ComponentId;
  /** Which part the page's incident implicates, from useComponentHighlight. */
  highlight: ComponentHighlight | null;
}

export function PartDetail({ unitId, part, highlight }: PartDetailProps) {
  const now = useNow();
  const unit = useFleetStore(selectUnit(unitId));
  const diagnostic = useUnitDiagnostic(unitId);
  const history = useIncidentStore(useShallow(selectUnitHistory(unitId)));

  const joints = jointsForPart(part);
  const flagged = highlight?.id === part;
  const status = componentStatus(part, highlight);
  const record = serviceRecord(part);
  const due = serviceDueInDays(record);
  const serviced = serviceDateLabel(record, now);

  // The newest record on file, and only if it is about *this* part. The
  // highlight already resolves the verdict's joint to a component, so the two
  // agree by construction — the check is here so that a record for a different
  // part can never be offered under this part's name.
  const filed = history[0];
  const incident =
    filed && componentForJoint(filed.report.joint) === part ? filed : undefined;

  return (
    <ConsoleCard
      data-slot="part-detail"
      variant="outlined"
      padding="none"
      label={componentLabel(part)}
      labelAs="h3"
      action={
        <StatusChip status={status} tone={flagged ? "quiet" : "bare"}>
          {status === "nominal" ? "Nominal" : "Attention"}
        </StatusChip>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        {joints.length === 0 ? (
          // Said once, without apology. The grid dims nothing for these parts
          // (part-selection.ts), so this line is the whole answer.
          <p className="text-small text-ink-soft">
            No instrumented joints on this part. Its condition is reported by the unit,
            not by a sensor of its own.
          </p>
        ) : (
          joints.map((joint) => (
            <JointReadings
              key={joint}
              unitId={unitId}
              joint={joint}
              /* One heading per joint only when there are two of them: a knee
                 actuator's card would otherwise carry a subhead reading "Left
                 knee" directly under one reading "Left knee actuator". */
              labelled={joints.length > 1}
              now={now}
            />
          ))
        )}

        {unit?.posture === "sitting" && joints.length > 0 ? (
          <p className="border-l-2 border-line pl-3 text-small text-ink-soft">
            Sitting: this limb is carrying nothing, so torque and current read low by
            design. Temperature is still the joint&rsquo;s own.
          </p>
        ) : null}

        <div className="flex flex-col gap-1 border-t border-line pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <SectionLabel>Last service</SectionLabel>
            {/* Overdue is the only thing on this card allowed a colour of its
                own, and it earns it: it is the fact that changes the reading
                above from a measurement into a cause. */}
            <span
              className={cn(
                "tnum text-small",
                due < 0 ? "text-warn-ink" : "text-ink-soft",
              )}
            >
              {due < 0 ? `${Math.abs(due)} days overdue` : `Due in ${due} days`}
            </span>
          </div>
          <p className="tnum text-small text-ink">{serviced ?? "—"}</p>
          <p className="text-small text-ink-soft">{record.note}</p>
          {/* Not a footnote and not a tooltip. A console that invents a service
              history and does not say so on the same card is a console that
              lies; this sits where the record does, in the smallest voice the
              type scale has. */}
          <p className="mt-1 text-label text-ink-muted uppercase">{SERVICE_DISCLAIMER}</p>
        </div>

        {flagged ? (
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <p className="text-small text-ink">
              {incident
                ? "Named by the diagnosis on file for this unit."
                : "Implicated in this unit’s open incident."}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {incident ? (
                <button
                  type="button"
                  aria-label={`Open incident report ${incidentRef(incident.unitId, incident.report.ts)}`}
                  onClick={() => openIncidentReport(incident.id)}
                  className={cn(
                    "-mx-1 rounded-md px-1 tnum text-small text-ink-soft underline",
                    "decoration-line-strong underline-offset-4",
                    "transition-colors duration-[var(--dur-press)] ease-console",
                    "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/70",
                    "focus-visible:outline-none",
                  )}
                >
                  {incidentRef(incident.unitId, incident.report.ts)}
                </button>
              ) : null}
              {/* Only while there is genuinely a scan to go back into —
                  `viewable` is false when the operator is already watching one
                  and while the descent has not reached the machine yet. */}
              {diagnostic.viewable ? (
                <ViewDiagnosticButton size="sm">View verdict</ViewDiagnosticButton>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </ConsoleCard>
  );
}

/**
 * Three measures of one joint, in the strips' own tone.
 *
 * `stripTone` and `breachedRecently` are imported rather than re-derived, so a
 * number that reads amber here is amber for exactly the reason the strip beside
 * it is: the same envelope, the same three-second hold, the same rule that a
 * measure out of band wears the *unit's* severity rather than inventing one.
 */
function JointReadings({
  unitId,
  joint,
  labelled,
  now,
}: {
  unitId: string;
  joint: string;
  labelled: boolean;
  now: number;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {/* Not a SectionLabel: that component's whole voice is uppercase and
          wide-tracked, and this sits one step *above* three of them. A joint
          name in the same register as the measures under it would read as a
          fourth measure. */}
      {labelled ? (
        <p className="text-small font-medium text-ink">{jointLabel(joint)}</p>
      ) : null}
      <dl className="grid grid-cols-3 gap-x-3">
        {METRICS.map((metric) => (
          <Reading key={metric} unitId={unitId} joint={joint} metric={metric} now={now} />
        ))}
      </dl>
    </div>
  );
}

const TONE_CLASS: Record<StripTone, string> = {
  ink: "text-ink",
  warn: "text-warn-ink",
  alert: "text-alert-ink",
};

function Reading({
  unitId,
  joint,
  metric,
  now,
}: {
  unitId: string;
  joint: string;
  metric: TelemetryMetric;
  now: number;
}) {
  const spec = METRIC_SPEC[metric];
  const series = getUnitBuffers(unitId)?.joints.get(joint)?.[metric];
  // `now === 0` is the server/pre-hydration snapshot (relative-time.ts): there
  // is no honest reading to print yet, and printing one would be a mismatch.
  const value = now === 0 ? undefined : series?.last();
  const status = useFleetStore.getState().units[unitId]?.status;
  const tone: StripTone =
    series && value !== undefined
      ? stripTone(breachedRecently(series, envelope(joint, metric).healthy), status)
      : "ink";

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt>
        <SectionLabel>{spec.label}</SectionLabel>
      </dt>
      <dd
        data-slot="part-reading"
        data-metric={metric}
        className={cn(
          "tnum text-small",
          value === undefined ? "text-ink-muted" : TONE_CLASS[tone],
        )}
      >
        {value === undefined ? (
          <>
            <span aria-hidden>—</span>
            <span className="sr-only">No reading yet</span>
          </>
        ) : (
          <>
            {value.toFixed(spec.precision)}
            <span className="ml-1 text-ink-soft">{spec.unit}</span>
          </>
        )}
      </dd>
    </div>
  );
}

/**
 * ## Where this link used to go
 *
 * It used to scroll the page to the matching row in the incident history,
 * addressing it by the `data-incident` attribute that component renders. That
 * was the right answer while the row *was* the record: it needed no shared
 * state and nothing in the other component to change.
 *
 * There is a full report now, and this link is three components deep inside a
 * 3D scene — so it opens the document directly rather than pointing at a
 * summary of it, through the same module-level signal the history's own id uses
 * (incident-report.ts). The alternative was threading a callback down through
 * the component view, which is exactly the plumbing the old scroll trick
 * existed to avoid.
 */
