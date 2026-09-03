"use client";

import * as React from "react";
import { residualReading } from "@/components/machine/recalibrate-copy";
import { type VerdictReport } from "@/lib/schema";
import {
  selectAlerts,
  selectUnit,
  useAuditStore,
  useFleetStore,
  type IncidentRecord,
} from "@/lib/stores";
import { jointLabel, useNow } from "@/components/console";
import { AuditChronology } from "../audit-log";
import {
  componentForJoint,
  componentLabel,
  type ComponentId,
} from "../component-spec";
import { verdictLine } from "../incident-banner";
import { incidentRef } from "../incident-history";
import {
  escalatedTier,
  incidentSpans,
  incidentTimes,
  type IncidentTimes,
} from "../incident-report";
import {
  ReportFigure,
  ReportFooter,
  ReportLetterhead,
  ReportMoments,
  ReportSection,
  ReportShell,
  useGeneratedAt,
  type ReportMoment,
} from "../report-surface";
import { ActionsBlock, executedCommands } from "./actions-block";
import { ChannelTable, confirmedSignal } from "./channel-table";
import { calibrationOutcomeLine, DIFFERENTIAL } from "./differential";
import { EvidenceBlock } from "./evidence-block";
import { ServiceBlock } from "./service-block";

/**
 * The incident, written up.
 *
 * Everything else in this console answers "what is happening"; this answers
 * "what happened", once, in a form somebody can print, file or argue with. That
 * is why it is a *document* and not a modal card — full width, one column of
 * reading, sections in the order an incident is told rather than in the order
 * the data was convenient. A card would have made it a bigger tooltip.
 *
 * The document's *shape* — the surface, the letterhead, the ruled section, the
 * rail of moments, the figure, the colophon — is report-surface.tsx, shared
 * with the fleet's write-up (cohort-report-surface). What stays in this folder
 * is everything this particular report knows: which journals it joins, and what
 * it is allowed to conclude from them, one section to a file.
 *
 * ## It invents nothing
 *
 * Every figure here is derived from a journal that already existed
 * (incident-report.ts does the joining), and where a journal is silent the
 * report prints an em dash and says so. A service report that fills a missing
 * acknowledgement with a plausible time is worse than one with a gap in it: the
 * gap is a fact about the incident, and this is the surface an operator would
 * quote in a dispute.
 *
 * ## The instrument is quoted, not paraphrased
 *
 * Operator space translates the machine's voice everywhere else — the banner
 * says "Left knee actuator A-07: gain anomaly" where the scan said "LIVE TRACE
 * 1.4-1.8x REFERENCE ENVELOPE" — because those surfaces are *speaking to* an
 * operator. A report *cites*. So the machine's own summary appears verbatim
 * under a label that says whose words they are, in the machine's own typeface,
 * over the traces it was written about (evidence-block.tsx).
 *
 * ## Each fact is stated once
 *
 * The document's sections are cumulative — verdict, then what the verdict is
 * consistent with, then the record it rests on — and the discipline that keeps
 * that readable is that no two of them say the same thing in different words.
 * A subject line repeating the vocabulary already in the headline, a quotation
 * echoing the sentence above it, an action printed under both the commands and
 * the acknowledgements: each of those reads as a page arguing with itself, and
 * each is suppressed at the point where the fact is already on the page.
 */

export interface IncidentReportSurfaceProps {
  record: IncidentRecord;
  onClose(): void;
}

export function IncidentReportSurface({ record, onClose }: IncidentReportSurfaceProps) {
  const titleId = React.useId();
  const now = useNow();

  const unit = useFleetStore(selectUnit(record.unitId));
  const alerts = useFleetStore(selectAlerts);
  const meta = useFleetStore((s) => s.alertMeta);
  const audit = useAuditStore((s) => s.entries);
  const generatedAt = useGeneratedAt();

  const times = React.useMemo(
    () => incidentTimes(record, alerts, meta, audit),
    [record, alerts, meta, audit],
  );
  const spans = React.useMemo(() => incidentSpans(times), [times]);
  /**
   * The archived exhibits ride the record itself; absent means "not on file".
   * Memoized because the residual below depends on it: a fresh `[]` every
   * render would re-measure a calibration on every pass for no reason.
   */
  const channels = React.useMemo(() => record.channels ?? [], [record.channels]);

  /** The incident's own window, so the chronology is this call and not the shift. */
  const chronology = React.useMemo(() => {
    const from = Math.min(
      times.raised ?? times.verdict,
      times.diagnostic ?? times.verdict,
    );
    const to = (times.resolved ?? times.verdict) + 1_000;
    return audit.filter((e) => e.unitId === record.unitId && e.ts >= from && e.ts <= to);
  }, [audit, record.unitId, times]);

  const report = record.report;
  const resolved = times.resolved !== undefined;
  const part = componentForJoint(report.joint);
  const executed = executedCommands(chronology);
  const tier = escalatedTier([...record.acknowledged, ...executed.map((c) => c.label)]);
  const differential = DIFFERENTIAL[report.anomaly];
  const headline = verdictLine(report);
  const subline = verdictSubline(headline, report, part);
  /**
   * The residual, measured from the archived arrays rather than read off a
   * field — the wire deliberately carries no residual, so that the number in
   * this sentence and the number under the trace below it cannot be two
   * different measurements (lib/schema/messages.ts, the `recalibration`
   * variant).
   */
  const calibrationResidual = React.useMemo(() => {
    const cal = record.calibration;
    if (!cal) return null;
    const ref = channels.find((c) => c.joint === cal.joint)?.ref;
    return ref ? residualReading(report.anomaly, cal.wave, ref) : null;
  }, [record.calibration, channels, report.anomaly]);

  return (
    <ReportShell titleId={titleId} scope="unit" onClose={onClose}>
      <ReportLetterhead
        titleId={titleId}
        title="Incident report"
        reference={incidentRef(record.unitId, record.report.ts)}
        subject={
          <>
            {unit?.name ?? "Unknown unit"} · <span className="tnum">{record.unitId}</span>
          </>
        }
        resolved={resolved}
        tier={tier}
        onClose={onClose}
      />

      <ReportSection label="Times">
        <ReportMoments moments={MOMENTS.map((m) => ({ ...m, ts: times[m.key] }))} />
        {/* Every figure carries the two moments it runs between, the way the
            fleet report's band does: the names alone do not say where a span
            starts, and a band where only some figures are glossed reads as two
            kinds of number. The acronyms ride the two spans that have one,
            for the operator who already plans in them. */}
        <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
          <ReportFigure
            label="Time to acknowledge"
            hint="raised → acknowledged · MTTA"
            ms={spans.mtta}
          />
          <ReportFigure
            label="Time to diagnose"
            hint="raised → diagnostic"
            ms={spans.toDiagnose}
          />
          <ReportFigure
            label="Diagnosis to close"
            hint="diagnostic → resolved"
            ms={spans.toResolve}
          />
          <ReportFigure
            label="Time to resolve"
            hint="raised → resolved · MTTR"
            ms={spans.mttr}
          />
        </div>
      </ReportSection>

      <ReportSection label="Verdict">
        {/* h3, under the section's own h2 label: the verdict is the section's
            claim, not a peer of the heading that names it. */}
        <h3 className="text-heading text-ink">{headline}</h3>
        {subline ? <p className="mt-1 text-small text-ink-soft">{subline}</p> : null}
        <ChannelTable channels={channels} subject={report.joint} />
      </ReportSection>

      {differential ? (
        <ReportSection label="Differential">
          <p className="text-body text-ink">{confirmedSignal(report, channels)}</p>
          <p className="mt-2 text-small text-ink-soft">
            Consistent with: {differential.consistentWith.join(" · ")}
          </p>
          <p className="mt-1 text-small text-ink">
            Recommended: {differential.recommended}
          </p>
          {/* What happened when the cheapest recommendation was actually taken.
              It sits under "Recommended" rather than replacing it: the
              differential is what the evidence supported, and the attempt is
              what it was worth — a reader deciding whether to send a van needs
              both, in that order. */}
          {calibrationResidual !== null && record.calibration ? (
            <p className="mt-3 text-small text-ink">
              {calibrationOutcomeLine(record.calibration.outcome, calibrationResidual)}
            </p>
          ) : null}
        </ReportSection>
      ) : null}

      <EvidenceBlock
        summary={report.summary}
        channels={channels}
        subject={report.joint}
        calibration={record.calibration}
      />

      <ReportSection label="Chronology">
        {chronology.length === 0 ? (
          <p className="text-small text-ink-soft">
            No entries recorded for this incident&rsquo;s window.
          </p>
        ) : (
          <AuditChronology entries={chronology} unitName={unit?.name} />
        )}
      </ReportSection>

      <ActionsBlock record={record} executed={executed} />

      <ServiceBlock record={record} now={now} />

      <ReportFooter generatedAt={generatedAt} />
    </ReportShell>
  );
}

/**
 * The order an incident is told in, not the order the fields are stored in.
 *
 * The words are the chronology's own kind labels, so the rail at the top of the
 * document and the log two sections down name the same six beats identically —
 * and none of them is long enough to wrap a rail cell, which "Diagnostic
 * started" was.
 */
const MOMENTS: ReadonlyArray<ReportMoment & { key: keyof IncidentTimes }> = [
  { key: "raised", label: "Raised" },
  { key: "escalated", label: "Escalated" },
  { key: "acked", label: "Acknowledged" },
  { key: "diagnostic", label: "Diagnostic" },
  { key: "verdict", label: "Verdict" },
  { key: "resolved", label: "Resolved" },
];

/**
 * The vocabularies the headline has not already used.
 *
 * The subject is worth naming twice over — joint and part — because those are
 * the two indexes the rest of the console is browsed by: the telemetry grid
 * speaks joints, the component view speaks parts. But the headline is built
 * from the same two words ("Left knee actuator A-07: gain anomaly"), so
 * printing them underneath it produced a stutter rather than a second index.
 *
 * So the line is what is left after the headline has been read: usually
 * nothing, which prints nothing. A clean pass names no subject at all — the sim
 * files those as joint "all", and a subhead reading "all" is the page printing
 * a field rather than a fact.
 */
export function verdictSubline(
  headline: string,
  report: VerdictReport,
  part: ComponentId | null,
): string | null {
  if (report.anomaly === "none") return null;
  const unsaid = [jointLabel(report.joint), part === null ? null : componentLabel(part)]
    .filter((term): term is string => term !== null && !headline.includes(term))
    .filter((term, i, all) => all.indexOf(term) === i);
  return unsaid.length === 0 ? null : unsaid.join(" · ");
}
