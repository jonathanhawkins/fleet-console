import * as React from "react";
import { type TelemetryMessage } from "@/lib/schema";
import { RingBuffer } from "./ringBuffer";

/**
 * The telemetry channel: everything a 10 Hz batch writes, kept OUTSIDE zustand.
 *
 * Samples live in ring buffers the canvas layer reads inside its rAF loop. The
 * per-unit version counter and the two quantized primitives — battery at 0.1 %,
 * last contact at 1 s — live beside them, under the same discipline: a batch
 * for one unit notifies that unit's subscribers and nobody else. zustand never
 * learns a batch happened, so a fleet page's selectors are not re-run once per
 * batch (5,000 times a second at 500 units); the store commits only when a
 * *reactive* fact moves (status, alerts, a snapshot, a KPI, the trend watch).
 *
 * React reads the channel through `useSyncExternalStore` hooks keyed by unit
 * id. Version counters drive canvas redraws, never text; text binds to the
 * quantized primitives or the app's shared 1 s ticker.
 */

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

/** The quantized battery moved: `prev` is undefined on the unit's first batch of a run. */
export interface BatteryMove {
  prev: number | undefined;
  next: number;
}

type Listener = () => void;

interface UnitChannel {
  buffers: UnitBuffers;
  /** +1 per admitted batch. */
  version: number;
  /** Latest battery at 0.1 % resolution; undefined until the first batch of a run. */
  battery: number | undefined;
  /** Newest batch ts floored to the second; undefined until the first batch of a run. */
  lastContactAt: number | undefined;
}

const units = new Map<string, UnitChannel>();
// Listeners are kept apart from the data so that subscribing never creates a
// unit: `getUnitBuffers` stays undefined until a batch has actually arrived.
const listeners = new Map<string, Set<Listener>>();
let batchCount = 0;

const round1 = (v: number) => Math.round(v * 10) / 10;

function ensureUnit(unitId: string): UnitChannel {
  let unit = units.get(unitId);
  if (!unit) {
    unit = {
      buffers: {
        ts: new RingBuffer(TELEMETRY_RING_CAPACITY),
        battery: new RingBuffer(TELEMETRY_RING_CAPACITY),
        joints: new Map(),
      },
      version: 0,
      battery: undefined,
      lastContactAt: undefined,
    };
    units.set(unitId, unit);
  }
  return unit;
}

function ensureJointSeries(buffers: UnitBuffers, joint: string): JointSeries {
  let series = buffers.joints.get(joint);
  if (!series) {
    series = {
      tempC: new RingBuffer(TELEMETRY_RING_CAPACITY),
      torqueNm: new RingBuffer(TELEMETRY_RING_CAPACITY),
      currentA: new RingBuffer(TELEMETRY_RING_CAPACITY),
    };
    buffers.joints.set(joint, series);
  }
  return series;
}

function notify(unitId: string): void {
  const set = listeners.get(unitId);
  if (!set) return;
  for (const listener of set) listener();
}

function notifyAll(): void {
  for (const set of listeners.values()) {
    for (const listener of set) listener();
  }
}

// ---------------------------------------------------------------------------
// reads

/**
 * Read access for the canvas layer. Rings mutate in place — read them inside
 * the rAF loop (or after a version change), never store snapshots of them.
 */
export function getUnitBuffers(unitId: string): UnitBuffers | undefined {
  return units.get(unitId)?.buffers;
}

/** Bumps once per batch for this unit — chart hosts redraw on this, nothing else. */
export function getUnitTelemetryVersion(unitId: string): number {
  return units.get(unitId)?.version ?? 0;
}

/** Live battery at 0.1 % resolution, or undefined until the unit's first batch of the run. */
export function getUnitBattery(unitId: string): number | undefined {
  return units.get(unitId)?.battery;
}

/** Epoch ms of the newest batch, quantized to 1 s; undefined until the first batch of the run. */
export function getUnitLastContact(unitId: string): number | undefined {
  return units.get(unitId)?.lastContactAt;
}

/** Admitted batches since reset, any unit. Non-reactive: receipts and tests. */
export function telemetryBatchCount(): number {
  return batchCount;
}

// ---------------------------------------------------------------------------
// subscriptions

/**
 * Called synchronously once per batch for `unitId`, and once when the world
 * restates (snapshot, reset). Every read above is `Object.is`-stable between
 * calls, so a `useSyncExternalStore` over it renders only when its value moved.
 */
export function subscribeUnitTelemetry(unitId: string, listener: Listener): () => void {
  let set = listeners.get(unitId);
  if (!set) {
    set = new Set();
    listeners.set(unitId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(unitId);
  };
}

/** One unit's channel value, as React state — the shape every hook below is. */
export function useUnitTelemetryValue<T>(
  unitId: string,
  read: (unitId: string) => T,
  serverValue: T,
): T {
  const subscribe = React.useCallback(
    (listener: Listener) => subscribeUnitTelemetry(unitId, listener),
    [unitId],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => read(unitId),
    () => serverValue,
  );
}

/** Re-renders once per batch for this unit. Canvas hosts only — never bind text to it. */
export function useUnitTelemetryVersion(unitId: string): number {
  return useUnitTelemetryValue(unitId, getUnitTelemetryVersion, 0);
}

/**
 * Re-renders at most once per second per unit (the value only moves on a
 * second boundary). Pair with the app's shared 1 s ticker for the "ago" half.
 */
export function useUnitLastContact(unitId: string): number | undefined {
  return useUnitTelemetryValue(unitId, getUnitLastContact, undefined);
}

// ---------------------------------------------------------------------------
// writes — the fleet store's reducers only

/**
 * One batch: rings, version, primitives, then exactly one notification to the
 * unit's subscribers. Returns the quantized battery move so the store can shift
 * its running fleet average in O(1); null when the 0.1 % figure did not move.
 * Ordering is enforced upstream (the transport's gate); this trusts its input.
 */
export function recordTelemetryBatch(msg: TelemetryMessage): BatteryMove | null {
  const unit = ensureUnit(msg.unitId);
  const { buffers } = unit;
  buffers.ts.push(msg.ts);
  const battery = msg.batch[0]?.battery;
  if (battery !== undefined) buffers.battery.push(battery);
  for (const p of msg.batch) {
    const series = ensureJointSeries(buffers, p.joint);
    series.tempC.push(p.tempC);
    series.torqueNm.push(p.torqueNm);
    series.currentA.push(p.currentA);
  }

  unit.version += 1;
  batchCount += 1;

  let move: BatteryMove | null = null;
  if (battery !== undefined) {
    const rounded = round1(battery);
    if (unit.battery !== rounded) {
      move = { prev: unit.battery, next: rounded };
      unit.battery = rounded;
    }
  }
  const contactAt = Math.floor(msg.ts / 1000) * 1000;
  if (unit.lastContactAt !== contactAt) unit.lastContactAt = contactAt;

  notify(msg.unitId);
  return move;
}

/**
 * The world restated (fresh connect, reconnect, RESET_SIM). The rings and the
 * version counters survive — the charts keep drawing a continuous 60 s and
 * the canvases must not think nothing changed — while the primitives clear so
 * the snapshot's own battery is the truth until telemetry speaks again.
 *
 * Returns the seam: each unit's newest retained ts, so a derivation that fits
 * a rate across time can refuse to read past the run that just ended.
 */
export function restateTelemetry(): Record<string, number> {
  const epochs: Record<string, number> = {};
  for (const [unitId, unit] of units) {
    const newest = unit.buffers.ts.last();
    if (newest !== undefined) epochs[unitId] = newest;
    unit.battery = undefined;
    unit.lastContactAt = undefined;
  }
  notifyAll();
  return epochs;
}

/** Full reset: rings, counters and primitives. Tests and app teardown. */
export function resetTelemetryChannel(): void {
  units.clear();
  batchCount = 0;
  notifyAll();
}
