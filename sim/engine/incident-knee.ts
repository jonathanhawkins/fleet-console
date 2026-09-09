import { type FleetMessage } from "@/lib/schema";
import { type Joint } from "./constants";
import { clamp01 } from "./rng";
import { PREROLL_LEAD_MS, PREROLL_MS } from "./preroll";
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

/**
 * Demo pacing, stated against the moment the console starts watching.
 *
 * A run begins at `PREROLL_MS` — the fleet has already been going for that
 * long and the console is handed the history — so subtracting it gives what
 * someone who just opened the link actually sees: 2 s of calm, the trend
 * watch naming the suspect around 6 s, amber at 15 s, red at 25 s.
 *
 * The intervals are what they always were (13 s onset→amber, 10 s
 * amber→red) and that is deliberate: the ramp rate is `12 °C` divided by the
 * first of them, so holding it fixed keeps the climb, the fitted °C/min the
 * rail reports, and every number written about them unchanged. Only the
 * moment the story starts has moved, because the first person to open this
 * cold gave it less time than the old onset alone.
 */
export const DEFAULT_TIMELINE: IncidentTimeline = {
  onsetMs: PREROLL_MS + PREROLL_LEAD_MS,
  amberAtMs: PREROLL_MS + 15_000,
  redAtMs: PREROLL_MS + 25_000,
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
