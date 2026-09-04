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
import { useAuditStore, type AuditEntry, OPERATOR } from "./auditStore";
import {
  getUnitBattery,
  recordTelemetryBatch,
  resetTelemetryChannel,
  restateTelemetry,
  useUnitTelemetryValue,
} from "./telemetryChannel";
import {
  resetTrendWatch,
  trendOnBatch,
  trendOnUnitsChange,
  type TrendingUnit,
} from "./trendWatch";

/**
 * Fleet store: units, alerts, connection, KPIs, and the trend watch's verdict.
 *
 * Telemetry itself never enters this store. Samples, per-unit version
 * counters and the quantized battery / last-contact primitives live in the
 * telemetry channel (telemetryChannel.ts), which notifies one unit's
 * subscribers per batch. `applyTelemetry` records the batch there and then
 * commits here ONLY if a reactive fact moved: the rounded fleet-average
 * battery, or the trending set. A quiet batch is zero zustand commits, one
 * per-unit notification — at 500 units that is the difference between one
 * canvas redraw and five thousand selector passes a second.
 */

const MAX_ALERTS = 100;

/** How an alert got resolved — the linkage the audit trail and UI cite. */
export interface AlertResolution {
  /** What closed it: the SAFE SIT command, a logged diagnostic incident, the operator's judgment, the unit's own recovery, a staged firmware rollback, or a recalibration that re-zeroed the flagged channel (the last three arrive on the wire as `alert_clear`). */
  via:
    "safe-sit" | "incident" | "operator" | "self-recovery" | "rollback" | "recalibration";
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
   * Per-unit ts of the newest sample the rings held when the world last
   * restated: the seam between runs. Absent for a unit that had reported
   * nothing yet. Replaced (never mutated) on snapshot — a snapshot is rare —
   * so a derivation that fits a rate across time can refuse to read past the
   * run that just ended (trendWatch.ts).
   */
  telemetryEpochTs: Record<string, number>;
  /**
   * The thermal trend watch's verdict, in rail order (trendWatch.ts). A
   * reactive fact: identity moves only when membership, the suspect joint or
   * a whole-number °C/min moves — a handful of times an hour, never per batch.
   */
  trending: TrendingUnit[];
  // KPIs (header): kept as primitives so subscribers stay narrow.
  kpiNominal: number;
  kpiAlerts: number;
  kpiAvgBattery: number;

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
  /** Full reset: state, ring buffers, trend watch. Tests + app teardown. */
  reset(): void;
}

/**
 * Bookkeeping behind kpiAvgBattery — running Σ and count of every counted
 * unit's effective battery (`getUnitBattery(id) ?? units[id].battery` over
 * `unitIds`), so a telemetry battery move re-derives the KPI in O(1) instead
 * of walking the fleet. Module state rather than store state: writing it
 * through `set()` would be a commit per 0.1 % move. Full recomputes
 * (snapshot, alert, unit_update) re-seed both through `computeKpis`, which
 * also bounds FP drift from the incremental adds.
 */
let kpiBatterySum = 0;
let kpiBatteryCount = 0;

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
): { kpiNominal: number; kpiAlerts: number; kpiAvgBattery: number } {
  let nominal = 0;
  let batterySum = 0;
  let batteryCount = 0;
  for (const id of unitIds) {
    const unit = units[id];
    if (!unit) continue;
    if (unit.status === "nominal") nominal += 1;
    batterySum += getUnitBattery(id) ?? unit.battery;
    batteryCount += 1;
  }
  kpiBatterySum = batterySum;
  kpiBatteryCount = batteryCount;
  // kpiAlerts counts UNITS with an active — unresolved — alert, not alert
  // events: an amber followed by a red on the same unit is one troubled unit,
  // and the header KPI sits next to "Units nominal", so it must count in the
  // same currency. The feed's own badge counts events via `alerts.length`.
  return {
    kpiNominal: nominal,
    kpiAlerts: countAlertingUnits(alerts, alertMeta),
    kpiAvgBattery: batteryCount === 0 ? 0 : Math.round(batterySum / batteryCount),
  };
}

/**
 * Content equality for one unit's wire summary — `applyUnitUpdate`'s
 * short-circuit. Field-by-field on purpose, and the `satisfies` clause is the
 * load-bearing part: it demands a comparison entry for EVERY UnitSummary
 * field, so a schema addition that forgets this list fails to typecheck
 * instead of silently treating that field's restatements as "unchanged"
 * (`fw`/`fwPending` were exactly that once — a firmware-only unit_update
 * landed only when battery happened to drift in the same restatement).
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

const EMPTY_TRENDING: TrendingUnit[] = [];

const createInitialState = () => ({
  connection: "idle" as ConnectionStatus,
  units: {},
  unitIds: [],
  alerts: [],
  alertMeta: {} as Record<string, AlertMeta>,
  telemetryEpochTs: {} as Record<string, number>,
  trending: EMPTY_TRENDING,
  kpiNominal: 0,
  kpiAlerts: 0,
  kpiAvgBattery: 0,
});

export const useFleetStore = create<FleetState>()((set, get) => ({
  ...createInitialState(),

  applySnapshot: (msg) => {
    // A snapshot restates the world (fresh connect or RESET_SIM). The channel
    // keeps its rings and marks the seam; the trend watch drops every latch
    // and fit — evidence about the run that just ended.
    const telemetryEpochTs = restateTelemetry();
    resetTrendWatch();
    set((s) => {
      const units: Record<string, UnitSummary> = {};
      const unitIds: string[] = [];
      for (const u of msg.units) {
        units[u.id] = u;
        unitIds.push(u.id);
      }
      // The alert feed clears and the server replays still-active alerts
      // right after. `alertMeta` does NOT clear — it is keyed by alert id
      // (unique across runs) and an ack must survive a reconnect's snapshot +
      // replay.
      const alerts: Alert[] = [];
      return {
        units,
        unitIds,
        alerts,
        telemetryEpochTs,
        trending: s.trending.length === 0 ? s.trending : EMPTY_TRENDING,
        ...computeKpis(units, unitIds, alerts, s.alertMeta),
      };
    });
  },

  applyTelemetry: (msg) => {
    // The batch lands in the channel — rings, version, primitives — and that
    // unit's subscribers hear about it. What follows decides whether any
    // REACTIVE fact moved; on a quiet batch nothing below commits.
    const move = recordTelemetryBatch(msg);
    const s = get();
    const next: Partial<FleetState> = {};

    if (move !== null) {
      // kpiAvgBattery in O(1): shift the running sum by this unit's move and
      // re-round. A unit's first batch replaces its snapshot battery in the
      // sum — the same fallback computeKpis uses — and units outside the
      // snapshot are recorded (the channel still answers for them) but never
      // counted, also matching computeKpis.
      const summary = s.units[msg.unitId];
      if (summary) {
        kpiBatterySum += move.next - (move.prev ?? summary.battery);
        const avg =
          kpiBatteryCount === 0 ? 0 : Math.round(kpiBatterySum / kpiBatteryCount);
        if (avg !== s.kpiAvgBattery) next.kpiAvgBattery = avg;
      }
    }

    const trending = trendOnBatch(s, msg.unitId);
    if (trending !== s.trending) next.trending = trending;

    if (next.kpiAvgBattery !== undefined || next.trending !== undefined) set(next);
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
      let trending = s.trending;
      const unit = s.units[msg.alert.unitId];
      if (unit && unit.status !== msg.alert.severity) {
        units = {
          ...s.units,
          [msg.alert.unitId]: { ...unit, status: msg.alert.severity },
        };
        // The alert owns the story now: the watch stands down for this unit.
        trending = trendOnUnitsChange(units, s.unitIds, trending);
      }
      return {
        alerts,
        units,
        trending,
        ...computeKpis(units, s.unitIds, alerts, s.alertMeta),
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
        trending: trendOnUnitsChange(units, s.unitIds, s.trending),
        ...computeKpis(units, s.unitIds, s.alerts, s.alertMeta),
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
        actor: OPERATOR,
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
    resetTelemetryChannel();
    resetTrendWatch();
    kpiBatterySum = 0;
    kpiBatteryCount = 0;
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

// ---------------------------------------------------------------------------
// per-unit telemetry hooks — the channel's values as React state

const selectSnapshotBattery =
  (unitId: string) =>
  (s: FleetState): number | undefined =>
    s.units[unitId]?.battery;

/**
 * Live battery for one unit at 0.1 % resolution, falling back to the
 * snapshot's figure until the unit's first batch of the run (0 for a unit
 * the console has never heard of). Re-renders when the rounded value moves
 * — not per batch — and only for this unit.
 */
export function useUnitBattery(unitId: string): number {
  const live = useUnitTelemetryValue(unitId, getUnitBattery, undefined);
  const snapshot = useFleetStore(selectSnapshotBattery(unitId));
  return live ?? snapshot ?? 0;
}
