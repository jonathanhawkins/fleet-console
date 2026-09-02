import { POSTURE_GATE_SUFFIX, type ImpactLine } from "./safe-sit-copy";
import { gainRatio, rmsDelta } from "./waveform-math";

/**
 * What the console is allowed to say about a recalibration.
 *
 * Pure, and split from the component for the reason `safe-sit-copy.ts` is:
 * every string here ends up either in a confirmation the operator reads before
 * a robot moves, or in a conclusion the card amends afterwards, so each one is
 * assertable in a test rather than buried in JSX.
 *
 * It measures exactly one thing, `residualReading`, and only because two
 * surfaces need the same answer — see the note there.
 */

/**
 * The gate, on the button itself, in the machine's status voice.
 *
 * Literally the constant DISABLE JOINT's gate uses, not a copy of its text:
 * there is one physical precondition here — the robot is sitting down — and
 * two actions that need it, so two spellings of it would be two things that can
 * drift apart on screen. It is also, deliberately, the sim's own refusal
 * (RECAL_REFUSAL_NOT_SEATED): the console and the robot give one reason between
 * them rather than two a reader has to reconcile.
 */
export const RECAL_GATE_SUFFIX = POSTURE_GATE_SUFFIX;

/** Why, for aria-describedby — the fact the suffix compresses. */
export const RECAL_GATE_NOTE = "Unloaded sweep · permitted only while seated";

/**
 * What a recalibration does to the unit, stated before it is ordered.
 *
 * The third line is the one that matters, and it is the only colour spent in
 * the whole confirmation. An operator who reads "RECALIBRATION COMPLETE" and
 * files the incident has closed a case on a worn actuator: this maneuver
 * rewrites a gain table, and a gain table is not a tendon. Saying so *before*
 * the press is what keeps the partial result thirty seconds later from reading
 * as the console having failed at something it promised.
 *
 * "JOINT DRIVEN THROUGH RANGE", not "joint tested": the robot moves, the
 * operator is entitled to know that is what they are about to cause, and a
 * confirmation that undersells the physical event is a confirmation the live
 * strips contradict.
 *
 * These two lines are the maneuver, which is the same maneuver on every fault.
 * The third — the limit — is `RECAL_LIMIT` below, and `recalImpact` is what
 * assembles them.
 */
const RECAL_MANEUVER: readonly ImpactLine[] = [
  { text: "Joint driven through range · unloaded", tone: "soft" },
  { text: "Unit holds seated posture throughout", tone: "soft" },
];

/**
 * The third line, keyed by the fault it is about to be run against.
 *
 * The other two lines describe the maneuver, which is the same maneuver either
 * way. This one describes its *limit*, and the limit is a property of the
 * diagnosis: a gain table is not a tendon, and an encoder datum is not a
 * mounting bracket. Shipping one sentence for both would put "calibration
 * corrects gain, not wear" in front of an operator whose robot has no gain
 * fault — a confirmation dialog that misstates the thing it is confirming, on
 * the screen whose entire job is to be read before a robot moves.
 *
 * A table, and the same table shape the differentials use, for the same reason:
 * an anomaly this file has not heard of falls back to the general statement
 * rather than to whichever specific one happens to be first.
 */
const RECAL_LIMIT: Readonly<Record<string, ImpactLine>> = {
  gain: { text: "Calibration corrects gain, not wear", tone: "warn" },
  offset: { text: "Calibration corrects the datum, not the mounting", tone: "warn" },
};

const RECAL_LIMIT_GENERAL: ImpactLine = {
  text: "Calibration rewrites a table, not a mechanism",
  tone: "warn",
};

export function recalImpact(anomaly: string): readonly ImpactLine[] {
  return [...RECAL_MANEUVER, RECAL_LIMIT[anomaly] ?? RECAL_LIMIT_GENERAL];
}

/**
 * How far the channel still is from where it should be — stated in the units
 * the fault was stated in.
 *
 * A gain fault is a ratio: the trace has the right shape at the wrong
 * amplitude, so "1.35× reference" is the reading, and it is the reading the
 * verdict's own headline was written in. An offset fault is a displacement: the
 * trace has the right shape at the wrong datum, so the amplitude ratio barely
 * moves when it is corrected (0.21 of datum error is 1.14× on a channel that
 * peaks near 0.6, and re-zeroing it reads as 1.04×) while the deviation itself
 * collapses from 0.211 to 0.013. Printing the ratio for an offset would be a
 * true number that understates its own story by an order of magnitude.
 *
 * So this file measures, once, and that is a deliberate amendment to the rule
 * it used to state ("nothing in this file derives a number"). The rule existed
 * so that the figure in a sentence could not disagree with the figure under the
 * trace, and it was kept by passing an already-measured value in. But *which*
 * measurement to take is now a question with an answer, and two surfaces — the
 * verdict card and the incident report — both need it. A choice duplicated at
 * two call sites is the disagreement waveform-math.ts exists to prevent, one
 * level up. The measuring is still done by that module and by nothing else;
 * this only decides which of its functions the question calls for.
 */
export interface ResidualReading {
  /** The measurement itself, for anything that needs the raw figure. */
  value: number;
  /** Machine voice, caps written literally: "1.35× REFERENCE", "0.013 FROM DATUM". */
  machine: string;
  /** Operator voice: "1.35× reference", "0.013 from datum". */
  operator: string;
}

export function residualReading(
  anomaly: string,
  wave: readonly number[],
  ref: readonly number[],
): ResidualReading {
  if (anomaly === "offset") {
    const value = rmsDelta(wave, ref);
    return {
      value,
      machine: `${value.toFixed(3)} FROM DATUM`,
      operator: `${value.toFixed(3)} from datum`,
    };
  }
  const value = gainRatio(wave, ref);
  return {
    value,
    machine: `${value.toFixed(2)}× REFERENCE`,
    operator: `${value.toFixed(2)}× reference`,
  };
}

/**
 * The verdict, amended by what the calibration was worth.
 *
 * Machine voice, caps written literally (the `commandLine` rule), and composed
 * here rather than in the card because the residual figure appears in two
 * sentences that must not be able to disagree — this line and the trace's own
 * footer both describe the same measurement.
 *
 * Neither branch congratulates anybody. PARTIAL is a warning, and CLEARED is a
 * measurement with a residual printed beside it: the console states outcomes,
 * and a fault that stopped existing is a fact, not an achievement.
 */
export function calibrationAmendment(
  outcome: "partial" | "cleared",
  residual: ResidualReading,
): string {
  return outcome === "cleared"
    ? `CLEARED · CHANNEL RESTORED · RESIDUAL ${residual.machine}`
    : `PARTIAL · RESIDUAL ${residual.machine} · MECHANICAL WEAR INDICATED`;
}

/**
 * What is left on the table after a calibration, keyed by outcome.
 *
 * The scan's differential lists what produces a signature; this lists what
 * still can, once the correctable cause has been ruled out by correcting it.
 * A *table*, not a filter over `ANOMALY_DIFFERENTIALS` — the machine does not
 * improvise pathology, and "drop the first entry" would be this file inferring
 * medicine from array order. A cleared calibration leaves nothing to say, which
 * is why it has no entry rather than an empty one.
 *
 * `offset` has no entry either, and for the same reason from the other side:
 * the only scripted offset clears, so there is no partial result on it for this
 * table to narrow. Writing what a failed re-zero would leave behind would be
 * medicine for a case the sim cannot produce.
 */
const RESIDUAL_DIFFERENTIALS: Readonly<Record<string, readonly string[]>> = {
  gain: ["TENDON WEAR", "ACTUATOR DEGRADATION"],
};

/** `null` when there is nothing the machine knows to say. */
export function residualDifferential(
  anomaly: string,
  outcome: "partial" | "cleared",
): string | null {
  if (outcome === "cleared") return null;
  const causes = RESIDUAL_DIFFERENTIALS[anomaly];
  return causes ? `GAIN DRIFT EXCLUDED · REMAINING ${causes.join(" · ")}` : null;
}
