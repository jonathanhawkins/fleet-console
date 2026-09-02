import { type FleetMessage } from "@/lib/schema";
import { clamp01, smoothstep01 } from "./rng";
import {
  dropAlert,
  raiseAlert,
  requireUnit,
  summarize,
  type EngineConfig,
  type EngineState,
} from "./state";

/**
 * N-03 blocked-navigation self-recovery: N-03 halts on a blocked route, raises
 * an amber, replans, and clears its own alert with zero operator action. The
 * raise is an ordinary `alert`; the clear is `alert_clear` (via
 * "self-recovery") then a `unit_update` restating the unit nominal, because
 * status is snapshot-carried state.
 */
export const NAV_UNIT_ID = "N-03";

/** Storyline beats, ms of storyline time (zeroed by RESET_SIM). */
export interface NavTimeline {
  /** N-03 halts and raises the amber ("navigation blocked"). */
  blockAtMs: number;
  /** The route replans; the alert clears itself. Invariant: > blockAtMs. */
  clearAtMs: number;
}

/** Real demo pacing: blocked ~2 min in, self-resolved 40 s later. */
export const DEFAULT_NAV_TIMELINE: NavTimeline = {
  blockAtMs: 120_000,
  clearAtMs: 160_000,
};

/** Halt/resume ramp: gait ripple fades out over this window at the block beat and back in at the clear. */
export const NAV_RAMP_MS = 2_000;

/** Operator-voice alert copy; the unit's name is prefixed like every alert. */
export const NAV_BLOCK_MESSAGE = "navigation blocked — replanning around obstruction";

/** 0 en route → 1 halted → 0 resumed, smoothstepped at both edges. Never touches posture. */
export function navFactor(cfg: EngineConfig, storylineMs: number): number {
  const { blockAtMs, clearAtMs } = cfg.navTimeline;
  if (storylineMs < blockAtMs) return 0;
  const rise = smoothstep01(clamp01((storylineMs - blockAtMs) / NAV_RAMP_MS));
  const fall = smoothstep01(clamp01((storylineMs - clearAtMs) / NAV_RAMP_MS));
  return rise * (1 - fall);
}

/** N-03 beats in (prevMs, curMs]. The clear guards on `navAlertId`: a degenerate timeline never clears what never raised. */
export function navCrossings(
  cfg: EngineConfig,
  st: EngineState,
  prevMs: number,
  curMs: number,
): FleetMessage[] {
  const out: FleetMessage[] = [];
  const { blockAtMs, clearAtMs } = cfg.navTimeline;
  if (prevMs < blockAtMs && curMs >= blockAtMs) {
    const u = requireUnit(st, NAV_UNIT_ID);
    u.status = "amber";
    const msg = raiseAlert(
      cfg,
      st,
      u,
      "amber",
      `${u.name}: ${NAV_BLOCK_MESSAGE}`,
      blockAtMs,
    );
    st.navAlertId = msg.alert.id;
    out.push(msg);
  }
  if (st.navAlertId !== null && prevMs < clearAtMs && curMs >= clearAtMs) {
    const u = requireUnit(st, NAV_UNIT_ID);
    u.status = "nominal";
    out.push({
      t: "alert_clear",
      alertId: st.navAlertId,
      unitId: u.id,
      via: "self-recovery",
      ts: cfg.startTimeMs + st.storylineStartMs + clearAtMs,
    });
    out.push({ t: "unit_update", unit: summarize(u) });
    dropAlert(st, st.navAlertId);
    st.navAlertId = null;
  }
  return out;
}
