import { type FleetMessage } from "@/lib/schema";
import { type Joint } from "./constants";
import { clamp01 } from "./rng";
import { raiseAlert, requireUnit, type EngineConfig, type EngineState } from "./state";

/**
 * The scripted incident (PRD §4): N-07's left knee actuator develops a gain
 * anomaly over tendon wear. Temperature climbs and torque ripples from onset,
 * an amber fires, then a red; the fault DEVELOPS, so a scan run before onset
 * correctly finds a healthy joint. This is the golden path's storyline.
 */

export const INCIDENT_UNIT_ID = "N-07";
export const INCIDENT_JOINT = "knee_L" satisfies Joint;
export const INCIDENT_COMPONENT = "actuator_A07";

/** Storyline beats, ms of storyline time (zeroed by RESET_SIM). */
export interface IncidentTimeline {
  /** N-07 knee_L temperature starts climbing, torque ripple begins. */
  onsetMs: number;
  /** Amber alert fires; N-07 status → amber. */
  amberAtMs: number;
  /** Red alert fires; N-07 status → red. */
  redAtMs: number;
}

/** Real demo pacing: ~15 s calm, visible climb, amber at 28 s, red at 38 s. */
export const DEFAULT_TIMELINE: IncidentTimeline = {
  onsetMs: 15_000,
  amberAtMs: 28_000,
  redAtMs: 38_000,
};

/** Failing-channel gain ramp: live trace amplitude vs reference across the scan window. */
export const FAULT_GAIN_START = 1.35;
export const FAULT_GAIN_END = 1.8;

/** 0 → calm; ramps to 1 at amber; 1 → 2 between amber and red; plateaus after. */
export function incidentSeverity(cfg: EngineConfig, storylineMs: number): number {
  const { onsetMs, amberAtMs, redAtMs } = cfg.timeline;
  if (storylineMs < onsetMs) return 0;
  const a = clamp01((storylineMs - onsetMs) / (amberAtMs - onsetMs));
  const b = clamp01((storylineMs - amberAtMs) / (redAtMs - amberAtMs));
  return a + b;
}

function kneeAlertMessage(name: string, severity: "amber" | "red"): string {
  return severity === "amber"
    ? `${name}: left knee actuator trending hot, projected to overheat within 6 hours`
    : `${name}: left knee actuator overheating, torque ripple detected`;
}

/** Alerts due in storyline window (prevMs, curMs]; also flips N-07's status. */
export function kneeCrossings(
  cfg: EngineConfig,
  st: EngineState,
  prevMs: number,
  curMs: number,
): FleetMessage[] {
  const out: FleetMessage[] = [];
  const { amberAtMs, redAtMs } = cfg.timeline;
  if (prevMs < amberAtMs && curMs >= amberAtMs) {
    const u = requireUnit(st, INCIDENT_UNIT_ID);
    u.status = "amber";
    out.push(
      raiseAlert(cfg, st, u, "amber", kneeAlertMessage(u.name, "amber"), amberAtMs),
    );
  }
  if (prevMs < redAtMs && curMs >= redAtMs) {
    const u = requireUnit(st, INCIDENT_UNIT_ID);
    u.status = "red";
    out.push(raiseAlert(cfg, st, u, "red", kneeAlertMessage(u.name, "red"), redAtMs));
  }
  return out;
}
