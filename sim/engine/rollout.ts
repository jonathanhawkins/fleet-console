import {
  type AlertMessage,
  type CommandEventMessage,
  type FleetCommandEventMessage,
  type FleetMessage,
  type OperatorCommand,
} from "@/lib/schema";
import {
  dropAlert,
  findUnit,
  nextCommandSeq,
  nowTotalMs,
  raiseAlert,
  summarize,
  type EngineConfig,
  type EngineState,
  type RollbackBeat,
  type UnitState,
} from "./state";

/**
 * Firmware rollout cohort — the fleet-wide storyline. A rollout (2.3.7 →
 * 2.4.1) has reached half the fleet when every upgraded unit starts saying
 * the same words — the cohort signature — while one more unit sits queued.
 * HALT_ROLLOUT saves the queued unit before its install lands;
 * ROLLBACK_COHORT restores the affected units one at a time. N-07 and N-03
 * stay on the baseline: their faults must NOT count in the canary comparison.
 */

/** The known-good baseline every unit shipped on. */
export const FW_STABLE = "2.3.7";
/** The rollout build — the one the cohort incriminates. */
export const FW_ROLLOUT = "2.4.1";

/** The rollout wave: four units already running FW_ROLLOUT. */
export const ROLLOUT_UNIT_IDS: readonly string[] = ["N-02", "N-04", "N-06", "N-08"];

/** The queued fifth install: on FW_STABLE with `fwPending` FW_ROLLOUT until `pendingAtMs` — unless HALT_ROLLOUT lands first. */
export const PENDING_UNIT_ID = "N-05";

/** The cohort signature — NOT unit-name prefixed: the signal IS four units saying byte-identical words (lib/stores/cohortStore.ts groups on it). */
export const COHORT_ALERT_MESSAGE = "Balance reflex latency above threshold";

/** Storyline beats + rollback pacing, ms of storyline time (zeroed by RESET_SIM). */
export interface CohortTimeline {
  /** First rollout unit raises the signature amber. */
  onsetMs: number;
  /** Cadence between the rollout units' raises (4 units span 3 staggers). */
  staggerMs: number;
  /** The queued install lands unless halted first; it then raises the signature one stagger later (halting late does not un-install). */
  pendingAtMs: number;
  /** ROLLBACK_COHORT pacing: one unit restored per this window, strictly serial. */
  rollbackPerUnitMs: number;
}

/**
 * Real demo pacing: the cohort forms AFTER the N-07 window (amber 28 s, red
 * 38 s) and the N-03 replan (120–160 s). Raises at 180/190/200/210 s; the
 * queued install at onset + 90 s; rollback ~4 s per unit.
 */
export const DEFAULT_COHORT_TIMELINE: CohortTimeline = {
  onsetMs: 180_000,
  staggerMs: 10_000,
  pendingAtMs: 270_000,
  rollbackPerUnitMs: 4_000,
};

/** Refusal reasons, machine voice, printed verbatim by the UI. */
export const ROLLOUT_REFUSAL_NO_ROLLOUT_ACTIVE = "NO ROLLOUT ACTIVE";
export const ROLLOUT_REFUSAL_ROLLBACK_IN_PROGRESS = "ROLLBACK IN PROGRESS";

/** Raise one unit's cohort-signature amber (identical message across units — that IS the signature). */
function raiseCohortAlert(
  cfg: EngineConfig,
  st: EngineState,
  u: UnitState,
  atStorylineMs: number,
): AlertMessage {
  u.status = "amber";
  const msg = raiseAlert(cfg, st, u, "amber", COHORT_ALERT_MESSAGE, atStorylineMs);
  st.cohortAlertIds.set(u.id, msg.alert.id);
  return msg;
}

/**
 * Firmware-cohort beats in (prevMs, curMs]. Raises are guarded on still
 * RUNNING the rollout build, so a rollback that outraces a raise leaves a
 * restored unit silent.
 */
export function cohortCrossings(
  cfg: EngineConfig,
  st: EngineState,
  prevMs: number,
  curMs: number,
): FleetMessage[] {
  const out: FleetMessage[] = [];
  const { onsetMs, staggerMs, pendingAtMs } = cfg.cohortTimeline;
  ROLLOUT_UNIT_IDS.forEach((id, i) => {
    const at = onsetMs + i * staggerMs;
    if (prevMs < at && curMs >= at) {
      const u = findUnit(st, id);
      if (u && u.fw === FW_ROLLOUT && !st.cohortAlertIds.has(id)) {
        out.push(raiseCohortAlert(cfg, st, u, at));
      }
    }
  });

  if (prevMs < pendingAtMs && curMs >= pendingAtMs) {
    const u = findUnit(st, PENDING_UNIT_ID);
    if (u && !st.rolloutHalted && u.fwPending !== null) {
      u.fw = u.fwPending;
      u.fwPending = null;
      out.push({ t: "unit_update", unit: summarize(u) });
    }
  }

  const lateAt = pendingAtMs + staggerMs;
  if (prevMs < lateAt && curMs >= lateAt) {
    const u = findUnit(st, PENDING_UNIT_ID);
    if (u && u.fw === FW_ROLLOUT && !st.cohortAlertIds.has(u.id)) {
      out.push(raiseCohortAlert(cfg, st, u, lateAt));
    }
  }

  return out;
}

/**
 * Emit every rollback beat due by totalMs; `complete` retires the session. A
 * "unitDone" beat is where the restoration happens, in a fixed order:
 * `unit_update` (fw is snapshot-carried state), then the unit's cohort alert
 * cleared via `alert_clear` (via "rollback") if it ever raised.
 */
export function drainRollback(
  cfg: EngineConfig,
  st: EngineState,
  totalMs: number,
): FleetMessage[] {
  const out: FleetMessage[] = [];
  for (;;) {
    const session = st.rollbackSession;
    if (session === null || session.pending.length === 0) break;
    if (session.pending[0]!.atTotalMs > totalMs) break;
    const beat = session.pending.shift()!;
    switch (beat.kind) {
      case "note":
        session.emitted.push(beat.msg);
        out.push(beat.msg);
        break;
      case "unitDone": {
        const u = findUnit(st, beat.unitId);
        if (!u) break;
        u.fw = session.toFw;
        u.status = "nominal";
        out.push({ t: "unit_update", unit: summarize(u) });
        const alertId = st.cohortAlertIds.get(u.id);
        if (alertId !== undefined) {
          out.push({
            t: "alert_clear",
            alertId,
            unitId: u.id,
            via: "rollback",
            ts: cfg.startTimeMs + beat.atTotalMs,
          });
          dropAlert(st, alertId);
          st.cohortAlertIds.delete(u.id);
        }
        break;
      }
      case "complete":
        out.push(beat.msg);
        st.rollbackSession = null; // staged restoration over: nothing left to replay
        break;
    }
  }
  return out;
}

/**
 * HALT_ROLLOUT: fleet-scoped and fully synchronous — cancel what has not
 * installed yet. The whole lifecycle rides the command's broadcast, so a halt
 * is never replayed to late joiners; its durable receipt is the snapshot.
 */
export function handleHaltRollout(cfg: EngineConfig, st: EngineState): FleetMessage[] {
  const now = nowTotalMs(cfg, st);
  const fleetEv = (e: CommandEventMessage["ev"]): FleetCommandEventMessage => ({
    t: "fleet_command_event",
    cmd: "HALT_ROLLOUT",
    fw: FW_ROLLOUT,
    seq: nextCommandSeq(st),
    ts: cfg.startTimeMs + now,
    ev: e,
  });

  // Already halted (a rollback implies the halt) or every queued install landed.
  if (st.rolloutHalted || !st.units.some((x) => x.fwPending !== null)) {
    return [fleetEv({ k: "failed", reason: ROLLOUT_REFUSAL_NO_ROLLOUT_ACTIVE })];
  }

  st.rolloutHalted = true;
  const out: FleetMessage[] = [fleetEv({ k: "accepted" })];
  for (const u of st.units) {
    if (u.fwPending === null) continue;
    u.fwPending = null;
    out.push(
      fleetEv({
        k: "progress",
        pct: 100,
        note: `ROLLOUT HALTED — ${u.id} REMAINS ON ${u.fw}`,
      }),
    );
    out.push({ t: "unit_update", unit: summarize(u) });
  }
  out.push(fleetEv({ k: "complete" }));
  return out;
}

/**
 * ROLLBACK_COHORT: fleet-scoped, staged, strictly serial. The units running
 * cmd.fw return to the baseline one at a time, rollbackPerUnitMs each, in
 * roster order; complete lands when the last unit's window closes.
 */
export function handleRollbackCohort(
  cfg: EngineConfig,
  st: EngineState,
  cmd: Extract<OperatorCommand, { c: "ROLLBACK_COHORT" }>,
): FleetMessage[] {
  const now = nowTotalMs(cfg, st);
  const fleetEv = (
    atTotalMs: number,
    e: CommandEventMessage["ev"],
  ): FleetCommandEventMessage => ({
    t: "fleet_command_event",
    cmd: "ROLLBACK_COHORT",
    fw: cmd.fw,
    seq: nextCommandSeq(st),
    ts: cfg.startTimeMs + atTotalMs,
    ev: e,
  });

  // One staged rollback at a time: the rollout program is one resource.
  if (st.rollbackSession !== null) {
    return [fleetEv(now, { k: "failed", reason: ROLLOUT_REFUSAL_ROLLBACK_IN_PROGRESS })];
  }
  // No unit runs cmd.fw, or cmd.fw IS the baseline: nothing to command — ignored, not refused.
  const targets = st.units.filter((x) => x.fw === cmd.fw);
  if (cmd.fw === FW_STABLE || targets.length === 0) return [];

  const out: FleetMessage[] = [fleetEv(now, { k: "accepted" })];

  // Rolling a build back implies halting its rollout: a queued install of cmd.fw is canceled here.
  st.rolloutHalted = true;
  for (const u of st.units) {
    if (u.fwPending === cmd.fw) {
      u.fwPending = null;
      out.push({ t: "unit_update", unit: summarize(u) });
    }
  }

  // Beats are built up front in emission order so seqs ascend exactly as the
  // events emit; the consequences ("unitDone") are applied at drain time.
  const per = cfg.cohortTimeline.rollbackPerUnitMs;
  const pending: RollbackBeat[] = [];
  targets.forEach((u, i) => {
    const startAt = now + i * per;
    pending.push({
      atTotalMs: startAt,
      kind: "note",
      msg: fleetEv(startAt, {
        k: "progress",
        pct: Math.round((100 * i) / targets.length),
        note: `ROLLING BACK ${u.id} ${cmd.fw}->${FW_STABLE}`,
      }),
    });
    pending.push({ atTotalMs: startAt + per, kind: "unitDone", unitId: u.id });
  });
  const completeAt = now + per * targets.length;
  pending.push({
    atTotalMs: completeAt,
    kind: "complete",
    msg: fleetEv(completeAt, { k: "complete" }),
  });

  st.rollbackSession = { fromFw: cmd.fw, toFw: FW_STABLE, pending, emitted: [] };
  st.rollbackSession.emitted.push(out[0] as FleetCommandEventMessage);
  // The first unit's window opens NOW: its narration rides the same synchronous answer.
  out.push(...drainRollback(cfg, st, now));
  return out;
}
