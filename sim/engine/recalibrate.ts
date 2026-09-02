import {
  type CommandEventMessage,
  type DiagEventMessage,
  type FleetMessage,
  type OperatorCommand,
} from "@/lib/schema";
import { buildChannel } from "./diagnostics";
import { CALIBRATION_OUTCOME } from "./faults";
import {
  findUnit,
  nextCommandSeq,
  nowTotalMs,
  type CommandBeat,
  type EngineConfig,
  type EngineState,
} from "./state";

/**
 * RECALIBRATE JOINT execution — the cheapest rung on the recovery ladder: the
 * joint is driven through its unloaded range, a new gain table is written,
 * and the joint is measured again. The re-measured channel is the command's
 * evidence; its outcome comes from faults.ts CALIBRATION_OUTCOME.
 */

/** Recalibration pacing, ms after the accepted command. Invariant: completeAtMs >= sweepMs; the gap is the re-measure. */
export interface RecalTimeline {
  /** The sweep: the joint is driven through its unloaded range and a new gain table is written. */
  sweepMs: number;
  /** `complete` beat — sweep plus the verification pass that produces the new channel. */
  completeAtMs: number;
}

/** Real demo pacing: ~2.5 s of sweep, re-measured and complete at 4.5 s. */
export const DEFAULT_RECAL_TIMELINE: RecalTimeline = {
  sweepMs: 2_500,
  completeAtMs: 4_500,
};

/** Progress narration, machine voice, printed verbatim. Beats land at `frac * sweepMs`. */
export const RECAL_PROGRESS_BEATS: ReadonlyArray<{
  frac: number;
  pct: number;
  note: string;
}> = [
  { frac: 0.2, pct: 15, note: "JOINT UNLOADED" },
  { frac: 0.45, pct: 40, note: "RANGE SWEEP 1/2" },
  { frac: 0.7, pct: 65, note: "RANGE SWEEP 2/2" },
  { frac: 1, pct: 85, note: "GAIN TABLE WRITTEN" },
];

/**
 * Refusal reasons, machine voice, printed verbatim by the UI. REQUIRES SEATED
 * POSTURE is enforced here, not only in the UI: driving a joint through its
 * range while the robot stands on it is the failure the SAFE SIT prevents.
 */
export const RECAL_REFUSAL_IN_PROGRESS = "RECALIBRATION IN PROGRESS";
export const RECAL_REFUSAL_SIT_IN_PROGRESS = "SIT IN PROGRESS";
export const RECAL_REFUSAL_NOT_SEATED = "REQUIRES SEATED POSTURE";
export const RECAL_REFUSAL_SCAN_IN_PROGRESS = "SCAN IN PROGRESS";
export const RECAL_REFUSAL_CURRENT = "CALIBRATION CURRENT";
export const RECAL_REFUSAL_NO_TARGET = "NO CALIBRATION TARGET";

/**
 * The re-measured channel a completed RECALIBRATE JOINT produces, measured at
 * the slot the command was ACCEPTED at, so hosts advancing at different rates
 * hand the console the same evidence for the same maneuver.
 */
export function buildRecalibration(
  cfg: EngineConfig,
  st: EngineState,
  unitId: string,
  slot: number,
): DiagEventMessage | null {
  const u = findUnit(st, unitId);
  const finding = st.flaggedJoints.get(unitId);
  if (!u || !finding) return null;
  const { outcome, residual } = CALIBRATION_OUTCOME[finding.anomaly];
  return {
    t: "diag_event",
    unitId,
    ev: {
      k: "recalibration",
      joint: finding.joint,
      ...buildChannel(cfg, u, finding.joint, slot, residual),
      outcome,
    },
  };
}

/**
 * RECALIBRATE_JOINT. Exactly one `accepted` or `failed`, always synchronous.
 * Refusals go most specific first: what is happening now, then what this unit
 * is, then whether there is anything to do.
 */
export function handleRecalibrate(
  cfg: EngineConfig,
  st: EngineState,
  cmd: Extract<OperatorCommand, { c: "RECALIBRATE_JOINT" }>,
): FleetMessage[] {
  const u = findUnit(st, cmd.unitId);
  if (!u) return [];

  const now = nowTotalMs(cfg, st);
  const ev = (atTotalMs: number, e: CommandEventMessage["ev"]): CommandEventMessage => ({
    t: "command_event",
    unitId: u.id,
    cmd: "RECALIBRATE_JOINT",
    seq: nextCommandSeq(st),
    ts: cfg.startTimeMs + atTotalMs,
    ev: e,
  });
  const refuse = (reason: string): FleetMessage[] => [ev(now, { k: "failed", reason })];

  const running = st.commandSessions.get(u.id);
  if (running?.cmd === "RECALIBRATE_JOINT") return refuse(RECAL_REFUSAL_IN_PROGRESS);
  if (running) return refuse(RECAL_REFUSAL_SIT_IN_PROGRESS);
  if (u.posture !== "sitting") return refuse(RECAL_REFUSAL_NOT_SEATED);
  // Moving the joint being measured invalidates the channels the scan is capturing.
  if (st.diagSession !== null && st.diagSession.unitId === u.id) {
    return refuse(RECAL_REFUSAL_SCAN_IN_PROGRESS);
  }
  if (st.calibrated.has(u.id)) return refuse(RECAL_REFUSAL_CURRENT);
  if (!st.flaggedJoints.has(u.id)) return refuse(RECAL_REFUSAL_NO_TARGET);

  // Recorded at accept, not at complete: a second command mid-sweep is refused
  // for the sweep, and one arriving after it is refused for the table.
  st.calibrated.add(u.id);
  const accepted = ev(now, { k: "accepted" });
  const pending: CommandBeat[] = RECAL_PROGRESS_BEATS.map((b) => {
    const at = now + Math.round(cfg.recalTimeline.sweepMs * b.frac);
    return { atTotalMs: at, msg: ev(at, { k: "progress", pct: b.pct, note: b.note }) };
  });
  const completeAt = now + cfg.recalTimeline.completeAtMs;
  pending.push({
    atTotalMs: completeAt,
    msg: ev(completeAt, { k: "complete" }),
    consequence: "remeasure",
  });
  st.commandSessions.set(u.id, {
    cmd: "RECALIBRATE_JOINT",
    slot: st.lastSlot,
    pending,
    emitted: [accepted],
  });
  return [accepted];
}
