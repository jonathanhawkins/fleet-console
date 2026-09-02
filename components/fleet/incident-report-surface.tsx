"use client";

import * as React from "react";
import { tracePoints } from "@/components/machine/evidence-trace";
import {
  residualReading,
  type ResidualReading,
} from "@/components/machine/recalibrate-copy";
import { acknowledgedTime } from "@/components/machine/safe-sit-copy";
import {
  channelTone,
  gainRatio,
  rmsDelta,
  type ChannelTone,
} from "@/components/machine/waveform-math";
import { type VerdictReport } from "@/lib/schema";
import {
  selectAlerts,
  selectUnit,
  useAuditStore,
  useFleetStore,
  type AuditEntry,
  type DiagChannel,
  type IncidentRecord,
} from "@/lib/stores";
import { cn } from "@/lib/utils";
import { clockTime } from "./alert-lifecycle";
import { AuditChronology } from "./audit-log";
import {
  componentForJoint,
  componentLabel,
  SERVICE_DISCLAIMER,
  serviceDateLabel,
  serviceDueInDays,
  serviceRecord,
} from "./component-spec";
import { verdictLine } from "./incident-banner";
import { incidentRef } from "./incident-history";
import {
  escalatedTier,
  incidentSpans,
  incidentTimes,
  recoveryTier,
  type IncidentTimes,
} from "./incident-report";
import { jointLabel, SectionLabel, useNow } from "@/components/console";
import {
  ReportFigure,
  ReportFooter,
  ReportLetterhead,
  ReportMoments,
  ReportQuote,
  ReportSection,
  ReportShell,
  ReportTable,
  ReportTableHead,
  useGeneratedAt,
  type ReportMoment,
} from "./report-surface";
import { commandLabel } from "./session-events";

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
 * row of moments, the figure, the colophon — is report-surface.tsx, shared with
 * the fleet's write-up (cohort-report-surface.tsx). What stays here is
 * everything this particular report knows: which journals it joins, and what it
 * is allowed to conclude from them.
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
 * under a label that says whose words they are, the way a lab result is
 * reproduced rather than retold, and the operator sentence sits above it.
 *
 * ## The verdict is a hypothesis
 *
 * A diagnosis stated alone reads as a conviction, and a gain anomaly is not one
 * — the trace proves the joint is out of envelope, not *why*. The differential
 * says what the measurement is consistent with and what order to try things in,
 * which is the difference between a report that closes an argument and one that
 * starts the right work.
 */

/* -------------------------------------------------------------------------
   the differential
   ------------------------------------------------------------------------- */

interface Differential {
  /** Causes the measurement cannot yet tell apart, cheapest to establish first. */
  consistentWith: readonly string[];
  /** What to do first, and what not to do yet. */
  recommended: string;
}

/**
 * What a finding is consistent with, by the kind of anomaly it is.
 *
 * Keyed on the report's `anomaly` because that is the field that describes the
 * *measurement*, and the differential is a property of the measurement rather
 * than of the joint it was taken on: a gain anomaly on a knee and a gain
 * anomaly on a shoulder have the same list of candidate causes.
 *
 * Both entries are ordered cheapest-to-establish first, which is what makes
 * `recommended` follow from the list rather than sit beside it. An anomaly with
 * no entry here correctly renders no differential at all rather than the wrong
 * one — the machine lists what it knows or says nothing.
 */
const DIFFERENTIAL: Readonly<Record<string, Differential>> = {
  gain: {
    consistentWith: ["control-gain drift", "tendon wear", "actuator degradation"],
    recommended: "unloaded recalibration before module replacement.",
  },
  /**
   * The counterpart, and the reason the recommendation is worth
   * printing: a displaced trace with an intact envelope is most often a
   * reference the joint has lost rather than a mechanism that has moved, and
   * the difference between those two costs a visit. Re-zeroing settles it in
   * four seconds over the link. If the offset comes back, it was the mount.
   */
  offset: {
    consistentWith: ["encoder zero drift", "mount shift", "linkage backlash"],
    recommended: "unloaded recalibration before any mechanical inspection.",
  },
};

/* -------------------------------------------------------------------------
   the document
   ------------------------------------------------------------------------- */

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
        <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
          <ReportFigure label="Time to acknowledge" hint="MTTA" ms={spans.mtta} />
          <ReportFigure label="Time to diagnose" ms={spans.toDiagnose} />
          <ReportFigure label="Diagnosis to close" ms={spans.toResolve} />
          <ReportFigure label="Time to resolve" hint="MTTR" ms={spans.mttr} />
        </div>
      </ReportSection>

      <ReportSection label="Verdict">
        {/* h3, under the section's own h2 label: the verdict is the section's
            claim, not a peer of the heading that names it. */}
        <h3 className="text-heading text-ink">{verdictLine(report)}</h3>
        {/* The subject, named twice over — joint and part — because the two
            vocabularies are the ones the rest of the console indexes by: the
            telemetry grid speaks joints, the component view speaks parts.
            Absent for a clean pass, whose report is about a unit rather than
            about a part: the sim files those as joint "all", and a subhead
            reading "all" is the page printing a field rather than a fact. */}
        {report.anomaly === "none" ? null : (
          <p className="mt-1 text-small text-ink-soft">
            {jointLabel(report.joint)}
            {part ? ` · ${componentLabel(part)}` : ""}
          </p>
        )}
        {/* The instrument's own words, reproduced. See the note at the top of
            this file: everywhere else in operator space this sentence is
            translated, and a report is the one place that would be a
            paraphrase of evidence. */}
        <ReportQuote className="mt-4" caption="Recorded by the diagnostic scan">
          <blockquote className="text-small text-ink">{report.summary}</blockquote>
        </ReportQuote>
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
          {/* What happened when the cheapest recommendation was actually taken. It sits under "Recommended" rather than replacing it:
              the differential is what the evidence supported, and the attempt
              is what it was worth — a reader deciding whether to send a van
              needs both, in that order. */}
          {calibrationResidual !== null && record.calibration ? (
            <p className="mt-3 text-small text-ink">
              {calibrationOutcomeLine(record.calibration.outcome, calibrationResidual)}
            </p>
          ) : null}
        </ReportSection>
      ) : null}

      <EvidenceBlock
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

/** The order an incident is told in, not the order the fields are stored in. */
const MOMENTS: ReadonlyArray<ReportMoment & { key: keyof IncidentTimes }> = [
  { key: "raised", label: "Raised" },
  { key: "escalated", label: "Escalated" },
  { key: "acked", label: "Acknowledged" },
  { key: "diagnostic", label: "Diagnostic started" },
  { key: "verdict", label: "Verdict" },
  { key: "resolved", label: "Resolved" },
];

/* -------------------------------------------------------------------------
   the measurements
   ------------------------------------------------------------------------- */

const TONE_CLASS: Record<ChannelTone, string> = {
  nominal: "text-ink",
  warn: "text-warn-ink",
  alert: "text-alert-ink",
};

/**
 * Every channel the scan returned, measured exactly as the verdict card
 * measured them.
 *
 * `rmsDelta` and `gainRatio` are imported from the machine's own module rather
 * than reimplemented in operator tones, which is the whole point: the report
 * and the card must not be able to disagree about a number, and the thresholds
 * behind the colouring are the ones the simulator's test suite is written
 * against (waveform-math.ts).
 */
function ChannelTable({
  channels,
  subject,
}: {
  channels: readonly DiagChannel[];
  subject: string;
}) {
  if (channels.length === 0) {
    return (
      <p className="mt-4 text-small text-ink-soft">
        Channel measurements are not on file for this incident.
      </p>
    );
  }

  return (
    <ReportTable measure="compare" className="mt-5">
      <thead>
        <tr className="border-b border-line text-left">
          <ReportTableHead className="pr-4">Joint</ReportTableHead>
          <ReportTableHead align="right" className="pr-4">
            RMS Δ
          </ReportTableHead>
          <ReportTableHead align="right">Gain vs reference</ReportTableHead>
        </tr>
      </thead>
      <tbody>
        {channels.map((channel) => {
          const delta = rmsDelta(channel.wave, channel.ref);
          const gain = gainRatio(channel.wave, channel.ref);
          const tone = channelTone(delta);
          const flagged = channel.joint === subject;
          return (
            <tr
              key={channel.joint}
              data-channel={channel.joint}
              className="border-b border-line last:border-b-0"
            >
              <th scope="row" className="py-2 pr-4 text-left font-normal text-ink">
                {jointLabel(channel.joint)}
                {flagged ? (
                  <span className="ml-2 text-label tracking-normal text-alert-ink">
                    subject
                  </span>
                ) : null}
              </th>
              <td className={cn("py-2 pr-4 text-right tnum", TONE_CLASS[tone])}>
                {delta.toFixed(3)}
              </td>
              <td className={cn("py-2 text-right tnum", TONE_CLASS[tone])}>
                {gain.toFixed(2)}×
              </td>
            </tr>
          );
        })}
      </tbody>
    </ReportTable>
  );
}

/** "five" — counts read as words in a sentence, digits in a table. */
const COUNT_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? `${n}`;
}

/**
 * The one sentence that states what was actually measured.
 *
 * Derived from the channels rather than written down, so it cannot drift from
 * the table directly above it: the reading is the subject channel's, and the
 * count is every other channel that came in under the healthy threshold.
 *
 * The reading is taken in the units the fault is in (`residualReading`), and
 * that is not decoration. An offset states as an amplitude ratio would read
 * "gain 1.14× reference envelope" — a true number, in the wrong measure,
 * describing a channel whose amplitude is not what is wrong with it. The
 * sentence names its own measure so the reader knows which one they were given.
 */
export function confirmedSignal(
  report: VerdictReport,
  channels: readonly DiagChannel[] | undefined,
): string {
  const list = channels ?? [];
  const subject = list.find((c) => c.joint === report.joint);
  const within = list.filter(
    (c) => c.joint !== report.joint && channelTone(rmsDelta(c.wave, c.ref)) === "nominal",
  ).length;
  if (!subject) {
    return `${report.anomaly.charAt(0).toUpperCase()}${report.anomaly.slice(1)} anomaly on ${jointLabel(report.joint).toLowerCase()}; channel measurements are not on file.`;
  }
  const joints = `${countWord(within)} joint${within === 1 ? "" : "s"} within tolerance`;
  const reading = residualReading(report.anomaly, subject.wave, subject.ref);
  return report.anomaly === "offset"
    ? `Trace displaced ${reading.operator}, envelope intact, ${joints}.`
    : `Gain ${reading.operator} envelope, ${joints}.`;
}

/* -------------------------------------------------------------------------
   evidence
   ------------------------------------------------------------------------- */

/**
 * The mirrored joint — a left knee's control is the right one.
 *
 * The same rule the verdict card applies (`pairJoint`), written out here rather
 * than imported: that module is machine space, it reaches back through the
 * console barrel for its own imports, and pulling it in to read four lines of
 * naming convention would drag the card, its confirmation dialog and its motion
 * into this chunk. It is joint *vocabulary*, not diagnosis — and if it is ever
 * wrong the report simply shows no control trace.
 */
function mirroredJoint(joint: string): string | null {
  if (joint.endsWith("_L")) return `${joint.slice(0, -2)}_R`;
  if (joint.endsWith("_R")) return `${joint.slice(0, -2)}_L`;
  return null;
}

function EvidenceBlock({
  channels,
  subject,
  calibration,
}: {
  channels: readonly DiagChannel[];
  subject: string;
  calibration: IncidentRecord["calibration"];
}) {
  const exhibit = channels.find((c) => c.joint === subject);
  const pair = mirroredJoint(subject);
  const control = pair ? channels.find((c) => c.joint === pair) : undefined;
  if (!exhibit) return null;
  // A re-measure of some other joint is not evidence about this exhibit.
  const post = calibration?.joint === subject ? calibration.wave : undefined;

  return (
    <ReportSection label="Evidence">
      {/* Still two figures with a recalibration on file, not three: the
          before/after belongs INSIDE the subject frame, because the claim being
          made is that this channel came down, and a third box beside it would
          make that a comparison the reader has to perform. */}
      <div className="flex flex-col gap-4 sm:flex-row">
        <ReportTrace channel={exhibit} role="Subject" subject post={post} />
        {control ? <ReportTrace channel={control} role="Control" /> : null}
      </div>
      <p className="mt-3 text-label tracking-normal text-ink-soft">
        Live trace against the joint&rsquo;s calibration reference, 120 samples.
        {post ? " Subject shows the trace before and after recalibration." : ""}
      </p>
    </ReportSection>
  );
}

const VIEW = { w: 240, h: 64 };

/**
 * One channel, frozen — the machine card's exhibit, redrawn in daylight.
 *
 * The geometry is `tracePoints`, imported from the card's own trace so the two
 * pictures are the same picture; only the palette changes, because a phosphor
 * trace on black in the middle of a warm-white document would read as a
 * screenshot of a different product pasted into a report. Ink for the live
 * trace, muted for the reference it is being judged against, and clay only when
 * the channel is genuinely out of envelope — the one place this document spends
 * a colour.
 *
 * SVG, like the card, and for the card's reason: it is a still of samples that
 * stopped arriving, it has to scale with the page, and — the reason that
 * matters most here — a canvas does not print.
 */
function ReportTrace({
  channel,
  role,
  subject = false,
  post,
}: {
  channel: DiagChannel;
  role: string;
  subject?: boolean;
  /** The same channel re-measured after a recalibration, when one was run. */
  post?: readonly number[];
}) {
  const delta = rmsDelta(channel.wave, channel.ref);
  const gain = gainRatio(channel.wave, channel.ref);
  const postDelta = post ? rmsDelta(post, channel.ref) : null;
  const postGain = post ? gainRatio(post, channel.ref) : null;
  // Which reading the figure is *about*: with a re-measure on file the current
  // state of the joint is the later one, so that is what decides whether this
  // document spends its one colour here. A frame still tinted for a breach the
  // channel has come out of would be the report arguing against its own trace.
  const breach = channelTone(postDelta ?? delta) === "alert";

  return (
    <figure
      data-evidence={channel.joint}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-2 rounded-lg border p-4",
        subject ? "border-alert/40 bg-alert-tint/40" : "border-line bg-surface",
      )}
    >
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-small text-ink">{jointLabel(channel.joint)}</span>
        <SectionLabel as="span" tone={subject ? "alert" : "muted"}>
          {role}
        </SectionLabel>
      </figcaption>

      <svg
        viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
        preserveAspectRatio="none"
        className="block h-16 w-full"
        role="img"
        aria-label={
          postGain === null
            ? `${jointLabel(channel.joint)} live trace against reference, ${gain.toFixed(2)} times amplitude`
            : `${jointLabel(channel.joint)} live trace against reference, ${gain.toFixed(2)} times amplitude before recalibration, ${postGain.toFixed(2)} times after`
        }
      >
        <line
          x1="0"
          y1={VIEW.h / 2}
          x2={VIEW.w}
          y2={VIEW.h / 2}
          stroke="var(--line)"
          strokeWidth="1"
        />
        <polyline
          data-role="reference"
          points={tracePoints(channel.ref)}
          fill="none"
          stroke="var(--ink-soft)"
          strokeOpacity="0.45"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          data-role={post ? "pre" : "live"}
          points={tracePoints(channel.wave)}
          fill="none"
          stroke={post ? "var(--alert)" : breach ? "var(--alert)" : "var(--ink)"}
          strokeOpacity={post ? "0.3" : "1"}
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
        />
        {post ? (
          <polyline
            data-role="live"
            points={tracePoints(post)}
            fill="none"
            stroke={breach ? "var(--alert)" : "var(--ink)"}
            strokeWidth="1.25"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>

      <div className="flex items-baseline justify-between gap-3 text-label tracking-normal text-ink-soft">
        <span className="tnum">
          RMS Δ {delta.toFixed(3)}
          {postDelta === null ? null : ` → ${postDelta.toFixed(3)}`}
        </span>
        <span className={cn("tnum", breach ? "text-alert-ink" : undefined)}>
          {postGain === null
            ? `${gain.toFixed(2)}× reference`
            : `${gain.toFixed(2)}× → ${postGain.toFixed(2)}× reference`}
        </span>
      </div>
    </figure>
  );
}

/* -------------------------------------------------------------------------
   actions
   ------------------------------------------------------------------------- */

interface ExecutedCommand {
  ref: string;
  label: string;
  acceptedAt?: number;
  completedAt?: number;
  failedAt?: number;
}

/**
 * The commands that actually reached the robot, folded back into one row each.
 *
 * The log records a command three times — accepted, then complete or refused —
 * which is right for a log and wrong for a report: an operator reading a
 * write-up wants one line per thing they did, with what became of it.
 */
export function executedCommands(entries: readonly AuditEntry[]): ExecutedCommand[] {
  const byRef = new Map<string, ExecutedCommand>();
  // Oldest first, so a row is built in the order its beats happened.
  for (const entry of [...entries].reverse()) {
    if (!entry.kind.startsWith("command-") || entry.ref === undefined) continue;
    const row = byRef.get(entry.ref) ?? {
      ref: entry.ref,
      label: commandLabel(entry.ref),
    };
    if (entry.kind === "command-accepted") row.acceptedAt = entry.ts;
    if (entry.kind === "command-complete") row.completedAt = entry.ts;
    if (entry.kind === "command-failed") row.failedAt = entry.ts;
    byRef.set(entry.ref, row);
  }
  return [...byRef.values()];
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

function ActionsBlock({
  record,
  executed,
}: {
  record: IncidentRecord;
  executed: readonly ExecutedCommand[];
}) {
  const nothing = record.acknowledged.length === 0 && executed.length === 0;

  return (
    <ReportSection label="Actions">
      {nothing ? (
        // Said plainly rather than omitted, exactly as the history row does: "no
        // actions were taken" is itself a fact about an incident.
        <p className="text-small text-ink-soft">No actions were recorded or executed.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {executed.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SectionLabel as="h3" tone="ink">
                Executed on the unit
              </SectionLabel>
              <ul className="flex flex-col divide-y divide-line">
                {executed.map((command) => (
                  <li
                    key={command.ref}
                    data-command={command.ref}
                    className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="text-small text-ink">{command.label}</span>
                    <span className="tnum text-small text-ink-soft">
                      {commandOutcome(command)}
                    </span>
                    <span className="ml-auto">
                      <TierTag action={command.label} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {record.acknowledged.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SectionLabel as="h3" tone="ink">
                Recorded to the incident
              </SectionLabel>
              <ul className="flex flex-col divide-y divide-line">
                {record.acknowledged.map((action) => {
                  const at =
                    record.startedAt === undefined
                      ? undefined
                      : acknowledgedTime(record.unitId, record.startedAt, action);
                  return (
                    <li
                      key={action}
                      data-action={action}
                      className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
                    >
                      <span className="text-small text-ink">{action}</span>
                      <span className="tnum text-small text-ink-soft">
                        {/* No time on file is possible — an acknowledgement
                            restored without the press that made it — and the
                            honest answer is the word alone rather than a
                            plausible-looking clock reading nobody observed. */}
                        {at === undefined ? "recorded" : `recorded ${clockTime(at)}`}
                      </span>
                      <span className="ml-auto">
                        <TierTag action={action} />
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="text-label tracking-normal text-ink-soft">
                Recorded actions enter this incident; no command was sent to the unit.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </ReportSection>
  );
}

function commandOutcome(command: ExecutedCommand): string {
  if (command.failedAt !== undefined) return `refused ${clockTime(command.failedAt)}`;
  if (command.completedAt !== undefined)
    return `complete ${clockTime(command.completedAt)}`;
  if (command.acceptedAt !== undefined)
    return `accepted ${clockTime(command.acceptedAt)}`;
  return "no outcome recorded";
}

/* -------------------------------------------------------------------------
   service
   ------------------------------------------------------------------------- */

/**
 * The part's own history, on the report about the part.
 *
 * This is the fact that turns a measurement into an explanation — a knee out of
 * envelope is a fault; a knee out of envelope two hundred and thirteen days
 * into a hundred and eighty day interval is a cause — and it is the same record
 * the part card shows, read from the same module so the two cannot disagree.
 */
function ServiceBlock({ record, now }: { record: IncidentRecord; now: number }) {
  const part = componentForJoint(record.report.joint);
  if (!part) return null;

  const service = serviceRecord(part);
  const due = serviceDueInDays(service);
  const serviced = serviceDateLabel(service, now);
  const dispatched = record.acknowledged.some((a) => /dispatch/i.test(a));

  return (
    <ReportSection label="Service">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <p className="text-small text-ink">
          {componentLabel(part)} · last serviced{" "}
          <span className="tnum">{serviced ?? "—"}</span>
        </p>
        <span
          className={cn("tnum text-small", due < 0 ? "text-warn-ink" : "text-ink-soft")}
        >
          {due < 0 ? `${Math.abs(due)} days overdue` : `Due in ${due} days`}
        </span>
      </div>
      <p className="mt-1 text-small text-ink-soft">{service.note}</p>
      {dispatched ? (
        <p className="mt-3 text-small text-ink">Dispatch service recorded.</p>
      ) : null}
      <p className="mt-3 text-label tracking-normal text-ink-soft">
        {SERVICE_DISCLAIMER}
      </p>
    </ReportSection>
  );
}

/**
 * What the recalibration was worth, in operator voice.
 *
 * The machine card states this in its own terse register ("PARTIAL · RESIDUAL
 * 1.35× REFERENCE"); a report is read by someone deciding whether to send a
 * technician, so it says the same fact as a sentence and adds the consequence
 * the terse version leaves implicit. That split is this document's standing
 * rule — the instrument's words are quoted, everything else is translated.
 *
 * `residual` arrives already measured, from the archived channels, by the one
 * function in the product that measures amplitude ratios. Nothing here derives
 * a number.
 *
 * It lives in this file rather than beside the recovery ladder in
 * incident-report.ts, and that is a budget decision with a rule behind it: that
 * module stays free of JSX so it can sit in the unit page's INITIAL JS for the
 * sake of one small thing the page needs (the open signal). Two paragraphs of
 * document prose are not that. They belong in the half that is code-split
 * behind the document nobody has opened yet.
 */
export function calibrationOutcomeLine(
  outcome: "partial" | "cleared",
  residual: ResidualReading,
): string {
  return outcome === "cleared"
    ? `Unloaded recalibration was run over the link and the channel returned to reference, residual ${residual.operator}. The fault cleared without a visit and the incident did not leave remote operations.`
    : `Unloaded recalibration was run over the link. The channel improved to ${residual.operator} and stayed outside envelope, which excludes gain drift and leaves the mechanical causes — a calibration rewrites a gain table, not a tendon.`;
}
