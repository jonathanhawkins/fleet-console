import { type FleetMessage } from "@/lib/schema";
import { type Joint } from "./constants";
import {
  dropAlert,
  findUnit,
  raiseAlert,
  requireUnit,
  summarize,
  type EngineConfig,
  type EngineState,
} from "./state";

/**
 * N-01 encoder-offset incident — the second ending. An encoder whose zero has
 * drifted: the joint reports a biased position, the gait controller
 * compensates, the robot walks slightly crooked. Re-zeroing an encoder is
 * exactly what a calibration is, so the recovery ladder stops at rung two
 * (remote operations) — unlike N-07's knee, where a calibration is PARTIAL.
 * N-01 is the only core-eight unit no other storyline touches.
 */
export const OFFSET_UNIT_ID = "N-01";
export const OFFSET_JOINT = "ankle_R" satisfies Joint;
export const OFFSET_COMPONENT = "actuator_A12";

/**
 * The encoder's zero error in the channel's normalized units: a DC displacement
 * of the whole trace, NOT a scaling. The RMS deviation IS the displacement, so
 * 0.21 lands clear of RMS_FAILING (components/machine/waveform-math.ts).
 */
export const OFFSET_BIAS = 0.21;

/** A standing torque against a joint the controller mislocates, and the warmth it costs: visible on the strips, never enough to move a status chip. */
export const OFFSET_TORQUE_BIAS = 1.2;
export const OFFSET_TEMP_RISE = 2.4;

/** Storyline beats, ms of storyline time (zeroed by RESET_SIM). */
export interface OffsetTimeline {
  /** The unit's own monitor trips and raises the amber. */
  alertAtMs: number;
}

/**
 * Real demo pacing: the amber lands at 5:30, after every other storyline has
 * finished — the knee window (amber 28 s, red 38 s), N-03's replan
 * (120–160 s), and the rollout act (raises 180–210 s, queued install 270 s).
 * The fault itself is NOT on this clock: the zero drifted before the run
 * began, so a scan finds it whenever one is asked for; only the detector
 * waits, because gait asymmetry is a slow estimate over many strides.
 */
export const DEFAULT_OFFSET_TIMELINE: OffsetTimeline = {
  alertAtMs: 330_000,
};

/** Operator-voice alert copy, unit-name prefixed. Amber with no escalation beat: nothing here is getting worse. */
export const OFFSET_ALERT_MESSAGE =
  "right ankle position feedback offset — gait asymmetry above threshold";

/** N-01 beat in (prevMs, curMs]: one raise and no self-clear — a RECALIBRATE_JOINT resolves it. Moot once cleared or already standing. */
export function offsetCrossings(
  cfg: EngineConfig,
  st: EngineState,
  prevMs: number,
  curMs: number,
): FleetMessage[] {
  if (st.offsetCleared || st.offsetAlertId !== null) return [];
  const { alertAtMs } = cfg.offsetTimeline;
  if (!(prevMs < alertAtMs && curMs >= alertAtMs)) return [];
  const u = requireUnit(st, OFFSET_UNIT_ID);
  u.status = "amber";
  const msg = raiseAlert(
    cfg,
    st,
    u,
    "amber",
    `${u.name}: ${OFFSET_ALERT_MESSAGE}`,
    alertAtMs,
  );
  st.offsetAlertId = msg.alert.id;
  return [msg];
}

/**
 * A CLEARED calibration beyond the channel it re-measured: the fault latches
 * off, the amber resolves (`alert_clear` via "recalibration"), the unit
 * restates itself nominal (`unit_update`) — in that order, together or not at all.
 */
export function resolveByCalibration(
  cfg: EngineConfig,
  st: EngineState,
  unitId: string,
  atTotalMs: number,
): FleetMessage[] {
  if (unitId !== OFFSET_UNIT_ID) return [];
  const u = findUnit(st, unitId);
  if (!u) return [];

  st.offsetCleared = true;
  const out: FleetMessage[] = [];
  if (st.offsetAlertId !== null) {
    out.push({
      t: "alert_clear",
      alertId: st.offsetAlertId,
      unitId: u.id,
      via: "recalibration",
      ts: cfg.startTimeMs + atTotalMs,
    });
    dropAlert(st, st.offsetAlertId);
    st.offsetAlertId = null;
  }
  // Reachable before the detector trips: an already-nominal unit has nothing to restate.
  if (u.status !== "nominal") {
    u.status = "nominal";
    out.push({ t: "unit_update", unit: summarize(u) });
  }
  return out;
}
