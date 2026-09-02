import {
  type DiagEventMessage,
  type FleetMessage,
  type OperatorCommand,
  type VerdictReport,
} from "@/lib/schema";
import { JOINT_PHASE, JOINTS, type Joint } from "./constants";
import { activeFault, type ChannelFault, type ScriptedFault } from "./faults";
import { clamp, noise, round4 } from "./rng";
import {
  findUnit,
  nowTotalMs,
  type DiagBeat,
  type EngineConfig,
  type EngineState,
  type UnitState,
} from "./state";

/**
 * Diagnostic scan choreography (PRD §4 diag_event sequence): scan_start, a
 * program walk, one measured channel per joint, a flag on the faulty joint,
 * and a verdict. One scan at a time — the scanner is a shared resource.
 */

/**
 * Beat offsets for one diagnostic scan, ms after the RUN_DIAGNOSTIC command.
 * Invariants the defaults honor (overrides should too): walks finish before
 * the first channel; the flag lands between the incident joint's channel and
 * the verdict; the verdict comes last.
 */
export interface DiagTimeline {
  /** First `walk` line. */
  walkStartMs: number;
  /** Cadence between `walk` lines. */
  walkStepMs: number;
  /** First `channel` event (joints stream in JOINTS order). */
  channelStartMs: number;
  /** Cadence between `channel` events. */
  channelStepMs: number;
  /** `flag` delay after the incident joint's channel (failure path only). */
  flagDelayMs: number;
  /** `verdict` beat — the scan's total runtime. */
  verdictAtMs: number;
}

/**
 * Default pacing, ~15 s command → verdict: scan_start at 0 (synchronous with
 * the command), 20 walks 1.0 → 5.75 s, channels 6.5 → 13.0 s (knee_L 9.1 s,
 * its flag 9.7 s on the failure path), verdict 15.0 s.
 */
export const DEFAULT_DIAG_TIMELINE: DiagTimeline = {
  walkStartMs: 1_000,
  walkStepMs: 250,
  channelStartMs: 6_500,
  channelStepMs: 1_300,
  flagDelayMs: 600,
  verdictAtMs: 15_000,
};

/** Uniformly compress (or stretch) a diag timeline; scale 0.1 = 10x faster. */
export function scaleDiagTimeline(t: DiagTimeline, scale: number): DiagTimeline {
  return {
    walkStartMs: Math.round(t.walkStartMs * scale),
    walkStepMs: Math.round(t.walkStepMs * scale),
    channelStartMs: Math.round(t.channelStartMs * scale),
    channelStepMs: Math.round(t.channelStepMs * scale),
    flagDelayMs: Math.round(t.flagDelayMs * scale),
    verdictAtMs: Math.round(t.verdictAtMs * scale),
  };
}

/** The program walk the ScanLog renders: one pass through the robot's tree, identical for every scan. */
export const DIAG_WALK_PATHS: readonly string[] = [
  "/sys/core/heartbeat.svc",
  "/sys/core/power_rail/v48_main",
  "/sys/core/thermal/zone_map.cfg",
  "/sys/actuator_bus/enumerate",
  "/sys/actuator_bus/hip_L/actuator_A03",
  "/sys/actuator_bus/hip_R/actuator_A04",
  "/sys/actuator_bus/knee_L/actuator_A07",
  "/sys/actuator_bus/knee_R/actuator_A08",
  "/sys/actuator_bus/ankle_L/actuator_A11",
  "/sys/actuator_bus/ankle_R/actuator_A12",
  "/firmware/gait/park_pose.ko",
  "/firmware/gait/walk_cycle.ko",
  "/firmware/gait/balance_reflex.ko",
  "/calib/hip_L/gain_table.bin",
  "/calib/hip_R/gain_table.bin",
  "/calib/knee_L/gain_table.bin",
  "/calib/knee_R/gain_table.bin",
  "/calib/ankle_L/gain_table.bin",
  "/calib/ankle_R/gain_table.bin",
  "/proprio/imu/fusion_state",
];

/** Samples per channel trace (~120, normalized -1..1 — the WaveformStrip contract). */
export const CHANNEL_SAMPLES = 120;

/** Noise key-space tag so diag samples never collide with telemetry noise. */
const DIAG_NOISE_TAG = 101;

/**
 * The reference trace for a joint: three gait cycles of a two-harmonic
 * waveform, phase-shifted per joint. Amplitude 0.55 leaves headroom so the
 * failing trace at 1.8x gain still fits -1..1. Seed-independent: it plays the
 * factory calibration table.
 */
function refSample(joint: Joint, i: number): number {
  const theta = (2 * Math.PI * 3 * i) / CHANNEL_SAMPLES + JOINT_PHASE[joint];
  return 0.55 * (0.78 * Math.sin(theta) + 0.22 * Math.sin(2 * theta + 0.9));
}

/**
 * One measured channel. Healthy (`fault` null): wave = ref x (1 ± 4 % gain
 * jitter) + 2 % noise. A gain fault multiplies the reference (phase kept,
 * envelope lost); an offset fault adds to it (envelope kept, datum lost).
 * Noise is keyed on (unit, joint, sample, scan slot), so a scan is
 * byte-deterministic and RESET_SIM + the same command timing replays it.
 */
export function buildChannel(
  cfg: EngineConfig,
  u: UnitState,
  joint: Joint,
  scanSlot: number,
  fault: ChannelFault | null,
): { wave: number[]; ref: number[] } {
  const jIdx = JOINTS.indexOf(joint);
  const wave: number[] = [];
  const ref: number[] = [];
  for (let i = 0; i < CHANNEL_SAMPLES; i += 1) {
    const r = refSample(joint, i);
    const jitter = noise(cfg.seed, DIAG_NOISE_TAG + u.unitIndex, jIdx, 2 * i, scanSlot);
    const hiss = noise(cfg.seed, DIAG_NOISE_TAG + u.unitIndex, jIdx, 2 * i + 1, scanSlot);
    const gain =
      fault?.kind === "gain"
        ? fault.start + (fault.end - fault.start) * (i / (CHANNEL_SAMPLES - 1))
        : 1 + 0.04 * jitter;
    const bias = fault?.kind === "offset" ? fault.bias : 0;
    wave.push(round4(clamp(r * gain + bias + 0.02 * hiss, -1, 1)));
    ref.push(round4(r));
  }
  return { wave, ref };
}

/** Every beat after scan_start, in beat order, stable-sorted by due time. */
function buildDiagSchedule(
  cfg: EngineConfig,
  u: UnitState,
  scanStartTotalMs: number,
  fault: ScriptedFault | null,
): DiagBeat[] {
  const t = cfg.diagTimeline;
  const scanSlot = Math.round(scanStartTotalMs / cfg.interval);
  const at = (offsetMs: number) => scanStartTotalMs + offsetMs;
  const ev = (atTotalMs: number, e: DiagEventMessage["ev"]): DiagBeat => ({
    atTotalMs,
    msg: { t: "diag_event", unitId: u.id, ev: e },
  });

  const beats: DiagBeat[] = [];

  DIAG_WALK_PATHS.forEach((path, i) => {
    beats.push(ev(at(t.walkStartMs + i * t.walkStepMs), { k: "walk", path }));
  });

  JOINTS.forEach((joint, i) => {
    const channelAt = at(t.channelStartMs + i * t.channelStepMs);
    const failing = fault !== null && joint === fault.joint;
    beats.push(
      ev(channelAt, {
        k: "channel",
        joint,
        ...buildChannel(cfg, u, joint, scanSlot, failing ? fault.channel : null),
      }),
    );
    if (failing) {
      beats.push(
        ev(channelAt + t.flagDelayMs, {
          k: "flag",
          joint: fault.joint,
          component: fault.component,
          anomaly: fault.anomaly,
        }),
      );
    }
  });

  const verdictAt = at(t.verdictAtMs);
  const report: VerdictReport = fault
    ? {
        unitId: u.id,
        joint: fault.joint,
        component: fault.component,
        anomaly: fault.anomaly,
        summary: fault.summary,
        recommendations: [...fault.recommendations],
        ts: cfg.startTimeMs + verdictAt,
      }
    : {
        unitId: u.id,
        joint: "all",
        component: "all",
        anomaly: "none",
        summary: "SCAN COMPLETE. 6 CHANNELS WITHIN TOLERANCE. NO ANOMALY DETECTED.",
        recommendations: ["No action required"],
        ts: cfg.startTimeMs + verdictAt,
      };
  beats.push(ev(verdictAt, { k: "verdict", report }));

  // Stable sort: equal due times keep beat order (e.g. flagDelayMs: 0).
  return beats.sort((a, b) => a.atTotalMs - b.atTotalMs);
}

/**
 * Emit every diag beat due by totalMs; the verdict ends the session. The
 * calibration target is recorded when the flag EMITS, not when the schedule
 * was built, and a fresh diagnosis retires the previous calibration.
 */
export function drainDiag(st: EngineState, totalMs: number): FleetMessage[] {
  const out: FleetMessage[] = [];
  for (;;) {
    const session = st.diagSession;
    if (session === null || session.pending.length === 0) break;
    if (session.pending[0]!.atTotalMs > totalMs) break;
    const beat = session.pending.shift()!;
    session.emitted.push(beat.msg);
    out.push(beat.msg);
    if (beat.msg.ev.k === "flag") {
      const { joint, anomaly } = beat.msg.ev;
      // The wire types `joint` as an identifier; the target must be one of this robot's joints.
      const known = JOINTS.find((j) => j === joint);
      if (known) st.flaggedJoints.set(session.unitId, { joint: known, anomaly });
      st.calibrated.delete(session.unitId);
    }
    if (beat.msg.ev.k === "verdict") st.diagSession = null;
  }
  return out;
}

/**
 * RUN_DIAGNOSTIC. One scan at a time: a repeat command mid-scan (same unit or
 * not) is ignored. The scan finds whichever scripted fault is live on this
 * unit right now; every other unit gets a clean scan.
 */
export function handleRunDiagnostic(
  cfg: EngineConfig,
  st: EngineState,
  cmd: Extract<OperatorCommand, { c: "RUN_DIAGNOSTIC" }>,
): FleetMessage[] {
  if (st.diagSession !== null) return [];
  const u = findUnit(st, cmd.unitId);
  if (!u) return []; // valid-shaped but unknown unit: nothing to scan

  // "Now" is the engine's clock, not the wall: the last advanced slot.
  const now = nowTotalMs(cfg, st);
  const fault = activeFault(cfg, st, u, now - st.storylineStartMs);

  const scanStart: DiagEventMessage = {
    t: "diag_event",
    unitId: u.id,
    ev: { k: "scan_start" },
  };
  st.diagSession = {
    unitId: u.id,
    pending: buildDiagSchedule(cfg, u, now, fault),
    emitted: [scanStart],
  };
  return [scanStart]; // scan_start goes out with the command's broadcast
}
