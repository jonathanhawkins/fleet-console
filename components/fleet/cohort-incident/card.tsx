"use client";

import * as React from "react";
import {
  selectFleetCommand,
  selectUnitIds,
  useCommandStore,
  useFleetStore,
  type CohortIncident,
  type FleetState,
} from "@/lib/stores";
import { cn } from "@/lib/utils";
import { clockTime, durationSince, formatDuration } from "../alert-lifecycle";
import { canaryLine, cohortClosedAt, cohortHeadline, listUnits } from "../cohort-copy";
import { SectionLabel, useNow } from "@/components/console";
import { CohortActions } from "./actions";
import { MemberChip } from "./member-chip";
import { CohortReportGate, ReportReference } from "./report-gate";

/** `units` moves on alerts, unit_updates and snapshots — never on telemetry. */
const selectUnitsRecord = (s: FleetState) => s.units;
/** Ack/resolution per alert id; identity moves only when one of those happens. */
const selectAlertMetaRecord = (s: FleetState) => s.alertMeta;

export interface CohortIncidentProps {
  cohort: CohortIncident;
  /** The derivation has let the group go; the commands are the story now. */
  dissolved: boolean;
}

/**
 * The fleet incident card: the situation and its evidence on the left, the two
 * fleet-scale actions and what the fleet said back on the right.
 */
export default function CohortIncidentCard({ cohort, dissolved }: CohortIncidentProps) {
  // Plain state rather than a module signal (cf. incident-report.ts): one
  // opener, one reader, and importing that module from this async chunk
  // measurably splits the shared payload on both routes.
  const [reportOpen, setReportOpen] = React.useState(false);
  const units = useFleetStore(selectUnitsRecord);
  const alertMeta = useFleetStore(selectAlertMetaRecord);
  const unitIds = useFleetStore(selectUnitIds);
  const halt = useCommandStore(selectFleetCommand("HALT_ROLLOUT"));
  const rollback = useCommandStore(selectFleetCommand("ROLLBACK_COHORT"));
  const now = useNow();
  const headingId = React.useId();

  const fwOf = React.useCallback((unitId: string) => units[unitId]?.fw, [units]);
  // Units still carrying a scheduled install of the suspect build — what a halt
  // saves. Empty once a halt has answered either way: the receipt is the
  // authority from then on, and the card must not advertise a queue it no
  // longer knows about.
  const queued =
    halt === undefined ? unitIds.filter((id) => units[id]?.fwPending === cohort.fw) : [];

  // The incident is over: the group has dissolved and nothing is in flight.
  // The card changes tense and tint but stays until the operator resolves it.
  const settled =
    dissolved && rollback?.phase !== "pending" && rollback?.phase !== "progress";

  // Live: a running clock. Settled: a closed bracket, or no span at all when
  // nothing on file can date the closure (`cohortClosedAt`).
  const closedAt = settled
    ? cohortClosedAt(
        cohort.alertIds.map((id) => alertMeta[id]?.resolvedAt),
        rollback,
      )
    : undefined;
  const openFor = settled
    ? closedAt === undefined
      ? null
      : formatDuration(closedAt - cohort.detectedAt)
    : durationSince(cohort.detectedAt, now);

  return (
    <section
      data-slot="cohort-card"
      data-fw={cohort.fw}
      data-dissolved={dissolved || undefined}
      data-settled={settled || undefined}
      aria-labelledby={headingId}
      className={cn(
        "rounded-xl border p-5 sm:p-6 md:px-7 md:py-6",
        settled ? "border-nominal/35 bg-nominal-tint" : "border-warn/35 bg-warn-tint",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-6">
        <div className="flex min-w-0 flex-1 basis-[24rem] flex-col gap-4">
          {/* Same tag the alert feed prints on every member row. */}
          <SectionLabel tone={settled ? "nominal" : "warn"}>
            Cohort · {cohort.fw}
          </SectionLabel>

          <div className="flex flex-col gap-2">
            {/* aria-live: the operator may be reading the map when this lands. */}
            <h2
              id={headingId}
              aria-live="polite"
              className="text-heading text-ink sm:text-title"
            >
              {cohortHeadline(cohort.unitIds.length, settled)}
            </h2>
            {/* The wire's sentence, verbatim: it is the reason these alerts are
                one incident, so the operator can check the claim. */}
            <p className="text-body text-ink-soft">&ldquo;{cohort.signature}&rdquo;</p>
            <p className="text-small font-medium text-ink">
              {canaryLine(cohort.canary, cohort.fw)}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <ul
              aria-label="Affected units"
              className="flex flex-wrap items-center gap-1.5"
            >
              {cohort.unitIds.map((unitId) => (
                <li key={unitId}>
                  <MemberChip unitId={unitId} status={units[unitId]?.status} />
                </li>
              ))}
            </ul>
            {/* A sentence on its own line, not a fifth member pill: this is the
                unit the halt can still save. Gone once a halt answers. */}
            {queued.length > 0 ? (
              <p className="text-label tracking-normal text-ink-soft">
                {listUnits(queued)} {queued.length === 1 ? "is" : "are"} scheduled for{" "}
                {cohort.fw}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex w-full flex-col gap-4 sm:w-[20rem] sm:shrink-0 lg:w-[23rem]">
          {/* `items-start` below `sm`: a stretched <button> centres its own text
              and would sit on a different axis from the dateline above it. */}
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <p className="text-label tracking-normal text-ink-soft">
              Detected <span className="tnum">{clockTime(cohort.detectedAt)}</span>
              {closedAt !== undefined ? (
                <>
                  {" · closed "}
                  <span className="tnum">{clockTime(closedAt)}</span>
                </>
              ) : null}
              {openFor !== null ? (
                <>
                  {" · "}
                  <span className="tnum">{openFor}</span>
                </>
              ) : null}
            </p>
            <ReportReference cohort={cohort} onOpen={() => setReportOpen(true)} />
          </div>

          <CohortActions
            cohort={cohort}
            fwOf={fwOf}
            unitIds={unitIds}
            queued={queued}
            halt={halt}
            rollback={rollback}
            settled={settled}
            closedAt={closedAt}
          />
        </div>
      </div>

      <CohortReportGate
        cohort={cohort}
        open={reportOpen}
        onClose={() => setReportOpen(false)}
      />
    </section>
  );
}
