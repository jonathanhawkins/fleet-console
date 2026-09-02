"use client";

import { type RingBuffer } from "@/lib/stores";
import { type Envelope, type MetricSpec } from "./joint-spec";

/**
 * Where a measure was out of band, and what to write on the axes.
 *
 * All of it is derived from the envelope in joint-spec.ts and nothing else.
 * That is deliberate and it is the reason this file is separate from the strip:
 * a threshold band drawn from one source and a tinted trace drawn from another
 * is how an instrument ends up shading a region the trace insists is fine. One
 * envelope, one ceiling, one truth — the strip's tint, the breach slabs and the
 * expanded axis all read the same three numbers.
 */

/**
 * The most breach runs a strip will draw.
 *
 * A gait cycle crosses the torque ceiling on every step, so a genuinely broken
 * knee produces a run per stride — around forty in a sixty-second window. The
 * cap exists so the scratch array below can be fixed-size; past it the strip is
 * already a solid wash of amber and the forty-ninth slab tells nobody anything.
 */
export const MAX_BREACH_RUNS = 48;

/**
 * Start/end index pairs, reused by every strip on the page.
 *
 * Same contract as the trace's sample scratch: draws are synchronous and
 * non-reentrant inside one frame callback, so eighteen strips can share one
 * 384-byte array instead of holding eighteen. Never read it outside the call
 * that filled it.
 */
const runScratch = new Int32Array(MAX_BREACH_RUNS * 2);

/**
 * Contiguous stretches of `samples[0…n)` that sit above `healthy`, written into
 * `out` as flat `[startIndex, endIndexInclusive, …]` pairs. Returns the number
 * of runs written.
 *
 * Index space, not pixel space, so the caller can map through whichever x scale
 * it is drawing with — the same run list serves the 56 px strip and the 168 px
 * expansion.
 *
 * ## `mergeGap`, and why a stride is not an event
 *
 * A knee under load crosses its torque ceiling on the peak of every step, so
 * the raw runs are forty hairlines a second apart. Drawn literally that is a
 * barcode: it reads as a rendering fault, it says nothing about *when* the
 * joint was in trouble, and the answer — "continuously, for the last twenty
 * seconds" — is the one thing an operator needed from it. Runs closer together
 * than `mergeGap` samples are therefore one region, which is the same judgment
 * the tint already makes when it holds a breach for three seconds rather than
 * flickering with the gait (telemetry-strip.tsx, BREACH_SAMPLES). The wash and
 * the tint are one rule drawn twice, so they can never disagree.
 */
export function breachRuns(
  samples: Float64Array,
  n: number,
  healthy: number,
  out: Int32Array = runScratch,
  mergeGap = 0,
): number {
  const max = out.length >> 1;
  let runs = 0;
  let start = -1;

  const close = (end: number): boolean => {
    const prevEnd = runs > 0 ? (out[runs * 2 - 1] ?? -1) : -1;
    if (runs > 0 && start - prevEnd <= mergeGap) {
      out[runs * 2 - 1] = end; // extend the region rather than opening another
      return true;
    }
    if (runs === max) return false;
    out[runs * 2] = start;
    out[runs * 2 + 1] = end;
    runs += 1;
    return true;
  };

  for (let i = 0; i < n; i += 1) {
    const over = (samples[i] ?? Number.NaN) > healthy;
    if (over && start < 0) {
      start = i;
    } else if (!over && start >= 0) {
      if (!close(i - 1)) return runs;
      start = -1;
    }
  }
  if (start >= 0) close(n - 1);
  return runs;
}

/** The shared scratch, for the strip's hot path. */
export function breachRunScratch(): Int32Array {
  return runScratch;
}

/**
 * The three numbers the expanded strip writes down its left edge.
 *
 * Floor, ceiling, and the healthy line between them — the envelope itself,
 * printed. Not a tick generator: an axis with a nicely rounded 30 / 40 / 50 on
 * it would be describing the *drawing* rather than the hardware, and the whole
 * argument for fixed domains (joint-spec.ts) is that the box means something.
 * The reference value is the one an operator is actually checking against, so
 * it is the one that gets a word next to it.
 */
export interface AxisLabel {
  value: number;
  text: string;
  /** The healthy ceiling — drawn with the reference caption beside it. */
  reference: boolean;
}

export function valueAxis(env: Envelope, spec: MetricSpec): AxisLabel[] {
  const format = (v: number) => `${v.toFixed(axisPrecision(env, spec))} ${spec.unit}`;
  return [
    { value: env.top, text: format(env.top), reference: false },
    { value: env.healthy, text: format(env.healthy), reference: true },
    { value: env.floor, text: format(env.floor), reference: false },
  ];
}

/**
 * Axis figures are coarser than the live readout by one place wherever the
 * envelope allows it: `2.40 A` as a ceiling reads as a measurement, `2.4 A`
 * reads as a limit, and a limit is what it is. Current's envelopes carry a
 * tenth, so they keep one place; temperature and torque are whole numbers.
 */
function axisPrecision(env: Envelope, spec: MetricSpec): number {
  const whole = (v: number) => Number.isInteger(v);
  if (whole(env.floor) && whole(env.healthy) && whole(env.top)) return 0;
  return Math.min(1, spec.precision);
}

/**
 * The time axis, as offsets from now.
 *
 * Three marks and no more: the window's age at the left, its midpoint, and the
 * right edge where the newest sample lands. A strip is sixty seconds wide by
 * construction, so an operator who knows that reads position directly — these
 * exist to *state* the window on the expanded canvas, not to let anyone measure
 * off it.
 */
export interface TimeLabel {
  /** Sample offset from newest, negative into the past. */
  offset: number;
  text: string;
  /** Right-most label; drawn flush to the edge rather than centred. */
  anchor: "start" | "middle" | "end";
}

export function timeAxis(capacity: number, hz = 10): TimeLabel[] {
  const span = capacity - 1;
  const seconds = Math.round(span / hz);
  return [
    { offset: -span, text: `−${seconds} s`, anchor: "start" },
    { offset: -Math.round(span / 2), text: `−${Math.round(seconds / 2)} s`, anchor: "middle" },
    { offset: 0, text: "now", anchor: "end" },
  ];
}

/**
 * The value under the cursor, or `undefined` when the cursor is off the data.
 *
 * `offset` counts back from the newest sample, which is how the whole hover
 * system addresses time (telemetry-hover.ts); the ring counts forward from the
 * oldest. This is the one place that conversion is written down.
 */
export function sampleAt(series: RingBuffer, offset: number): number | undefined {
  const i = series.length - 1 + offset;
  if (i < 0 || i >= series.length) return undefined;
  return series.at(i);
}
