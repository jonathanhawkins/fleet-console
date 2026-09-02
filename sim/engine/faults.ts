import { type AnomalyKind } from "@/lib/schema";
import { type Joint } from "./constants";
import {
  FAULT_GAIN_END,
  FAULT_GAIN_START,
  INCIDENT_COMPONENT,
  INCIDENT_JOINT,
  INCIDENT_UNIT_ID,
  incidentSeverity,
} from "./incident-knee";
import {
  OFFSET_BIAS,
  OFFSET_COMPONENT,
  OFFSET_JOINT,
  OFFSET_UNIT_ID,
} from "./incident-offset";
import { type EngineConfig, type EngineState, type UnitState } from "./state";

/**
 * The scripted faults and what a calibration is worth on each. A scan
 * measures a fault as a `ChannelFault`, the verdict describes it as a
 * `ScriptedFault`, and a recalibration's outcome is read out of
 * CALIBRATION_OUTCOME by anomaly kind — never by chance, never by unit.
 */

/** How a flagged channel is wrong; `null` is a channel on its reference. The two kinds never blend. */
export type ChannelFault =
  { kind: "gain"; start: number; end: number } | { kind: "offset"; bias: number };

/** One scripted fault: where it is, what it is, and what the verdict says about it. */
export interface ScriptedFault {
  unitId: string;
  joint: Joint;
  component: string;
  anomaly: AnomalyKind;
  channel: ChannelFault;
  /** The verdict's own words, machine voice. */
  summary: string;
  /** Cheapest-first, human escalation last — the order the verdict card reads as a procedure. */
  recommendations: readonly string[];
}

export const KNEE_FAULT: ScriptedFault = {
  unitId: INCIDENT_UNIT_ID,
  joint: INCIDENT_JOINT,
  component: INCIDENT_COMPONENT,
  anomaly: "gain",
  channel: { kind: "gain", start: FAULT_GAIN_START, end: FAULT_GAIN_END },
  summary:
    "LEFT KNEE ACTUATOR A-07: GAIN ANOMALY. LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE.",
  // The card classifies these by identity, not position (safe-sit-copy.ts).
  recommendations: [
    "Recalibrate joint",
    "Command safe sit",
    "Disable joint",
    "Dispatch service",
  ],
};

export const OFFSET_FAULT: ScriptedFault = {
  unitId: OFFSET_UNIT_ID,
  joint: OFFSET_JOINT,
  component: OFFSET_COMPONENT,
  anomaly: "offset",
  channel: { kind: "offset", bias: OFFSET_BIAS },
  summary: `RIGHT ANKLE ACTUATOR A-12: OFFSET ANOMALY. LIVE TRACE DISPLACED ${OFFSET_BIAS.toFixed(2)} FROM REFERENCE DATUM, ENVELOPE INTACT.`,
  // No "Disable joint": this joint carries load perfectly well.
  recommendations: ["Recalibrate joint", "Command safe sit", "Dispatch service"],
};

/**
 * The knee's re-measured gain ramp after a calibration: the correctable
 * component is gone, the wear-driven ramp stays, and the RMS lands between
 * RMS_HEALTHY and RMS_FAILING (components/machine/waveform-math.ts), alert →
 * warn. sim/diagnostics.test.ts holds that band as a contract.
 */
export const CALIB_GAIN_START = 1.18;
export const CALIB_GAIN_END = 1.38;

/**
 * Calibration outcome by anomaly kind — a table, not a coin flip, because the
 * scripted incident must be re-runnable. `gain` → PARTIAL with the residual
 * ramp above; `offset` → CLEARED with `null`, a healthy channel.
 */
export const CALIBRATION_OUTCOME: Readonly<
  Record<AnomalyKind, { outcome: "partial" | "cleared"; residual: ChannelFault | null }>
> = {
  gain: {
    outcome: "partial",
    residual: { kind: "gain", start: CALIB_GAIN_START, end: CALIB_GAIN_END },
  },
  offset: { outcome: "cleared", residual: null },
};

/** The scripted fault live on this unit right now, or null. The knee's fault DEVELOPS (healthy before onset); the ankle's fault IS (until re-zeroed). */
export function activeFault(
  cfg: EngineConfig,
  st: EngineState,
  u: UnitState,
  storylineMs: number,
): ScriptedFault | null {
  if (u.id === INCIDENT_UNIT_ID && incidentSeverity(cfg, storylineMs) > 0)
    return KNEE_FAULT;
  if (u.id === OFFSET_UNIT_ID && !st.offsetCleared) return OFFSET_FAULT;
  return null;
}
