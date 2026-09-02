import {
  type CommandEventMessage,
  type FleetMessage,
  type OperatorCommand,
} from "@/lib/schema";
import { clamp01, smoothstep01 } from "./rng";
import {
  findUnit,
  nextCommandSeq,
  nowTotalMs,
  type CommandBeat,
  type EngineConfig,
  type EngineState,
  type UnitState,
} from "./state";

/**
 * SAFE SIT execution. The physics start at accept (sitFactor ramps from that
 * instant); the narration beats follow on the engine clock, and the settle
 * beat flips posture.
 */

/** SAFE SIT pacing, ms after the accepted command. Invariant: completeAtMs >= rampMs. */
export interface SitTimeline {
  /** Torque and gait ripple fade to a seated hold over this window; posture flips to "sitting" at its end. */
  rampMs: number;
  /** `complete` beat — the command's total runtime (post-settle verification). */
  completeAtMs: number;
}

/** Real demo pacing: ~2 s visible ramp-down, complete at 4 s. */
export const DEFAULT_SIT_TIMELINE: SitTimeline = {
  rampMs: 2_000,
  completeAtMs: 4_000,
};

/** Progress narration, machine voice, printed verbatim. Beats land at `frac * rampMs`; frac 1 is the instant posture flips. */
export const SIT_PROGRESS_BEATS: ReadonlyArray<{
  frac: number;
  pct: number;
  note: string;
}> = [
  { frac: 0.25, pct: 20, note: "GAIT ARRESTED" },
  { frac: 0.5, pct: 45, note: "CROUCH PHASE" },
  { frac: 0.75, pct: 70, note: "TORQUE RAMP-DOWN" },
  { frac: 1, pct: 90, note: "POSTURE SETTLED" },
];

/** Refusal reasons, machine voice, printed verbatim by the UI. */
export const SIT_REFUSAL_ALREADY_SITTING = "ALREADY SITTING";
export const SIT_REFUSAL_SIT_IN_PROGRESS = "SIT IN PROGRESS";
export const SIT_REFUSAL_SCAN_IN_PROGRESS = "SCAN IN PROGRESS";

/** Post-sit thermal time constant: joint temps decay toward their resting base as exp(-dt/tau). */
export const SIT_TEMP_TAU_MS = 20_000;

/** 0 walking → 1 seated, smoothstepped across the sit ramp. */
export function sitFactor(cfg: EngineConfig, u: UnitState, storylineMs: number): number {
  if (u.sitStartMs === null || storylineMs < u.sitStartMs) return 0;
  return smoothstep01(clamp01((storylineMs - u.sitStartMs) / cfg.sitTimeline.rampMs));
}

/**
 * COMMAND_SAFE_SIT. Every well-targeted command is answered synchronously with
 * exactly one `accepted` or `failed`. A refusal consumes seqs but no state.
 */
export function handleSafeSit(
  cfg: EngineConfig,
  st: EngineState,
  cmd: Extract<OperatorCommand, { c: "COMMAND_SAFE_SIT" }>,
): FleetMessage[] {
  const u = findUnit(st, cmd.unitId);
  if (!u) return []; // valid-shaped but unknown unit: nothing to command

  const now = nowTotalMs(cfg, st);
  const ev = (atTotalMs: number, e: CommandEventMessage["ev"]): CommandEventMessage => ({
    t: "command_event",
    unitId: u.id,
    cmd: "COMMAND_SAFE_SIT",
    seq: nextCommandSeq(st),
    ts: cfg.startTimeMs + atTotalMs,
    ev: e,
  });
  const refuse = (reason: string): FleetMessage[] => [ev(now, { k: "failed", reason })];

  // Most specific first. A recalibration in flight holds this unit's one
  // command slot and runs BECAUSE the unit is seated, so it lands on ALREADY SITTING.
  if (st.commandSessions.get(u.id)?.cmd === "COMMAND_SAFE_SIT")
    return refuse(SIT_REFUSAL_SIT_IN_PROGRESS);
  if (u.posture === "sitting") return refuse(SIT_REFUSAL_ALREADY_SITTING);
  // Sitting mid-scan would invalidate the channels being captured; a scan on another unit does not block.
  if (st.diagSession !== null && st.diagSession.unitId === u.id) {
    return refuse(SIT_REFUSAL_SCAN_IN_PROGRESS);
  }

  // seq order matters — accepted lowest, then beats ascending — because the
  // store treats seq as the ordering authority.
  u.sitStartMs = now - st.storylineStartMs;
  const accepted = ev(now, { k: "accepted" });
  const pending: CommandBeat[] = SIT_PROGRESS_BEATS.map((b) => {
    const at = now + Math.round(cfg.sitTimeline.rampMs * b.frac);
    return {
      atTotalMs: at,
      msg: ev(at, { k: "progress", pct: b.pct, note: b.note }),
      ...(b.frac === 1 ? { consequence: "settle" as const } : {}),
    };
  });
  const completeAt = now + cfg.sitTimeline.completeAtMs;
  pending.push({ atTotalMs: completeAt, msg: ev(completeAt, { k: "complete" }) });
  st.commandSessions.set(u.id, {
    cmd: "COMMAND_SAFE_SIT",
    slot: st.lastSlot,
    pending,
    emitted: [accepted],
  });
  return [accepted];
}
