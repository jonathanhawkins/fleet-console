import { type TelemetryPoint } from "@/lib/schema";
import { BASE_TORQUE, GAIT_AMP, JOINT_PHASE, JOINTS, type Joint } from "./constants";
import { INCIDENT_JOINT, INCIDENT_UNIT_ID, incidentSeverity } from "./incident-knee";
import {
  OFFSET_JOINT,
  OFFSET_TEMP_RISE,
  OFFSET_TORQUE_BIAS,
  OFFSET_UNIT_ID,
} from "./incident-offset";
import { NAV_UNIT_ID, navFactor } from "./nav-recovery";
import { clamp, noise, round1, round2 } from "./rng";
import { SIT_TEMP_TAU_MS, sitFactor } from "./safe-sit";
import { type EngineConfig, type EngineState, type UnitState } from "./state";

/**
 * Per-unit sample generation: a pure function of (seed, unit, joint, slot)
 * plus the storyline state overlaying it (knee incident, ankle offset, sit,
 * navigation halt). Noise keys 0–7 are reserved here; diag noise has its own.
 */

/** Battery drain, percent per ms (~0.35 %/min while pottering around the house). */
const BATTERY_DRAIN_PER_MS = 0.35 / 60_000;

/**
 * The walking-robot signal (gait, activity envelope, incident overlays) —
 * factored out so the seated thermal decay can evaluate "the temperature this
 * joint had at the instant the sit began" as a pure function.
 */
function activeSample(
  cfg: EngineConfig,
  st: EngineState,
  u: UnitState,
  joint: Joint,
  storylineMs: number,
): { torque: number; temp: number } {
  const { seed } = cfg;
  const tSec = storylineMs / 1000;
  const slot = Math.round(storylineMs / cfg.interval);
  const jIdx = JOINTS.indexOf(joint);

  // walking around the house: slow walk/rest envelope in [0.15, 1]
  const activityRaw =
    (Math.sin((storylineMs / u.activityPeriodMs) * Math.PI * 2 + u.activityPhase) + 1) /
    2;
  const activity = 0.15 + 0.85 * activityRaw;

  const gait = Math.sin(
    2 * Math.PI * u.gaitFreqHz * tSec + u.gaitPhase + JOINT_PHASE[joint],
  );

  let torque =
    BASE_TORQUE[joint] * (0.35 + 0.65 * activity) +
    GAIT_AMP[joint] * activity * gait +
    0.4 * noise(seed, u.unitIndex, jIdx, slot, 0);

  let temp = clamp(
    u.baseTemp[joint] +
      1.6 * activity +
      0.8 * Math.sin(tSec / 47 + u.gaitPhase) +
      0.3 * noise(seed, u.unitIndex, jIdx, slot, 1),
    28,
    44,
  );

  // N-01's right ankle: a constant standing-torque bias and a couple of
  // degrees (a drifted encoder is a step, not a ramp). It rides the active
  // signal so the sit blend fades it out: an unloaded joint carries no torque.
  if (u.id === OFFSET_UNIT_ID && joint === OFFSET_JOINT && !st.offsetCleared) {
    torque += OFFSET_TORQUE_BIAS;
    temp = clamp(temp + OFFSET_TEMP_RISE, 28, 44);
  }

  // the scripted incident: N-07 left knee climbs and ripples
  if (u.id === INCIDENT_UNIT_ID && joint === INCIDENT_JOINT) {
    const sev = incidentSeverity(cfg, storylineMs); // 0..2
    if (sev > 0) {
      temp = clamp(temp + 12 * Math.min(sev, 1) + 8 * Math.max(sev - 1, 0), 28, 58);
      const rippleAmp = 1.4 * Math.min(sev, 1) + 2.4 * Math.max(sev - 1, 0);
      torque +=
        rippleAmp * Math.sin(2 * Math.PI * 1.7 * tSec) +
        0.5 * sev * noise(seed, u.unitIndex, jIdx, slot, 2);
    }
  }

  return { torque, temp };
}

export function samplePoint(
  cfg: EngineConfig,
  st: EngineState,
  u: UnitState,
  joint: Joint,
  storylineMs: number,
): TelemetryPoint {
  const { seed } = cfg;
  const slot = Math.round(storylineMs / cfg.interval);
  const jIdx = JOINTS.indexOf(joint);
  const active = activeSample(cfg, st, u, joint, storylineMs);
  const sit = sitFactor(cfg, u, storylineMs);

  let torque = active.torque;
  let temp = active.temp;

  // SAFE SIT physics: torque collapses to a small hold residual across the
  // ramp; temperature stops being generated at sit start and decays toward
  // the joint's resting base. Current derives from torque below.
  if (sit > 0 && u.sitStartMs !== null) {
    const residual = 0.12 + 0.05 * noise(seed, u.unitIndex, jIdx, slot, 4);
    torque = active.torque * (1 - sit) + residual * sit;

    const tempAtSit = activeSample(cfg, st, u, joint, u.sitStartMs).temp;
    const decayed =
      u.baseTemp[joint] +
      (tempAtSit - u.baseTemp[joint]) *
        Math.exp(-(storylineMs - u.sitStartMs) / SIT_TEMP_TAU_MS) +
      0.15 * noise(seed, u.unitIndex, jIdx, slot, 5);
    temp = active.temp * (1 - sit) + decayed * sit;
  }

  // Blocked-navigation halt: the same blocks as a sit, except the hold is a
  // STANDING hold (real static torque, posture untouched) and the window
  // closes. A commanded sit outranks it, so the branches are exclusive.
  if (u.id === NAV_UNIT_ID && u.sitStartMs === null) {
    const nav = navFactor(cfg, storylineMs);
    if (nav > 0) {
      const hold =
        0.5 * BASE_TORQUE[joint] + 0.15 * noise(seed, u.unitIndex, jIdx, slot, 6);
      torque = torque * (1 - nav) + hold * nav;

      const blockAtMs = cfg.navTimeline.blockAtMs;
      const tempAtBlock = activeSample(cfg, st, u, joint, blockAtMs).temp;
      const settled =
        u.baseTemp[joint] +
        (tempAtBlock - u.baseTemp[joint]) *
          Math.exp(-(storylineMs - blockAtMs) / SIT_TEMP_TAU_MS) +
        0.15 * noise(seed, u.unitIndex, jIdx, slot, 7);
      temp = temp * (1 - nav) + settled * nav;
    }
  }

  const current =
    0.4 + 0.11 * Math.abs(torque) + 0.08 * noise(seed, u.unitIndex, jIdx, slot, 3);

  return {
    joint,
    tempC: round1(temp),
    torqueNm: round2(torque),
    currentA: round2(Math.max(0.05, current)),
    battery: round1(u.battery),
  };
}

export function updateBattery(u: UnitState, storylineMs: number): void {
  u.battery = clamp(u.batteryStart - BATTERY_DRAIN_PER_MS * storylineMs, 3, 100);
}
