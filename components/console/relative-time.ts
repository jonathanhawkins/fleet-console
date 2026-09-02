"use client";

import * as React from "react";

/**
 * Relative timestamps, and the single clock that drives all of them.
 *
 * Two rules the fleet page is held to:
 *
 * 1. One interval for a list, never one per row. A hundred rows must not mean
 *    a hundred timers; every consumer subscribes to the module-level ticker
 *    below, which runs only while something is mounted and stops when the last
 *    subscriber leaves.
 * 2. The tick is slow on purpose. These labels change once a second at most,
 *    and re-rendering an alert feed at telemetry rate to move "41s" to "42s"
 *    would be spending the frame budget on the least important pixels on the
 *    page.
 */

const TICK_MS = 1_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = (): number => (now === 0 ? (now = Date.now()) : now);

/**
 * Epoch ms, re-read once a second. `useSyncExternalStore` rather than state +
 * effect so every subscriber in a render pass reads the same instant — two
 * rows must never disagree about what "now" is.
 *
 * The server snapshot is 0: a relative label is not renderable on the server
 * (it would be stale by the time it hydrated and would mismatch), so components
 * treat 0 as "not yet" and render nothing until the client takes over.
 */
export function useNow(): number {
  return React.useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

/**
 * "just now" · "42s ago" · "6m ago" · "2h ago".
 *
 * Coarse by design: an operator reads recency as a category (fresh / stale /
 * gone), and a label that resolves to the second implies a precision the
 * 10 Hz batch cadence does not have. Returns null when there is nothing
 * truthful to say — no timestamp, or a clock that has not started.
 */
export function formatRecency(ts: number | undefined, nowMs: number): string | null {
  if (ts === undefined || !Number.isFinite(ts) || nowMs === 0) return null;
  const seconds = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** ISO string for a `<time dateTime>` attribute — the machine-readable half. */
export function isoTime(ts: number | undefined): string | undefined {
  if (ts === undefined || !Number.isFinite(ts)) return undefined;
  return new Date(ts).toISOString();
}
