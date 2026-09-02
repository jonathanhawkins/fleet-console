import { type UnitSummary } from "@/lib/schema";
import { type FleetState } from "./fleetStore";
import { type RingBuffer } from "./ringBuffer";
import {
  getUnitBuffers,
  TELEMETRY_RING_CAPACITY,
  type UnitBuffers,
} from "./telemetryChannel";

/**
 * Thermal trend watch: the predictive layer DERIVED from telemetry the channel
 * already holds — never a second copy of the wire, and never a new wire
 * message. A unit is "trending" when the least-squares slope of some joint's
 * temperature over the last WINDOW_MS exceeds the enter threshold: the console
 * noticing a climb before the robot itself complains. In the scripted
 * storyline that is the 0:15–0:28 window — the watch flags N-07 seconds
 * before its amber exists.
 *
 * Only NOMINAL units are watched. The moment a unit raises an alert, the
 * alert owns the story and the watch stands down for that unit — "trending"
 * is a forecast, and a forecast about a unit already alerting is noise. This
 * also keeps the cohort act clean: four ambers do not become four ambers
 * plus four trend flags.
 *
 * ## A reducer step, and what one batch costs
 *
 * The fleet store calls `trendOnBatch` once per admitted batch and
 * `trendOnUnitsChange` once per unit-summary commit; the result is the
 * store's `trending` field — a *reactive* fact that commits only when the
 * trending set (or a flagged slope's whole-number °C/min) actually moves.
 * Subscribers read it through `selectTrendingUnits` and re-render a handful
 * of times an hour, never per batch.
 *
 * A batch carries one unit, so a batch re-judges one unit: a map lookup and a
 * subtraction, plus at most one least-squares fit per TREND_REFIT_MS of that
 * unit's own telemetry clock. A 15 s window read through a ±3 °C/min
 * hysteresis band cannot tell 10 Hz from 1 Hz, and the second is the one
 * that leaves the thread to the 60 fps it owes. The reads are windowed
 * (`RingBuffer.copyTail`) and allocation-free: the fit touches the ~150
 * samples in the window, not the 600 in the ring, and boxes none of them.
 *
 * ## The seam between runs
 *
 * `applySnapshot` (fresh connect, reconnect, RESET_SIM) leaves the rings
 * alone, so the previous run's samples are still there — and after a reset the
 * storyline replays from the top. Two things follow, and this module owes both
 * (CLAUDE.md non-negotiable #6: the scripted incident is re-runnable): the fit
 * must not span the seam, and the hysteresis latch must not survive it, or
 * the replay is judged at the EXIT threshold while the first run was judged
 * at ENTER — a second run flagging at a lower bar than the first. The store
 * calls `resetTrendWatch` on every snapshot, and `telemetryEpochTs` marks
 * where each unit's previous run ended so the window stops there.
 *
 * Thresholds are calibrated against the sim, with room on both sides: the
 * incident ramp reads ~55 °C/min (12 °C over the 13 s onset→amber climb)
 * while nominal activity peaks fit to ~6–7 °C/min for moments at worst. The
 * EXIT threshold below ENTER is hysteresis, so a unit hovering at the line
 * cannot flicker in and out of the watch.
 */

/** Fit window: long enough to smooth gait/noise, short enough to catch a 13 s ramp. */
export const TREND_WINDOW_MS = 15_000;
/** A joint fitting steeper than this enters the watch… */
export const TREND_ENTER_C_PER_MIN = 12;
/** …and stays until it fits shallower than this (hysteresis). */
export const TREND_EXIT_C_PER_MIN = 9;
/** No verdict on thin evidence: the window must hold this many samples… */
export const TREND_MIN_SAMPLES = 100;
/** …spanning at least this much time (a burst of samples is not a trend). */
export const TREND_MIN_SPAN_MS = 10_000;
/**
 * A unit is re-fitted at most once per this much of ITS OWN telemetry clock
 * (not the wall clock, and not per batch). Over a 15 s window one extra 10 Hz
 * sample moves the slope by fractions of a °C/min, and the watch reports
 * whole °C/min through a 3 °C/min band: ten fits a second were ten identical
 * answers. The cost is up to one second of latency entering or leaving the
 * watch — invisible against a 13 s ramp.
 */
export const TREND_REFIT_MS = 1_000;

export interface TrendingUnit {
  unitId: string;
  /** The steepest climbing joint — the watch names its suspect. */
  joint: string;
  /** That joint's fitted slope, whole °C/min (display precision by design). */
  cPerMin: number;
}

/** One unit's steepest fit, before the hysteresis band is applied to it. */
interface JointFit {
  joint: string;
  cPerMin: number;
}

/**
 * Least-squares slope of y over x, in y-units per minute (x in epoch ms),
 * over the first `n` entries of each (default: all of the shorter one).
 *
 * Index-based arithmetic over anything array-like, so the hot path can hand it
 * the shared Float64Array scratch buffers directly rather than boxing a window
 * into two fresh arrays per joint per fit. Exported for tests; NaN when the
 * fit is undefined (fewer than 2 points or zero x-variance).
 */
export function slopePerMin(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  n: number = Math.min(xs.length, ys.length),
): number {
  if (n < 2) return Number.NaN;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - my);
  }
  if (sxx === 0) return Number.NaN;
  return (sxy / sxx) * 60_000; // per-ms → per-minute
}

// Scratch buffers for ring reads — module-level and reused, same zero-alloc
// discipline as the canvas strips (ringBuffer.ts `copyTail`).
const scratchTs = new Float64Array(TELEMETRY_RING_CAPACITY);
const scratchTemp = new Float64Array(TELEMETRY_RING_CAPACITY);

/**
 * How many of the ring's newest samples fall inside the fit window, measured
 * against the unit's own newest sample (not the wall clock, so a paused tab or
 * link loss cannot manufacture a slope out of stale data — the window is
 * wherever the data actually ends). `at()` is O(1), so this touches the window
 * and one sample past it, never the older four fifths of the ring.
 *
 * The walk stops at the first sample that is outside the window, at or before
 * `epochTs` (a previous run — see the module docstring), or NEWER than the
 * newest. That last guard is the one that is not about tidiness: a reconnect
 * can restate a stream at timestamps earlier than the tail already retained,
 * and an unclamped `newest - prev` is then NEGATIVE, passes a `<= WINDOW`
 * test, and walks the whole ring — fitting a 60 s cliff as a climb and
 * latching the fleet.
 */
function windowCount(ts: RingBuffer, newest: number, epochTs: number): number {
  let from = ts.length - 1;
  while (from > 0) {
    const prev = ts.at(from - 1);
    const delta = newest - prev;
    if (!(delta >= 0 && delta <= TREND_WINDOW_MS)) break;
    if (prev <= epochTs) break;
    from -= 1;
  }
  return ts.length - from;
}

/**
 * The steepest joint fit for one unit over the trailing window, or null when
 * the window holds no honest verdict.
 */
function steepestJoint(buffers: UnitBuffers, epochTs: number): JointFit | null {
  const nTs = buffers.ts.length;
  if (nTs < TREND_MIN_SAMPLES) return null;
  const newest = buffers.ts.at(nTs - 1);
  const count = windowCount(buffers.ts, newest, epochTs);
  if (count < TREND_MIN_SAMPLES) return null;
  buffers.ts.copyTail(scratchTs, count);
  if (newest - scratchTs[0]! < TREND_MIN_SPAN_MS) return null;

  fitCount += 1;
  let best: JointFit | null = null;
  for (const [joint, series] of buffers.joints) {
    // ts and each series push once per batch, so their tails align; a joint
    // that appeared mid-run is shorter and simply skipped until it has the
    // window's worth of samples to be judged on.
    if (series.tempC.length < count) continue;
    series.tempC.copyTail(scratchTemp, count);
    const fit = slopePerMin(scratchTs, scratchTemp, count);
    if (!Number.isFinite(fit)) continue;
    if (best === null || fit > best.cPerMin) best = { joint, cPerMin: fit };
  }
  return best;
}

/** One unit's memoized fit; see `fitFor`. */
interface CachedFit {
  /** The unit's newest sample ts when the fit below was computed. */
  fittedAt: number;
  fit: JointFit | null;
}

// Module state, dropped when the world restates (`resetTrendWatch`), which is
// what keeps a replayed storyline judged at ENTER like the first run.
/** Hysteresis latch: which units are currently held in the watch. */
const latched = new Set<string>();
const fits = new Map<string, CachedFit>();
/** The current verdict per trending unit; `trending` is this in roster order. */
const verdicts = new Map<string, TrendingUnit>();
let fitCount = 0;

/**
 * This unit's steepest fit, recomputed only when its own clock has advanced
 * past the refit quantum since the last one. A negative `since` is a stream
 * that restated itself earlier than the cached fit — refit, do not trust it.
 */
function fitFor(unitId: string, epochTs: number): JointFit | null {
  const buffers = getUnitBuffers(unitId);
  const newest = buffers?.ts.last();
  if (buffers === undefined || newest === undefined) return null;
  const cached = fits.get(unitId);
  if (cached !== undefined) {
    const since = newest - cached.fittedAt;
    if (since >= 0 && since < TREND_REFIT_MS) return cached.fit;
  }
  const fit = steepestJoint(buffers, epochTs);
  fits.set(unitId, { fittedAt: newest, fit });
  return fit;
}

/** The verdicts, in the rail's row order. Allocates; called only when a verdict moved. */
function assemble(unitIds: readonly string[]): TrendingUnit[] {
  const out: TrendingUnit[] = [];
  for (const unitId of unitIds) {
    const verdict = verdicts.get(unitId);
    if (verdict) out.push(verdict);
  }
  return out;
}

/**
 * Reducer step, once per admitted batch: re-judge the unit the batch carried.
 * Returns `state.trending` untouched unless this unit's verdict moved.
 */
export function trendOnBatch(
  state: Pick<FleetState, "trending" | "units" | "unitIds" | "telemetryEpochTs">,
  unitId: string,
): TrendingUnit[] {
  const unit = state.units[unitId];
  if (!unit || unit.status !== "nominal") return state.trending;

  const best = fitFor(unitId, state.telemetryEpochTs[unitId] ?? Number.NEGATIVE_INFINITY);
  const threshold = latched.has(unitId) ? TREND_EXIT_C_PER_MIN : TREND_ENTER_C_PER_MIN;
  const current = verdicts.get(unitId);
  if (best !== null && best.cPerMin >= threshold) {
    latched.add(unitId);
    const cPerMin = Math.round(best.cPerMin);
    if (current && current.joint === best.joint && current.cPerMin === cPerMin) {
      return state.trending;
    }
    verdicts.set(unitId, { unitId, joint: best.joint, cPerMin });
  } else {
    latched.delete(unitId);
    if (!current) return state.trending;
    verdicts.delete(unitId);
  }
  return assemble(state.unitIds);
}

/**
 * Reducer step, once per unit-summary commit (alert, unit_update): a unit that
 * is no longer nominal — or no longer in the roster — leaves the watch at
 * once, so its row never carries a chip and a forecast arguing about severity.
 */
export function trendOnUnitsChange(
  units: Record<string, UnitSummary>,
  unitIds: readonly string[],
  trending: TrendingUnit[],
): TrendingUnit[] {
  let changed = false;
  for (const unitId of verdicts.keys()) {
    const unit = units[unitId];
    if (unit && unit.status === "nominal") continue;
    verdicts.delete(unitId);
    latched.delete(unitId);
    changed = true;
  }
  return changed ? assemble(unitIds) : trending;
}

/** Forget latch, caches and verdicts: a snapshot restates the world, a reset empties it. */
export function resetTrendWatch(): void {
  latched.clear();
  fits.clear();
  verdicts.clear();
}

/**
 * The trending set in rail order. Identity-stable while trending truth
 * (membership, suspect joint, whole °C/min) is unchanged — safe bare.
 */
export const selectTrendingUnits = (state: FleetState): TrendingUnit[] => state.trending;

/** Test seam: as if the module were freshly loaded. */
export function resetTrendWatchForTests(): void {
  resetTrendWatch();
  fitCount = 0;
}

/**
 * Test seam: how many unit fits have actually been computed.
 *
 * The scope of the derivation is a performance CONTRACT, not an implementation
 * detail — "one unit's batch re-judges one unit, and fits it at most once a
 * second" is the difference between 0.12 and 47,000 ms of main thread per
 * wall second at 500 units — and a contract that nothing counts is one a
 * later change can quietly drop.
 */
export function trendFitsForTests(): number {
  return fitCount;
}
