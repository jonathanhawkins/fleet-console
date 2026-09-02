import {
  type Alert,
  type AlertMessage,
  type AnomalyKind,
  type CommandEventMessage,
  type DiagEventMessage,
  type ExecutedCommand,
  type FleetCommandEventMessage,
  type FleetSnapshotMessage,
  type Posture,
  type UnitStatus,
  type UnitSummary,
} from "@/lib/schema";
import { type Joint } from "./constants";
import { type DiagTimeline } from "./diagnostics";
import { type IncidentTimeline } from "./incident-knee";
import { type OffsetTimeline } from "./incident-offset";
import { type NavTimeline } from "./nav-recovery";
import { type RecalTimeline } from "./recalibrate";
import { round1 } from "./rng";
import { type CohortTimeline } from "./rollout";
import { type SitTimeline } from "./safe-sit";

/**
 * The engine's mutable state and the helpers every storyline shares. Every
 * storyline and command module takes `(cfg, st, …)` and mutates `st` in place.
 */

export interface UnitState {
  id: string;
  name: string;
  pos: { lat: number; lng: number };
  status: UnitStatus;
  batteryStart: number;
  battery: number;
  baseTemp: Record<Joint, number>;
  gaitFreqHz: number;
  gaitPhase: number;
  activityPeriodMs: number;
  activityPhase: number;
  unitIndex: number;
  posture: Posture;
  /** Storyline ms at which the accepted SAFE SIT began; null while walking. */
  sitStartMs: number | null;
  /** Installed firmware (FW_STABLE or FW_ROLLOUT). */
  fw: string;
  /** Scheduled-but-not-installed upgrade; null unless the rollout has this unit queued. */
  fwPending: string | null;
}

/** Everything resolved from SimEngineOptions once, at construction. Never mutated. */
export interface EngineConfig {
  seed: number;
  /** Epoch offset added to every emitted ts. */
  startTimeMs: number;
  /** Batch interval, ms: the telemetry slot grid. */
  interval: number;
  unitCount: number;
  timeline: IncidentTimeline;
  diagTimeline: DiagTimeline;
  sitTimeline: SitTimeline;
  recalTimeline: RecalTimeline;
  navTimeline: NavTimeline;
  offsetTimeline: OffsetTimeline;
  cohortTimeline: CohortTimeline;
}

export interface DiagBeat {
  atTotalMs: number;
  msg: DiagEventMessage;
}

/** The one in-flight scan (the scanner is a shared resource; one at a time). */
export interface DiagSession {
  unitId: string;
  /** Still-due beats, ascending by atTotalMs. */
  pending: DiagBeat[];
  /** Everything already emitted (scan_start first), for late-joiner replay. */
  emitted: DiagEventMessage[];
}

export interface CommandBeat {
  atTotalMs: number;
  msg: CommandEventMessage;
  /** `settle`: posture flips to "sitting" and the unit restates itself. `remeasure`: the calibrated joint's new channel goes out as a `diag_event`. */
  consequence?: "settle" | "remeasure";
}

/** One in-flight per-unit command (SAFE SIT or RECALIBRATE JOINT). One session per unit: two maneuvers cannot run on one body at once. */
export interface CommandSession {
  cmd: ExecutedCommand;
  /** The slot the command was accepted at — the noise coordinate any measurement it produces is drawn from. */
  slot: number;
  /** Still-due beats, ascending by atTotalMs. */
  pending: CommandBeat[];
  /** accepted + progress emitted so far, for late-joiner replay. */
  emitted: CommandEventMessage[];
}

/** Beats carry their consequences by unit id and apply them at drain time: the firmware flip happens at the beat, not at accept. */
export type RollbackBeat =
  | { atTotalMs: number; kind: "note"; msg: FleetCommandEventMessage }
  | { atTotalMs: number; kind: "unitDone"; unitId: string }
  | { atTotalMs: number; kind: "complete"; msg: FleetCommandEventMessage };

/** The one in-flight staged rollback (the rollout program is one resource, like the scanner). */
export interface RollbackSession {
  /** The build being rolled back (the cohort's fw). */
  fromFw: string;
  /** The known-good baseline the units return to. */
  toFw: string;
  /** Still-due beats, ascending by atTotalMs (built in emission order). */
  pending: RollbackBeat[];
  /** accepted + progress emitted so far, for late-joiner replay. */
  emitted: FleetCommandEventMessage[];
}

export interface EngineState {
  units: UnitState[];
  /** Last emitted slot on the total-time grid. */
  lastSlot: number;
  /** Total-time ms at which the current storyline run began. */
  storylineStartMs: number;
  /** Never reset: alert ids stay unique across RESET_SIM. */
  alertSeq: number;
  /** Never reset: command_event seqs stay unique across RESET_SIM. */
  commandSeq: number;
  /** This run's still-active alerts, for late-joiner replay. `activeAlerts()` means ACTIVE. */
  raisedAlerts: AlertMessage[];
  /** This run's N-03 nav alert, until it self-clears (null before and after). */
  navAlertId: string | null;
  /** This run's N-01 offset amber, until a calibration clears it (null before and after). */
  offsetAlertId: string | null;
  /** Latched when a recalibration re-zeroes N-01's encoder: the telemetry bias stops, a re-scan is clean, an unraised amber never raises. */
  offsetCleared: boolean;
  diagSession: DiagSession | null;
  /** In-flight per-unit commands, keyed by unit. Insertion order is command order, which keeps drain order deterministic. */
  commandSessions: Map<string, CommandSession>;
  /** What this run's scans flagged, unitId → calibration target and anomaly. Written when the `flag` beat emits. */
  flaggedJoints: Map<string, { joint: Joint; anomaly: AnomalyKind }>;
  /** Units whose flagged joint has been recalibrated this run. */
  calibrated: Set<string>;
  /** Flips on HALT_ROLLOUT and on ROLLBACK_COHORT of the rollout build (rolling back implies halting). */
  rolloutHalted: boolean;
  /** This run's still-active cohort alerts, unitId → alertId — the ids a staged rollback's `alert_clear`s cite. */
  cohortAlertIds: Map<string, string>;
  rollbackSession: RollbackSession | null;
}

export function createEngineState(units: UnitState[]): EngineState {
  return {
    units,
    lastSlot: 0,
    storylineStartMs: 0,
    alertSeq: 0,
    commandSeq: 0,
    raisedAlerts: [],
    navAlertId: null,
    offsetAlertId: null,
    offsetCleared: false,
    diagSession: null,
    commandSessions: new Map(),
    flaggedJoints: new Map(),
    calibrated: new Set(),
    rolloutHalted: false,
    cohortAlertIds: new Map(),
    rollbackSession: null,
  };
}

/** RESET_SIM: every storyline field returns to its start with a fresh fleet; the slot clock, alertSeq and commandSeq carry over. */
export function resetStoryline(
  st: EngineState,
  units: UnitState[],
  storylineStartMs: number,
): void {
  st.units = units;
  st.storylineStartMs = storylineStartMs;
  st.raisedAlerts = [];
  st.navAlertId = null;
  st.offsetAlertId = null;
  st.offsetCleared = false;
  st.diagSession = null;
  st.commandSessions.clear();
  st.flaggedJoints.clear();
  st.calibrated.clear();
  st.rolloutHalted = false;
  st.rollbackSession = null;
  st.cohortAlertIds.clear();
}

/** One unit's wire summary — the single mapping snapshot() and unit_update share. */
export function summarize(u: UnitState): UnitSummary {
  return {
    id: u.id,
    name: u.name,
    status: u.status,
    battery: round1(u.battery),
    pos: u.pos,
    posture: u.posture,
    fw: u.fw,
    // Omitted (not null) when nothing is queued: the field is additive.
    ...(u.fwPending !== null ? { fwPending: u.fwPending } : {}),
  };
}

export function snapshot(st: EngineState): FleetSnapshotMessage {
  return { t: "fleet_snapshot", units: st.units.map(summarize) };
}

export function findUnit(st: EngineState, id: string): UnitState | undefined {
  return st.units.find((x) => x.id === id);
}

/** A scripted unit the roster must always carry (the core eight are always present). */
export function requireUnit(st: EngineState, id: string): UnitState {
  const u = findUnit(st, id);
  if (!u) throw new Error(`sim fleet is missing ${id}`);
  return u;
}

/** "Now" on the engine's clock: the last advanced slot, in total-time ms. */
export function nowTotalMs(cfg: EngineConfig, st: EngineState): number {
  return st.lastSlot * cfg.interval;
}

/** Wire timestamp for a storyline instant. */
export function storylineTs(
  cfg: EngineConfig,
  st: EngineState,
  storylineMs: number,
): number {
  return cfg.startTimeMs + st.storylineStartMs + storylineMs;
}

/** Ids stay unique across RESET_SIM: the seq never resets. */
export function nextAlertId(st: EngineState): string {
  return `al-${String(++st.alertSeq).padStart(3, "0")}`;
}

export function nextCommandSeq(st: EngineState): number {
  return ++st.commandSeq;
}

/** Raise an alert on a unit at a storyline instant and enter it into the late-joiner replay list. */
export function raiseAlert(
  cfg: EngineConfig,
  st: EngineState,
  u: UnitState,
  severity: Alert["severity"],
  message: string,
  atStorylineMs: number,
): AlertMessage {
  const alert: Alert = {
    id: nextAlertId(st),
    unitId: u.id,
    severity,
    message,
    ts: storylineTs(cfg, st, atStorylineMs),
  };
  const msg: AlertMessage = { t: "alert", alert };
  st.raisedAlerts.push(msg);
  return msg;
}

/** A cleared alert leaves the replay list: a late joiner gets the current truth, not a resolved ghost. */
export function dropAlert(st: EngineState, alertId: string): void {
  st.raisedAlerts = st.raisedAlerts.filter((m) => m.alert.id !== alertId);
}
