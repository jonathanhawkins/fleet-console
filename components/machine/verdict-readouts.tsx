"use client";

import * as React from "react";
import { type DiagChannel, type DiagSession } from "@/lib/stores";
import { cn } from "@/lib/utils";
import {
  calibrationAmendment,
  calibrationSummary,
  isRestored,
  residualDifferential,
  residualReading,
  SCAN_TENSE_LABEL,
  type CalibrationOutcome,
} from "./recalibrate-copy";
import { anomalyDifferential } from "./scan-copy";

/**
 * What the scan concluded, as prose: the summary line, the differential it
 * argues from, and what is left of that differential once a treatment has been
 * tried. Composed by `VerdictCard`; separated from it because these are
 * readouts with no state and no decisions, and the card is nothing but state
 * and decisions.
 */

/**
 * The machine's own prose, and its tense.
 *
 * One paragraph until a calibration clears the fault, and two afterwards, and
 * the second one is the whole reason this is a component rather than a line of
 * JSX. `report.summary` is written in the present — "LIVE TRACE DISPLACED 0.21
 * FROM REFERENCE DATUM" — because when the scanner wrote it the trace was
 * displaced by 0.21. After a cleared re-measure it is displaced by 0.012, and
 * that sentence left standing on its own is the most misleading thing on the
 * card: the machine's own words, in the present tense, about a measurement that
 * has been superseded.
 *
 * It is not rewritten and it is not dropped. It is *dated* — labelled AT SCAN
 * and dropped one luminance tier — and the sentence that is true now is printed
 * under it at full phosphor. The scan's finding stays on the record where a
 * reader can see what the calibration was measured against; what changes is
 * which of the two lines the card is asserting.
 *
 * A partial result gets neither treatment. The report's summary is still an
 * accurate description of that channel — the trace really is still off its
 * reference — so there is nothing to date and nothing to add.
 */
export function VerdictSummary({
  summary,
  anomaly,
  calibration,
  channels,
}: {
  summary: string;
  anomaly: string;
  calibration: DiagSession["calibration"];
  channels: readonly DiagChannel[];
}) {
  // The same measurement the amendment and the trace's own footer print, from
  // the same two arrays: three sentences about one number, one number.
  const after = React.useMemo(() => {
    if (!calibration) return null;
    const ref = channels.find((c) => c.joint === calibration.joint)?.ref;
    if (!ref) return null;
    return calibrationSummary(
      calibration.outcome,
      residualReading(anomaly, calibration.wave, ref),
    );
  }, [anomaly, calibration, channels]);

  if (!after) {
    return <p className="mt-1 max-w-[52ch] text-small text-ink-soft">{summary}</p>;
  }

  return (
    <div className="mt-1 flex max-w-[52ch] flex-col gap-1">
      <p className="text-small text-ink-muted">
        {/* The date stamp is a label, not a sentence: it is the same 10px
            wide-tracked idiom every other piece of metadata on this board
            wears, so it reads as a marker on the line rather than as the first
            words of it. */}
        <span className="text-label uppercase">{SCAN_TENSE_LABEL} · </span>
        {summary}
      </p>
      <p className="text-small text-ink">{after}</p>
    </div>
  );
}

/**
 * The differential, and — once the cheapest rung has been tried — what the
 * attempt was worth.
 *
 * Its own component so the header's subscription surface stays exactly what it
 * renders: a null differential mounts nothing at all.
 *
 * ## Why the conclusion amends rather than moves
 *
 * The headline still says KNEE_L · ACTUATOR A-07 · GAIN ANOMALY after a partial
 * calibration, because that is still what the scan found and a verdict that
 * rewrote itself on a treatment would be a diagnosis with no history. What
 * changes is what is left: the correctable cause has now been corrected and the
 * trace did not come back, so GAIN DRIFT leaves the differential and what
 * remains is mechanical. That is the sentence that makes DISPATCH SERVICE the
 * conclusion of an argument instead of the third button on a card.
 *
 * The residual is measured here by the same function the trace's own footer
 * measures with, from the same two arrays. Two sentences about one measurement,
 * one measurement.
 */
export function VerdictDifferential({
  anomaly,
  calibration,
  channels,
}: {
  anomaly: string;
  calibration: DiagSession["calibration"];
  channels: readonly DiagChannel[];
}) {
  const differential = anomalyDifferential(anomaly);
  const residual = React.useMemo(() => {
    if (!calibration) return null;
    const ref = channels.find((c) => c.joint === calibration.joint)?.ref;
    return ref ? residualReading(anomaly, calibration.wave, ref) : null;
  }, [anomaly, calibration, channels]);

  if (!differential && !calibration) return null;
  const cleared = isRestored(calibration);
  return (
    <>
      {differential ? (
        <p className="text-label text-ink-soft uppercase">{differential}</p>
      ) : null}
      {calibration && residual !== null ? (
        <>
          {/* Warn on a partial, and it is the only colour this block spends: an
              operator who reads a completed maneuver and files the incident is
              the one that line exists to stop, and PARTIAL is the word doing
              the work. A cleared result spends none — full phosphor, the tone
              every other stated fact on this board is printed in. Amber would
              be a warning about nothing, and the board has no colour for good
              news because the console does not celebrate. */}
          <p className={cn("text-label uppercase", cleared ? "text-ink" : "text-warn")}>
            {calibrationAmendment(calibration.outcome, residual)}
          </p>
          <ResidualDifferential anomaly={anomaly} outcome={calibration.outcome} />
        </>
      ) : null}
    </>
  );
}

/** What is still on the table, or nothing when the machine has nothing to say. */
export function ResidualDifferential({
  anomaly,
  outcome,
}: {
  anomaly: string;
  outcome: CalibrationOutcome;
}) {
  const remaining = residualDifferential(anomaly, outcome);
  if (!remaining) return null;
  return <p className="text-label text-ink-soft uppercase">{remaining}</p>;
}
