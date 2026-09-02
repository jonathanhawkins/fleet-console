"use client";

import { type AlertSeverity, type UnitStatus } from "@/lib/schema";
import { useFleetStore } from "@/lib/stores";

/**
 * What each unit has been doing since the console opened.
 *
 * The fleet store holds the present tense: a unit *is* amber. The unit page
 * needs the past tense — how long it was nominal, when it turned, whether this
 * is the first time today — and nothing on the wire carries that, because the
 * sim streams state, not journal entries. So the console keeps its own,
 * starting from the moment it connected.
 *
 * "Session" is meant literally: this is client-lifetime memory, cleared by a
 * reload, and the timeline says so by labelling its left edge with when the
 * session began rather than pretending to know what happened before. A real
 * fleet console would read this from a history service; the shape of what it
 * would render is the same either way.
 *
 * The recorder is started once by `TelemetryProvider`, not by the unit page,
 * so a status change the operator watched happen on the fleet map is already
 * recorded when they drill in.
 */

export interface StatusSpan {
  status: UnitStatus;
  /** Epoch ms. */
  from: number;
  /** Epoch ms, or null while this is the span the unit is still in. */
  to: number | null;
}

export interface StatusMark {
  /** The alert's own id — dedupes replayed alerts after a reconnect. */
  id: string;
  ts: number;
  severity: AlertSeverity;
}

/**
 * The beats only this console can know about.
 *
 * Everything an operator or a machine *did* — alerts acked, commands issued,
 * diagnostics run, verdicts returned — belongs to the audit slice in
 * `lib/stores/auditStore.ts`, which is the single source for it and is where
 * the timeline reads it from (session-events.ts). What is left here is the one
 * thing no store can answer, because it is not a fact about the fleet: whether
 * *this browser* was listening. A dropped link is a hole in the telemetry an
 * operator is about to read a strange trace out of, so it is worth a tick, and
 * nothing in `lib/stores` has any business knowing about it.
 */
export type SessionBeatKind = "link-lost" | "link-restored";

export interface SessionBeat {
  /** Stable across replays; dedupes a beat restated by a reconnect. */
  id: string;
  ts: number;
  kind: SessionBeatKind;
}

export interface UnitStatusHistory {
  /** When this console first heard from the unit. The timeline's left edge. */
  startedAt: number;
  /** Contiguous, oldest first; the last one is open (`to === null`). */
  spans: StatusSpan[];
  /** Alerts raised, oldest first. */
  marks: StatusMark[];
  /** Link events, oldest first. */
  beats: SessionBeat[];
}

/** A demo runs for minutes, not days; these caps are a safety net, not a policy. */
const MAX_SPANS = 64;
const MAX_MARKS = 64;
const MAX_BEATS = 64;

/**
 * How long the console gets to work out what it is looking at.
 *
 * A client that connects mid-incident is handed a snapshot and then, in the
 * same breath, a replay of the run's active alerts (lib/stores/README.md) —
 * so the unit summary goes nominal → amber → red inside about forty
 * milliseconds. Those are not transitions this console watched; they are it
 * catching up. Recording them as spans drew two invisible slivers at the left
 * edge of the band and, once the timeline grew ticks, put "Attention" and
 * "Alert" on top of each other at t=0 claiming the operator had been there.
 *
 * Inside this window a status change therefore *replaces* what the opening span
 * says rather than closing it, which is the same rule the alert marks have
 * always followed ("dropped rather than pinned to the left edge") applied to
 * the state's own record. One second because that is the finest the timeline
 * resolves anyway — everything on it is labelled by the app's one-second clock.
 */
const SESSION_SETTLE_MS = 1_000;

const histories = new Map<string, UnitStatusHistory>();
const seenAlerts = new Set<string>();
const seenBeats = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Journal a beat. Idempotent on `id`, so a restated fact is not a second tick. */
function beat(unitId: string, id: string, kind: SessionBeatKind, at: number): boolean {
  const history = histories.get(unitId);
  if (!history) return false;
  const key = `${unitId}:${id}`;
  if (seenBeats.has(key)) return false;
  seenBeats.add(key);
  history.beats.push({ id, ts: at, kind });
  if (history.beats.length > MAX_BEATS) history.beats.shift();
  return true;
}

function record(unitId: string, status: UnitStatus, at: number): void {
  const history = histories.get(unitId);
  if (!history) {
    histories.set(unitId, {
      startedAt: at,
      spans: [{ status, from: at, to: null }],
      marks: [],
      beats: [],
    });
    return;
  }
  const open = history.spans[history.spans.length - 1];
  if (open && open.status === status) return;
  // Still settling: this is the snapshot's alert replay landing, not a change.
  if (open && history.spans.length === 1 && at - history.startedAt <= SESSION_SETTLE_MS) {
    open.status = status;
    return;
  }
  if (open) open.to = at;
  history.spans.push({ status, from: at, to: null });
  if (history.spans.length > MAX_SPANS) history.spans.shift();
}

/**
 * Watch the fleet store for transitions. Returns a stop function.
 *
 * The store has no selector-scoped subscribe middleware, so this listener runs
 * on every commit — eighty times a second with eight units reporting. It is
 * written to cost nothing in that case: two reference comparisons and an early
 * return, because `applyTelemetry` never replaces `units` or `alerts`.
 */
export function startStatusRecorder(): () => void {
  const seed = useFleetStore.getState();
  let lastUnits = seed.units;
  let lastAlerts = seed.alerts;
  let lastConnection = seed.connection;
  const at = Date.now();
  for (const id of seed.unitIds) {
    const unit = seed.units[id];
    if (unit) record(id, unit.status, at);
  }

  const stopFleet = useFleetStore.subscribe((state) => {
    const unitsChanged = state.units !== lastUnits;
    const alertsChanged = state.alerts !== lastAlerts;
    const linkChanged = state.connection !== lastConnection;
    if (!unitsChanged && !alertsChanged && !linkChanged) return;
    const wasConnection = lastConnection;
    lastUnits = state.units;
    lastAlerts = state.alerts;
    lastConnection = state.connection;

    const now = Date.now();
    let changed = false;

    // A dropped link is a hole in every unit's telemetry, so it is journalled
    // against every unit rather than kept as one fleet-wide fact the unit page
    // would have to go looking for. Only the round trip is recorded: `idle` →
    // `connecting` → `open` on first load is the session starting, which the
    // timeline's left edge already says.
    if (linkChanged) {
      const dropped = state.connection === "reconnecting" || state.connection === "closed";
      const restored = state.connection === "open" && wasConnection === "reconnecting";
      if (dropped || restored) {
        const kind: SessionBeatKind = restored ? "link-restored" : "link-lost";
        const id = `${kind}-${now}`;
        for (const unitId of state.unitIds) {
          if (beat(unitId, id, kind, now)) changed = true;
        }
      }
    }

    if (alertsChanged) {
      // The feed is newest-first and replays on reconnect; walk it oldest-first
      // and skip ids already journalled.
      for (let i = state.alerts.length - 1; i >= 0; i -= 1) {
        const alert = state.alerts[i];
        if (!alert || seenAlerts.has(alert.id)) continue;
        const history = histories.get(alert.unitId);
        // No history yet means the snapshot has not landed; leave the alert
        // unseen so it is journalled once the unit exists.
        if (!history) continue;
        seenAlerts.add(alert.id);
        history.marks.push({ id: alert.id, ts: alert.ts, severity: alert.severity });
        if (history.marks.length > MAX_MARKS) history.marks.shift();
        changed = true;
      }
    }

    if (unitsChanged) {
      for (const id of state.unitIds) {
        const unit = state.units[id];
        if (!unit) continue;
        const before = histories.get(id)?.spans.at(-1)?.status;
        record(id, unit.status, now);
        if (histories.get(id)?.spans.at(-1)?.status !== before) changed = true;
      }
    }

    if (changed) bump();
  });

  return stopFleet;
}

/** Non-reactive read; pair it with {@link subscribeStatusHistory}. */
export function getUnitStatusHistory(unitId: string): UnitStatusHistory | undefined {
  return histories.get(unitId);
}

export function subscribeStatusHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic; the `useSyncExternalStore` snapshot for every timeline on screen. */
export function statusHistoryVersion(): number {
  return version;
}

/** Tests and teardown. */
export function resetStatusHistory(): void {
  histories.clear();
  seenAlerts.clear();
  seenBeats.clear();
  bump();
}
