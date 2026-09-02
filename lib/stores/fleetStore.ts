import { create } from "zustand";
import {
  type Alert,
  type AlertMessage,
  type FleetSnapshotMessage,
  type TelemetryMessage,
  type UnitSummary,
  type UnitUpdateMessage,
} from "@/lib/schema";
import { type ConnectionStatus } from "@/lib/transport/types";
import { useAuditStore, type AuditEntry } from "./auditStore";
import { RingBuffer } from "./ringBuffer";

/**
 * Fleet store: units, alerts, connection, and telemetry *versions*.
 *
 * The samples themselves live in module-level ring buffers (see README —
 * "mutable arrays + version counter"): `applyTelemetry` writes the batch into
 * the rings, then makes exactly ONE `set()` commit that bumps the unit's
 * version counter (PRD §7: one commit per 10 Hz batch, one render per
 * commit). Canvas code reads the rings directly inside its rAF loop; React
 * components subscribe only to the narrow slices they display.
 */

// ---------------------------------------------------------------------------
// telemetry ring buffers (non-reactive, module-level)

/** ~60 s of history per series at 10 Hz. */
export const TELEMETRY_RING_CAPACITY = 600;

export type TelemetryMetric = "tempC" | "torqueNm" | "currentA";
export type JointSeries = Record<TelemetryMetric, RingBuffer>;

export interface UnitBuffers {
  /** Batch timestamps (epoch ms); shared x-axis for every series of the unit. */
  ts: RingBuffer;
  /** Battery %, one sample per batch. */
  battery: RingBuffer;
  /** Per-joint tempC / torqueNm / currentA, one sample each per batch. */
  joints: Map<string, JointSeries>;
}

const buffers = new Map<string, UnitBuffers>();

function ensureUnitBuffers(unitId: string): UnitBuffers {
  let unit = buffers.get(unitId);
  if (!unit) {
    unit = {
      ts: new RingBuffer(TELEMETRY_RING_CAPACITY),
      battery: new RingBuffer(TELEMETRY_RING_CAPACITY),
      joints: new Map(),
    };
    buffers.set(unitId, unit);
  }
  return unit;
}

function ensureJointSeries(unit: UnitBuffers, joint: string): JointSeries {
  let series = unit.joints.get(joint);
  if (!series) {
    series = {
      tempC: new RingBuffer(TELEMETRY_RING_CAPACITY),
      torqueNm: new RingBuffer(TELEMETRY_RING_CAPACITY),
      currentA: new RingBuffer(TELEMETRY_RING_CAPACITY),
    };
    unit.joints.set(joint, series);
  }
  return series;
}

/**
 * Read access for the canvas layer. Rings mutate in place — read them inside
 * the rAF loop (or after a version bump), never store snapshots of them.
 */
export function getUnitBuffers(unitId: string): UnitBuffers | undefined {
  return buffers.get(unitId);
}

/**
 * Where each unit's retained history ends at the moment the world restates —
 * the seam between two runs (`FleetState.telemetryEpochTs`).
 *
 * The rings deliberately survive a snapshot (`applySnapshot`), so after a
 * RESET_SIM they still hold the run that just ended. That is right for the
 * charts, which are drawing a continuous 60 s of a robot's life, and wrong for
 * anything that fits a RATE across time: the storyline replays from the top,
 * so a window spanning the seam is a fit over two different runs glued
 * together. Marking the seam costs one pass over the rings per snapshot —
 * they are rare — and lets those derivations refuse to read past it.
 */
function markTelemetryEpoch(): Record<string, number> {
  const epochs: Record<string, number> = {};
  for (const [unitId, unit] of buffers) {
    const newest = unit.ts.last();
    if (newest !== undefined) epochs[unitId] = newest;
  }
  return epochs;
}

// ---------------------------------------------------------------------------
// reactive state

const MAX_ALERTS = 100;

/** How an alert got resolved — the linkage the audit trail and UI cite. */
export interface AlertResolution {
  /** What closed it: the SAFE SIT command, a logged diagnostic incident, the operator's judgment, the unit's own recovery, a staged firmware rollback, or a recalibration that re-zeroed the flagged channel (the last three arrive on the wire as `alert_clear`). */
  via:
    | "safe-sit"
    | "incident"
    | "operator"
    | "self-recovery"
    | "rollback"
    | "recalibration";
  /** Linkage target: incident id ("inc-N-07-…") or command ref ("COMMAND_SAFE_SIT#3"). */
  ref?: string;
}

/**
 * Client-side lifecycle of one alert. The wire owns the alert
 * itself; acknowledgement and resolution are operator facts this console
 * records — there is no ACK on the wire by design. Keyed by alert id (unique
 * across RESET_SIM runs) and session-scoped: it survives snapshots, so a
 * reconnect that replays the run's alerts does not un-ack them.
 */
export interface AlertMeta {
  ackedAt?: number;
  ackedBy?: string;
  resolvedAt?: number;
  resolution?: AlertResolution;
}

export interface FleetState {
  connection: ConnectionStatus;
  /** Unit summaries by id; entry identity changes only when that unit's summary changes. */
  units: Record<string, UnitSummary>;
  /** Snapshot order — the rail's stable row order. */
  unitIds: string[];
  /** Newest first, deduped by id, capped at MAX_ALERTS. */
  alerts: Alert[];
  /** Ack/resolution lifecycle per alert id; see AlertMeta. Session-scoped. */
  alertMeta: Record<string, AlertMeta>;
  /**
   * Latest battery % per unit (0.1 resolution), from telemetry. Mutated IN
   * PLACE by `applyTelemetry`, like `unitTelemetryVersions`: consumers read
   * per-unit VALUES (`selectUnitBattery`), never the record.
   */
  latestBattery: Record<string, number>;
  /**
   * Epoch ms of the unit's newest telemetry batch, quantized to 1 s (same
   * trick as latestBattery): the stored value only moves when the batch
   * crosses a second boundary, so "last contact" subscribers re-render at
   * most once per second per unit, not per batch. Mutated IN PLACE by
   * `applyTelemetry`, like `unitTelemetryVersions` — `selectLastContact`
   * reads a per-unit value, never the record.
   */
  lastContactAt: Record<string, number>;
  /**
   * Bumped once per telemetry batch for the unit that received it — IN PLACE.
   * Same philosophy as the ring buffers: the record's identity is stable and
   * not part of the contract; consumers read per-unit VALUES (primitives), via
   * `selectUnitTelemetryVersion` or a `getState()` poll, never the record.
   */
  unitTelemetryVersions: Record<string, number>;
  /**
   * Per-unit ts of the newest sample the rings held when the world last
   * restated (`markTelemetryEpoch`): the seam between runs. Absent for a unit
   * that had reported nothing yet.
   *
   * Unlike its neighbours this record is REPLACED, not mutated — a snapshot is
   * rare and its new identity is the signal derivations key their own reset
   * on (lib/stores/trendWatch.ts). Samples at or before a unit's epoch belong
   * to a previous run: RESET_SIM replays the storyline from the top while the
   * rings keep their history, so a rate fitted across this seam is a fit over
   * two runs glued together, and a latch held across it lets the second run
   * be judged on the first one's evidence.
   */
  telemetryEpochTs: Record<string, number>;
  /**
   * Bumped once per telemetry batch, any unit — the store's notification
   * counter. On a quiet batch (battery and contact-second unmoved) it is the
   * only field in the commit, and the reason that commit is still an honest
   * state change that wakes every subscriber.
   */
  telemetryVersion: number;
  // KPIs (header): kept as primitives so subscribers stay narrow.
  kpiNominal: number;
  kpiAlerts: number;
  kpiAvgBattery: number;
  /**
   * Bookkeeping behind kpiAvgBattery — running Σ and count of every counted
   * unit's effective battery (`latestBattery[id] ?? units[id].battery` over
   * `unitIds`), so a telemetry battery move re-derives the KPI in O(1)
   * instead of walking the fleet. Full recomputes (snapshot, alert) re-seed
   * both through `computeKpis`, which also bounds FP drift from the
   * incremental adds. Internal: no selector reads them.
   */
  kpiBatterySum: number;
  kpiBatteryCount: number;

  applySnapshot(msg: FleetSnapshotMessage): void;
  applyTelemetry(msg: TelemetryMessage): void;
  applyAlert(msg: AlertMessage): void;
  /**
   * Wire: one unit's summary restated live (today: the SAFE SIT settle beat's
   * posture flip). Replaces that unit's entry — and only that entry — and
   * recomputes the KPIs. Idempotent: a content-equal restatement is a no-op
   * (zero re-renders), and an id the snapshot never introduced is ignored —
   * the snapshot owns the roster and the rail's row order.
   */
  applyUnitUpdate(msg: UnitUpdateMessage): void;
  setConnection(status: ConnectionStatus): void;
  /**
   * UI: the operator acknowledged an alert (took ownership). Idempotent; no-op
   * for unknown alert ids. Appends an "alert-acked" audit entry once.
   */
  ackAlert(alertId: string, operator?: string): void;
  /**
   * UI: the operator resolved an alert, citing what closed it (a completed
   * SAFE SIT, a logged incident, or their own judgment). Idempotent; no-op for
   * unknown alert ids. The alert stays in the feed — the wire owns the feed,
   * the lifecycle is metadata — the UI renders the resolved state from meta.
   */
  resolveAlert(alertId: string, resolution: AlertResolution): void;
  /** Full reset: state AND ring buffers. Tests + app teardown. */
  reset(): void;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Units with at least one UNRESOLVED alert. Resolution lives in
 * `alertMeta` (`resolvedAt`) — the feed is audit truth and keeps its rows — so
 * the header KPI reads both: an alert closed by the operator, a completed sit,
 * or the unit itself (the wire's `alert_clear`) stops marking its unit as
 * alerting. Acks do not count — acked is owned, not closed — and the unit's
 * status badge stays the wire's business (condition persists until reset).
 */
function countAlertingUnits(
  alerts: Alert[],
  alertMeta: Record<string, AlertMeta>,
): number {
  const alerting = new Set<string>();
  for (const a of alerts) {
    if (alertMeta[a.id]?.resolvedAt === undefined) alerting.add(a.unitId);
  }
  return alerting.size;
}

function computeKpis(
  units: Record<string, UnitSummary>,
  unitIds: string[],
  alerts: Alert[],
  alertMeta: Record<string, AlertMeta>,
  latestBattery: Record<string, number>,
): {
  kpiNominal: number;
  kpiAlerts: number;
  kpiAvgBattery: number;
  kpiBatterySum: number;
  kpiBatteryCount: number;
} {
  let nominal = 0;
  let batterySum = 0;
  let batteryCount = 0;
  for (const id of unitIds) {
    const unit = units[id];
    if (!unit) continue;
    if (unit.status === "nominal") nominal += 1;
    const battery = latestBattery[id] ?? unit.battery;
    batterySum += battery;
    batteryCount += 1;
  }
  // kpiAlerts counts UNITS with an active — unresolved — alert, not alert
  // events: an amber followed by a red on the same unit is one troubled unit,
  // and the header KPI sits next to "Units nominal", so it must count in the
  // same currency. The feed's own badge counts events via `alerts.length`.
  return {
    kpiNominal: nominal,
    kpiAlerts: countAlertingUnits(alerts, alertMeta),
    kpiAvgBattery: batteryCount === 0 ? 0 : Math.round(batterySum / batteryCount),
    kpiBatterySum: batterySum,
    kpiBatteryCount: batteryCount,
  };
}

/**
 * Content equality for one unit's wire summary — `applyUnitUpdate`'s
 * short-circuit. Field-by-field on purpose, and the `satisfies` clause is the
 * load-bearing part: it demands a comparison entry for EVERY UnitSummary
 * field, so a schema addition that forgets this list fails to typecheck
 * instead of silently treating that field's restatements as "unchanged"
 * ( amendment: `fw`/`fwPending` were exactly that — a firmware-only
 * unit_update landed only when battery happened to drift in the same
 * restatement).
 */
function sameSummary(a: UnitSummary, b: UnitSummary): boolean {
  const compared = {
    id: a.id === b.id,
    name: a.name === b.name,
    status: a.status === b.status,
    battery: a.battery === b.battery,
    pos: a.pos.lat === b.pos.lat && a.pos.lng === b.pos.lng,
    posture: a.posture === b.posture,
    fw: a.fw === b.fw,
    fwPending: a.fwPending === b.fwPending,
  } satisfies Record<keyof UnitSummary, boolean>;
  // every() over the record, not a && chain: a key the compiler forced into
  // `compared` above can never be computed here and then forgotten.
  return Object.values(compared).every(Boolean);
}

/**
 * A factory, not a const: `unitTelemetryVersions`, `latestBattery` and
 * `lastContactAt` are mutated in place by `applyTelemetry`, so a shared
 * initial object would get polluted and `reset()` would resurrect stale
 * entries into the "fresh" state.
 */
const createInitialState = () => ({
  connection: "idle" as ConnectionStatus,
  units: {},
  unitIds: [],
  alerts: [],
  alertMeta: {} as Record<string, AlertMeta>,
  latestBattery: {} as Record<string, number>,
  lastContactAt: {} as Record<string, number>,
  unitTelemetryVersions: {} as Record<string, number>,
  telemetryEpochTs: {} as Record<string, number>,
  telemetryVersion: 0,
  kpiNominal: 0,
  kpiAlerts: 0,
  kpiAvgBattery: 0,
  kpiBatterySum: 0,
  kpiBatteryCount: 0,
});

export const useFleetStore = create<FleetState>()((set) => ({
  ...createInitialState(),

  applySnapshot: (msg) =>
    set((s) => {
      const units: Record<string, UnitSummary> = {};
      const unitIds: string[] = [];
      for (const u of msg.units) {
        units[u.id] = u;
        unitIds.push(u.id);
      }
      // A snapshot restates the world (fresh connect or RESET_SIM): the alert
      // feed clears and the server replays still-active alerts right after.
      // Ring buffers are left alone — history simply ages out of the window —
      // so the seam is MARKED instead (`telemetryEpochTs`): the charts keep
      // drawing across it, and a derivation that fits a rate over time can
      // refuse to. `alertMeta` does NOT clear — it is keyed by alert id
      // (unique across runs) and an ack must survive a reconnect's snapshot +
      // replay.
      const alerts: Alert[] = [];
      return {
        units,
        unitIds,
        alerts,
        latestBattery: {},
        lastContactAt: {},
        telemetryEpochTs: markTelemetryEpoch(),
        ...computeKpis(units, unitIds, alerts, s.alertMeta, {}),
      };
    }),

  applyTelemetry: (msg) => {
    // Ordering is enforced upstream: the transport's `createOrderingGate` has
    // already dropped any batch with ts <= the unit's newest (README,
    // "Out-of-order and replay policy") — this reducer trusts its input.

    // 1) mutate the rings (outside reactive state)
    const unit = ensureUnitBuffers(msg.unitId);
    unit.ts.push(msg.ts);
    const battery = msg.batch[0]?.battery;
    if (battery !== undefined) unit.battery.push(battery);
    for (const p of msg.batch) {
      const series = ensureJointSeries(unit, p.joint);
      series.tempC.push(p.tempC);
      series.torqueNm.push(p.torqueNm);
      series.currentA.push(p.currentA);
    }

    // 2) exactly one commit
    set((s) => {
      // In place, like the rings: `unitTelemetryVersions`, `latestBattery`
      // and `lastContactAt` all mutate under stable record identities that no
      // consumer observes — selectors read per-unit VALUES (primitives), so
      // zustand's Object.is bail-out wakes exactly the subscribers whose
      // value moved, and nobody else. Spreading these records here was an
      // O(fleet) allocation per commit; at 500 units the wave where every
      // unit crosses a 1 s contact boundary together spent ~14 ms re-copying
      // 500-key records (docs/perf.md "Commit cost per batch
      // wave"). This reducer does no O(fleet) work on any path.
      s.unitTelemetryVersions[msg.unitId] =
        (s.unitTelemetryVersions[msg.unitId] ?? 0) + 1;
      // `telemetryVersion` is the commit's load-bearing field: it changes on
      // every batch, so even a quiet one produces a real top-level state
      // change and a notification — and with the records above mutating in
      // place, it is what makes their writes observable at all. Don't remove
      // it (audit NPA-06).
      const next: Partial<FleetState> = {
        telemetryVersion: s.telemetryVersion + 1,
      };
      if (battery !== undefined) {
        const rounded = round1(battery);
        const prev = s.latestBattery[msg.unitId];
        if (prev !== rounded) {
          s.latestBattery[msg.unitId] = rounded;
          // kpiAvgBattery in O(1): shift the running sum by this unit's move
          // and re-round. A unit's first batch replaces its snapshot battery
          // in the sum — the same `latestBattery[id] ?? unit.battery`
          // fallback computeKpis uses — and units outside the snapshot are
          // recorded (selectUnitBattery still works) but never counted, also
          // matching computeKpis. The KPI field itself commits only when the
          // rounded fleet average actually moves.
          const summary = s.units[msg.unitId];
          if (summary) {
            const sum = s.kpiBatterySum - (prev ?? summary.battery) + rounded;
            next.kpiBatterySum = sum;
            const avg = s.kpiBatteryCount === 0 ? 0 : Math.round(sum / s.kpiBatteryCount);
            if (avg !== s.kpiAvgBattery) next.kpiAvgBattery = avg;
          }
        }
      }
      // 1 s quantization: the stored value only moves when the second
      // boundary does.
      const contactAt = Math.floor(msg.ts / 1000) * 1000;
      if (s.lastContactAt[msg.unitId] !== contactAt) {
        s.lastContactAt[msg.unitId] = contactAt;
      }
      return next;
    });
  },

  applyAlert: (msg) => {
    const audits: Array<Omit<AuditEntry, "id">> = [];

    set((s) => {
      if (s.alerts.some((a) => a.id === msg.alert.id)) return s; // replay dedupe

      // Audit: the raise itself, and — when a red lands on a unit already
      // carrying an amber — the escalation as its own entry. Both carry the
      // alert id as ref, so a reconnect's replay (feed cleared by snapshot,
      // then re-sent) restates rather than double-logs.
      audits.push({
        ts: msg.alert.ts,
        kind: "alert-raised",
        unitId: msg.alert.unitId,
        summary: msg.alert.message,
        ref: msg.alert.id,
      });
      if (
        msg.alert.severity === "red" &&
        s.alerts.some((a) => a.unitId === msg.alert.unitId && a.severity === "amber")
      ) {
        audits.push({
          ts: msg.alert.ts,
          kind: "escalation",
          unitId: msg.alert.unitId,
          summary: "Escalated amber → red",
          ref: msg.alert.id,
        });
      }

      const alerts = [msg.alert, ...s.alerts].slice(0, MAX_ALERTS);
      let units = s.units;
      const unit = s.units[msg.alert.unitId];
      if (unit && unit.status !== msg.alert.severity) {
        units = {
          ...s.units,
          [msg.alert.unitId]: { ...unit, status: msg.alert.severity },
        };
      }
      return {
        alerts,
        units,
        ...computeKpis(units, s.unitIds, alerts, s.alertMeta, s.latestBattery),
      };
    });

    const audit = useAuditStore.getState();
    for (const entry of audits) audit.append(entry);
  },

  applyUnitUpdate: (msg) =>
    set((s) => {
      const prev = s.units[msg.unit.id];
      if (!prev) return s; // roster is the snapshot's; an unknown id is noise
      const u = msg.unit;
      if (sameSummary(prev, u)) {
        return s; // content-equal restatement: keep every identity, wake nobody
      }
      // One entry's identity moves — exactly the discipline applyAlert keeps —
      // so only this unit's subscribers re-render. KPIs recompute in O(fleet)
      // like every non-telemetry commit (rare: settle beats, not batches).
      const units = { ...s.units, [u.id]: u };
      return {
        units,
        ...computeKpis(units, s.unitIds, s.alerts, s.alertMeta, s.latestBattery),
      };
    }),

  setConnection: (status) => set({ connection: status }),

  ackAlert: (alertId, operator = "Operator") => {
    let audit: Omit<AuditEntry, "id"> | null = null;

    set((s) => {
      const alert = s.alerts.find((a) => a.id === alertId);
      if (!alert) return s; // unknown or already restated away: nothing to ack
      if (s.alertMeta[alertId]?.ackedAt !== undefined) return s; // idempotent
      const now = Date.now();
      audit = {
        ts: now,
        kind: "alert-acked",
        unitId: alert.unitId,
        summary: `Acknowledged by ${operator}`,
        ref: alertId,
      };
      return {
        alertMeta: {
          ...s.alertMeta,
          [alertId]: { ...s.alertMeta[alertId], ackedAt: now, ackedBy: operator },
        },
      };
    });

    if (audit !== null) useAuditStore.getState().append(audit);
  },

  resolveAlert: (alertId, resolution) => {
    let audit: Omit<AuditEntry, "id"> | null = null;

    set((s) => {
      const alert = s.alerts.find((a) => a.id === alertId);
      if (!alert) return s;
      if (s.alertMeta[alertId]?.resolvedAt !== undefined) return s; // idempotent
      const now = Date.now();
      const summary =
        resolution.via === "safe-sit"
          ? "Resolved — unit commanded to safe sit"
          : resolution.via === "incident"
            ? "Resolved — diagnostic incident logged"
            : resolution.via === "self-recovery"
              ? "Resolved — self-recovered"
              : resolution.via === "rollback"
                ? "Resolved — firmware rolled back"
                : resolution.via === "recalibration"
                  ? "Resolved — joint recalibrated over the link"
                  : "Resolved by operator";
      audit = {
        ts: now,
        kind: "resolution",
        unitId: alert.unitId,
        summary,
        ref: alertId,
      };
      const alertMeta = {
        ...s.alertMeta,
        [alertId]: { ...s.alertMeta[alertId], resolvedAt: now, resolution },
      };
      return {
        alertMeta,
        // The KPI's currency is units with an UNRESOLVED alert, so a
        // resolution is one of its recompute paths. This one line
        // covers every closer — operator judgment, a completed sit, a logged
        // incident, and the wire's `alert_clear`, which bindTransport routes
        // here. `ackAlert` deliberately does no such recompute: an ack moves
        // ownership, not the count.
        kpiAlerts: countAlertingUnits(s.alerts, alertMeta),
      };
    });

    if (audit !== null) useAuditStore.getState().append(audit);
  },

  reset: () => {
    buffers.clear();
    set(createInitialState());
  },
}));

// ---------------------------------------------------------------------------
// narrow selectors — subscribe to exactly what a component displays

export const selectConnection = (s: FleetState): ConnectionStatus => s.connection;
export const selectUnitIds = (s: FleetState): string[] => s.unitIds;
export const selectAlerts = (s: FleetState): Alert[] => s.alerts;
export const selectKpiNominal = (s: FleetState): number => s.kpiNominal;
export const selectKpiAlerts = (s: FleetState): number => s.kpiAlerts;
export const selectKpiAvgBattery = (s: FleetState): number => s.kpiAvgBattery;

/** Summary for one rail row / map marker. Identity stable unless THIS unit changes. */
export const selectUnit =
  (unitId: string) =>
  (s: FleetState): UnitSummary | undefined =>
    s.units[unitId];

/** Live battery for one unit (0.1 % resolution); falls back to the snapshot value. */
export const selectUnitBattery =
  (unitId: string) =>
  (s: FleetState): number =>
    s.latestBattery[unitId] ?? s.units[unitId]?.battery ?? 0;

/** Bumps once per batch for this unit — chart hosts re-draw on this, nothing else. */
export const selectUnitTelemetryVersion =
  (unitId: string) =>
  (s: FleetState): number =>
    s.unitTelemetryVersions[unitId] ?? 0;

/**
 * Epoch ms of the unit's newest telemetry batch, quantized to 1 s —
 * `undefined` until the unit's first batch of the run. Safe to bind
 * "last contact Xs ago" text to (re-renders once per second, not per batch);
 * pair with the app's shared 1 s ticker for the "ago" half.
 */
export const selectLastContact =
  (unitId: string) =>
  (s: FleetState): number | undefined =>
    s.lastContactAt[unitId];

/** Lifecycle meta for one alert (undefined = un-acked, un-resolved). */
export const selectAlertMeta =
  (alertId: string) =>
  (s: FleetState): AlertMeta | undefined =>
    s.alertMeta[alertId];

/**
 * Epoch ms of the unit's OLDEST active alert — when this unit's trouble
 * started (undefined = no active alert). A primitive, so it is safe to bind
 * text to; derive the live duration as `now - firstRaisedAt` with the app's
 * shared 1 s ticker (the store deliberately stores no duration — a duration
 * is a render-time fact).
 */
export const selectUnitFirstRaisedAt =
  (unitId: string) =>
  (s: FleetState): number | undefined => {
    let first: number | undefined;
    for (const a of s.alerts) {
      if (a.unitId !== unitId) continue;
      if (first === undefined || a.ts < first) first = a.ts;
    }
    return first;
  };
