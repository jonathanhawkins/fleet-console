import { type ResidualReading } from "@/components/machine/recalibrate-copy";

/**
 * ## The verdict is a hypothesis
 *
 * A diagnosis stated alone reads as a conviction, and a gain anomaly is not one
 * — the trace proves the joint is out of envelope, not *why*. The differential
 * says what the measurement is consistent with and what order to try things in,
 * which is the difference between a report that closes an argument and one that
 * starts the right work.
 */
export interface Differential {
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
export const DIFFERENTIAL: Readonly<Record<string, Differential>> = {
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
 * It lives here rather than beside the recovery ladder in incident-report.ts,
 * and that is a budget decision with a rule behind it: that module stays free
 * of JSX so it can sit in the unit page's INITIAL JS for the sake of one small
 * thing the page needs (the open signal). Two paragraphs of document prose are
 * not that. They belong in the half that is code-split behind the document
 * nobody has opened yet.
 */
export function calibrationOutcomeLine(
  outcome: "partial" | "cleared",
  residual: ResidualReading,
): string {
  return outcome === "cleared"
    ? `Unloaded recalibration was run over the link and the channel returned to reference, residual ${residual.operator}. The fault cleared without a visit and the incident did not leave remote operations.`
    : `Unloaded recalibration was run over the link. The channel improved to ${residual.operator} and stayed outside envelope, which excludes gain drift and leaves the mechanical causes — a calibration rewrites a gain table, not a tendon.`;
}
