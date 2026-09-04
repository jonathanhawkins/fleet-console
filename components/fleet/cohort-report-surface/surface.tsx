"use client";

import * as React from "react";
import { calendarDate, timeZoneLabel } from "../alert-lifecycle";
import {
  selectAlerts,
  selectUnitIds,
  useAuditStore,
  useFleetStore,
  type CohortArchive,
  type CohortIncident,
} from "@/lib/stores";
import { AuditChronology } from "../audit-log";
import { canaryLine, cohortRef } from "../cohort-copy";
import {
  cohortActions,
  cohortLog,
  cohortSpans,
  cohortTimes,
  cohortUnits,
  haltRefusal,
  preventedUpdates,
  rollbackChronology,
} from "../cohort-report";
import { escalatedTier } from "../incident-report";
import {
  ReportFigure,
  ReportFooter,
  ReportLetterhead,
  ReportMoments,
  ReportQuote,
  ReportSection,
  ReportShell,
  useGeneratedAt,
} from "../report-surface";
import { ActionsBlock } from "./actions-block";
import { CanaryTable, confirmedFleetSignal } from "./canary-table";
import { FLEET_DIFFERENTIAL, fleetDifferentialStance } from "./differential";
import { PreventedBlock } from "./prevented-block";
import { RollbackBlock } from "./rollback-block";
import { UnitsTable } from "./units-table";

export interface CohortReportSurfaceProps {
  /** The incident at its widest, as the card holds it — not the live derivation. */
  cohort: CohortIncident;
  /**
   * The journals as they stood when the incident was filed, or undefined while
   * it is still open. A filed record must not re-derive from stores a sim
   * reset may since have emptied.
   */
  archive?: CohortArchive;
  onClose(): void;
}

/**
 * The fleet incident, written up. Every section derives from one fleet-scoped
 * log window (`cohortLog`) so no section can read a wider log than another;
 * the finding is stated as a hypothesis, with the canary table as the check.
 */
export function CohortReportSurface({
  cohort,
  archive,
  onClose,
}: CohortReportSurfaceProps) {
  const titleId = React.useId();
  const generatedAt = useGeneratedAt();

  const liveAlerts = useFleetStore(selectAlerts);
  const liveMeta = useFleetStore((s) => s.alertMeta);
  const liveUnits = useFleetStore((s) => s.units);
  const liveUnitIds = useFleetStore(selectUnitIds);
  const liveAudit = useAuditStore((s) => s.entries);

  const alerts = archive?.alerts ?? liveAlerts;
  const meta = archive?.alertMeta ?? liveMeta;
  const units = archive?.units ?? liveUnits;
  const audit = archive?.audit ?? liveAudit;
  const fleetSize = archive?.fleetSize ?? liveUnitIds.length;

  const log = React.useMemo(
    () => cohortLog(audit, cohort.detectedAt),
    [audit, cohort.detectedAt],
  );
  const rows = React.useMemo(
    () => cohortUnits(cohort, alerts, meta, units),
    [cohort, alerts, meta, units],
  );
  const times = React.useMemo(() => cohortTimes(cohort, rows, log), [cohort, rows, log]);
  const spans = React.useMemo(() => cohortSpans(times), [times]);
  const steps = React.useMemo(
    () => rollbackChronology(rows, times.rollbackOrdered),
    [rows, times.rollbackOrdered],
  );
  const actions = React.useMemo(() => cohortActions(log, cohort.fw), [log, cohort.fw]);
  const prevented = React.useMemo(() => preventedUpdates(log), [log]);
  const refusal = React.useMemo(() => haltRefusal(log), [log]);

  const restored = rows.every((r) => r.restored);
  const tier = escalatedTier(actions.map((a) => a.label));
  /** Nothing to compare against is a real fleet; it is not a differential. */
  const comparable = cohort.canary.length > 1;
  const stance = fleetDifferentialStance(
    restored,
    times.rollbackOrdered !== undefined,
    cohort.fw,
  );

  return (
    <ReportShell titleId={titleId} scope="fleet" onClose={onClose}>
      <ReportLetterhead
        titleId={titleId}
        title="Fleet incident report"
        reference={cohortRef(cohort.fw, cohort.detectedAt)}
        subject={
          <>
            Firmware <span className="tnum">{cohort.fw}</span> ·{" "}
            <span className="tnum">{rows.length}</span> units
          </>
        }
        resolved={restored}
        // "Restored", not "resolved": a rollback restores service and leaves
        // the build unexplained.
        statusCopy={{ open: "Open", resolved: "Restored" }}
        tier={tier}
        // The day every clock time below belongs to, plus the zone they were
        // read in. Taken from when the incident was raised rather than from
        // now: the document describes that moment, and a copy printed the next
        // morning must not date itself to the morning.
        dateline={`${calendarDate(times.detected)} · times in ${timeZoneLabel(times.detected)}`}
        onClose={onClose}
      />

      <ReportSection label="Times">
        <ReportMoments
          moments={[
            { key: "detected", label: "Detected", ts: times.detected },
            { key: "halted", label: "Rollout halted", ts: times.halted },
            { key: "ordered", label: "Rollback ordered", ts: times.rollbackOrdered },
            { key: "first", label: "First restored", ts: times.firstRestored },
            { key: "last", label: "Last restored", ts: times.lastRestored },
            { key: "completed", label: "Rollback complete", ts: times.completed },
          ]}
        />
        <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
          {/* Not MTTA/MTTR — those name a unit's incident. Every figure carries
              its endpoints, since the names alone do not say what they run from. */}
          <ReportFigure
            label="Time to contain"
            hint="detected → halted"
            ms={spans.toContain}
          />
          <ReportFigure
            label="Time to order rollback"
            hint="detected → ordered"
            ms={spans.toOrder}
          />
          <ReportFigure
            label="Rollback duration"
            hint="ordered → complete"
            ms={spans.rollbackRan}
          />
          <ReportFigure
            label="Time to restore"
            hint="detected → last unit"
            ms={spans.toRestore}
          />
        </div>
      </ReportSection>

      <ReportSection label="Finding">
        <h3 className="text-heading text-ink">
          {rows.length} units on firmware {cohort.fw} raised the same warning.
        </h3>
        {/* The wire's own sentence: byte-identical across the units is the
            reason they are one incident, so the reader is shown the evidence. */}
        <ReportQuote
          className="mt-4"
          caption={`Reported by ${rows.length} units, byte-identical`}
        >
          <blockquote className="text-small text-ink">{cohort.signature}</blockquote>
        </ReportQuote>
        <p className="mt-4 text-small font-medium text-ink">
          {canaryLine(cohort.canary, cohort.fw)}
        </p>
        <CanaryTable cohort={cohort} fleetSize={fleetSize} />
      </ReportSection>

      {comparable ? (
        <ReportSection label="Differential">
          <p className="text-body text-ink">{confirmedFleetSignal(cohort)}</p>
          <p className="mt-2 text-small text-ink-soft">
            Consistent with: {FLEET_DIFFERENTIAL.consistentWith.join(" · ")}
          </p>
          <p data-slot="fleet-differential-stance" className="mt-1 text-small text-ink">
            {stance.label}: {stance.text}
          </p>
        </ReportSection>
      ) : null}

      <ReportSection label="Affected units">
        <UnitsTable rows={rows} />
      </ReportSection>

      <ReportSection label="Rollback">
        <RollbackBlock
          steps={steps}
          orderedAt={times.rollbackOrdered}
          completedAt={times.completed}
          fw={cohort.fw}
        />
      </ReportSection>

      <ReportSection label="Prevented">
        <PreventedBlock
          prevented={prevented}
          refusal={refusal}
          rolledBack={rows.filter((r) => r.restored).length}
          sinceDetection={spans.toContain}
          fw={cohort.fw}
        />
      </ReportSection>

      <ReportSection label="Actions">
        <ActionsBlock actions={actions} tier={tier} />
      </ReportSection>

      <ReportSection label="Chronology">
        {log.length === 0 ? (
          <p className="text-small text-ink-soft">
            No fleet entries recorded for this incident&rsquo;s window.
          </p>
        ) : (
          <AuditChronology entries={log} />
        )}
      </ReportSection>

      <ReportFooter generatedAt={generatedAt} />
    </ReportShell>
  );
}
