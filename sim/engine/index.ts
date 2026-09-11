import {
  type AlertMessage,
  type CommandEventMessage,
  type DiagEventMessage,
  type FleetCommandEventMessage,
  type FleetMessage,
  type FleetSnapshotMessage,
  type OperatorCommand,
} from "@/lib/schema";
import { drainCommands, handleCommand } from "./commands";
import { BATCH_INTERVAL_MS, JOINTS } from "./constants";
import { DEFAULT_DIAG_TIMELINE, drainDiag, type DiagTimeline } from "./diagnostics";
import { FLEET_UNITS, initUnits, MAX_UNIT_COUNT, MIN_UNIT_COUNT } from "./fleet";
import { DEFAULT_TIMELINE, type IncidentTimeline } from "./incident-knee";
import { DEFAULT_OFFSET_TIMELINE, type OffsetTimeline } from "./incident-offset";
import { DEFAULT_NAV_TIMELINE, type NavTimeline } from "./nav-recovery";
import { DEFAULT_RECAL_TIMELINE, type RecalTimeline } from "./recalibrate";
import { DEFAULT_COHORT_TIMELINE, drainRollback, type CohortTimeline } from "./rollout";
import { storylineCrossings } from "./crossings";
import { DEFAULT_SIT_TIMELINE, type SitTimeline } from "./safe-sit";
import { createEngineState, snapshot, type EngineConfig } from "./state";
import { samplePoint, updateBattery } from "./telemetry";

/**
 * The simulator core (PRD §4, "the scripted incident"). Pure TypeScript and
 * transport-agnostic: no ws imports, no timers, no Date.now(). The host owns
 * the clock and calls `advance(totalMs)`; the engine returns the
 * FleetMessages due since the previous call.
 *
 * Determinism: per-unit character is drawn once from a seeded mulberry32
 * stream (fleet.ts) and per-sample noise is a pure hash of (seed, unit,
 * joint, slot), so a run is a pure function of (seed, timelines), RESET_SIM
 * replays the same story, and two engines with the same seed produce
 * byte-identical streams.
 */

export interface SimEngineOptions {
  seed?: number;
  /** Epoch offset added to every emitted ts. 0 (default) keeps ts == sim ms for tests. */
  startTimeMs?: number;
  timeline?: Partial<IncidentTimeline>;
  batchIntervalMs?: number;
  /** Diagnostic scan pacing; see DEFAULT_DIAG_TIMELINE. */
  diagTimeline?: Partial<DiagTimeline>;
  /** SAFE SIT pacing; see DEFAULT_SIT_TIMELINE. */
  sitTimeline?: Partial<SitTimeline>;
  /** RECALIBRATE JOINT pacing; see DEFAULT_RECAL_TIMELINE. */
  recalTimeline?: Partial<RecalTimeline>;
  /** N-03 blocked-navigation beats; see DEFAULT_NAV_TIMELINE. */
  navTimeline?: Partial<NavTimeline>;
  /** N-01 encoder-offset beats; see DEFAULT_OFFSET_TIMELINE. */
  offsetTimeline?: Partial<OffsetTimeline>;
  /** Firmware-cohort beats + rollback pacing; see DEFAULT_COHORT_TIMELINE. */
  cohortTimeline?: Partial<CohortTimeline>;
  /** Fleet size, clamped to [MIN_UNIT_COUNT, MAX_UNIT_COUNT]; the core eight are always units 0–7. */
  unitCount?: number;
}

export interface SimEngine {
  /** Fleet state right now — sent to every client on connect. */
  snapshot(): FleetSnapshotMessage;
  /** Alerts still active this run (cleared by RESET_SIM); the host replays them to late joiners after the snapshot. */
  activeAlerts(): AlertMessage[];
  /** diag_events emitted so far by the in-flight scan, oldest first; replayed after the alerts. Cleared at the verdict and by RESET_SIM. */
  activeDiagEvents(): DiagEventMessage[];
  /** command_events emitted so far by in-flight per-unit commands, oldest first per unit; replayed after the diag events. Refusals are never replayed. */
  activeCommandEvents(): CommandEventMessage[];
  /** fleet_command_events emitted so far by an in-flight ROLLBACK_COHORT, replayed last. HALT_ROLLOUT is synchronous and never appears here. */
  activeFleetCommandEvents(): FleetCommandEventMessage[];
  /** Advance the sim clock to `totalMs` (monotonic, ms since engine start); returns messages due since the last call. */
  advance(totalMs: number): FleetMessage[];
  /** Apply an operator command; returns messages to broadcast (e.g. a fresh snapshot after RESET_SIM). */
  handle(cmd: OperatorCommand): FleetMessage[];
}

/** If advance() is called after a huge gap (laptop slept), emit at most this many slots. */
const MAX_CATCHUP_SLOTS = 100;

function resolveConfig(options: SimEngineOptions): EngineConfig {
  return {
    seed: options.seed ?? 0x5eed,
    startTimeMs: options.startTimeMs ?? 0,
    interval: options.batchIntervalMs ?? BATCH_INTERVAL_MS,
    unitCount: Math.min(
      MAX_UNIT_COUNT,
      Math.max(MIN_UNIT_COUNT, Math.round(options.unitCount ?? FLEET_UNITS.length)),
    ),
    timeline: { ...DEFAULT_TIMELINE, ...options.timeline },
    diagTimeline: { ...DEFAULT_DIAG_TIMELINE, ...options.diagTimeline },
    sitTimeline: { ...DEFAULT_SIT_TIMELINE, ...options.sitTimeline },
    recalTimeline: { ...DEFAULT_RECAL_TIMELINE, ...options.recalTimeline },
    navTimeline: { ...DEFAULT_NAV_TIMELINE, ...options.navTimeline },
    offsetTimeline: { ...DEFAULT_OFFSET_TIMELINE, ...options.offsetTimeline },
    cohortTimeline: { ...DEFAULT_COHORT_TIMELINE, ...options.cohortTimeline },
  };
}

export function createSimEngine(options: SimEngineOptions = {}): SimEngine {
  const cfg = resolveConfig(options);
  const st = createEngineState(initUnits(cfg.seed, cfg.unitCount));

  const crossings = (prevMs: number, curMs: number): FleetMessage[] =>
    storylineCrossings(cfg, st, prevMs, curMs);

  function advance(totalMs: number): FleetMessage[] {
    const out: FleetMessage[] = [];
    const { interval } = cfg;
    const targetSlot = Math.floor(totalMs / interval);

    if (targetSlot > st.lastSlot) {
      let slot = st.lastSlot;
      if (targetSlot - slot > MAX_CATCHUP_SLOTS) {
        // Long gap: skip stale telemetry but honor any storyline beats inside it.
        const skipTo = targetSlot - MAX_CATCHUP_SLOTS;
        out.push(
          ...crossings(
            slot * interval - st.storylineStartMs,
            skipTo * interval - st.storylineStartMs,
          ),
        );
        slot = skipTo;
      }

      while (slot < targetSlot) {
        slot += 1;
        const slotTotalMs = slot * interval;
        const storylineMs = slotTotalMs - st.storylineStartMs;
        out.push(...crossings(storylineMs - interval, storylineMs));
        for (const u of st.units) {
          updateBattery(u, storylineMs);
          out.push({
            t: "telemetry",
            unitId: u.id,
            ts: cfg.startTimeMs + slotTotalMs,
            batch: JOINTS.map((j) => samplePoint(cfg, st, u, j, storylineMs)),
          });
        }
      }

      st.lastSlot = targetSlot;
    }

    // Diag, command, and rollback beats live off the slot grid: everything due
    // drains, even across a long gap. Within one advance() the order is fixed
    // — telemetry, diag, command, rollback — so identical call patterns
    // produce identical streams.
    out.push(...drainDiag(st, totalMs));
    out.push(...drainCommands(cfg, st, totalMs));
    out.push(...drainRollback(cfg, st, totalMs));
    return out;
  }

  return {
    snapshot: () => snapshot(st),
    activeAlerts: () => [...st.raisedAlerts],
    activeDiagEvents: () => (st.diagSession ? [...st.diagSession.emitted] : []),
    activeCommandEvents: () => {
      const out: CommandEventMessage[] = [];
      for (const session of st.commandSessions.values()) out.push(...session.emitted);
      return out;
    },
    activeFleetCommandEvents: () =>
      st.rollbackSession ? [...st.rollbackSession.emitted] : [],
    advance,
    handle: (cmd) => handleCommand(cfg, st, cmd),
  };
}

// ---------------------------------------------------------------------------
// public surface — every name sim/engine.ts has always exported

export { BATCH_INTERVAL_MS, JOINTS, type Joint } from "./constants";
export {
  ADVANCE_LEAD_MS,
  CHAPTER_LEAD_MS,
  chapterAdvanceMs,
  chapterBeatMs,
  chapterSeekMs,
  STORYLINE_CHAPTERS,
  type StorylineChapter,
} from "./chapters";
export { FLEET_UNITS, GEN_REGION, MAX_UNIT_COUNT, MIN_UNIT_COUNT } from "./fleet";
export {
  DEFAULT_TIMELINE,
  FAULT_GAIN_END,
  FAULT_GAIN_START,
  INCIDENT_COMPONENT,
  INCIDENT_JOINT,
  INCIDENT_UNIT_ID,
  type IncidentTimeline,
} from "./incident-knee";
export {
  DEFAULT_OFFSET_TIMELINE,
  OFFSET_ALERT_MESSAGE,
  OFFSET_BIAS,
  OFFSET_COMPONENT,
  OFFSET_JOINT,
  OFFSET_TEMP_RISE,
  OFFSET_TORQUE_BIAS,
  OFFSET_UNIT_ID,
  type OffsetTimeline,
} from "./incident-offset";
export {
  DEFAULT_NAV_TIMELINE,
  NAV_BLOCK_MESSAGE,
  NAV_RAMP_MS,
  NAV_UNIT_ID,
  type NavTimeline,
} from "./nav-recovery";
export {
  COHORT_ALERT_MESSAGE,
  DEFAULT_COHORT_TIMELINE,
  FW_ROLLOUT,
  FW_STABLE,
  PENDING_UNIT_ID,
  ROLLOUT_REFUSAL_NO_ROLLOUT_ACTIVE,
  ROLLOUT_REFUSAL_ROLLBACK_IN_PROGRESS,
  ROLLOUT_UNIT_IDS,
  type CohortTimeline,
} from "./rollout";
export {
  CHANNEL_SAMPLES,
  DEFAULT_DIAG_TIMELINE,
  DIAG_WALK_PATHS,
  scaleDiagTimeline,
  type DiagTimeline,
} from "./diagnostics";
export {
  CALIB_GAIN_END,
  CALIB_GAIN_START,
  CALIBRATION_OUTCOME,
  KNEE_FAULT,
  OFFSET_FAULT,
  type ChannelFault,
  type ScriptedFault,
} from "./faults";
export {
  DEFAULT_SIT_TIMELINE,
  SIT_PROGRESS_BEATS,
  SIT_REFUSAL_ALREADY_SITTING,
  SIT_REFUSAL_SCAN_IN_PROGRESS,
  SIT_REFUSAL_SIT_IN_PROGRESS,
  SIT_TEMP_TAU_MS,
  type SitTimeline,
} from "./safe-sit";
export {
  DEFAULT_RECAL_TIMELINE,
  RECAL_PROGRESS_BEATS,
  RECAL_REFUSAL_CURRENT,
  RECAL_REFUSAL_IN_PROGRESS,
  RECAL_REFUSAL_NO_TARGET,
  RECAL_REFUSAL_NOT_SEATED,
  RECAL_REFUSAL_SCAN_IN_PROGRESS,
  RECAL_REFUSAL_SIT_IN_PROGRESS,
  type RecalTimeline,
} from "./recalibrate";
