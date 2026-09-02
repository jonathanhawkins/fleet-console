/**
 * How far a live trace has drifted from the calibration table it is supposed
 * to match, and what that drift means.
 *
 * The two thresholds are not invented here. They are the contract the
 * simulator is already tested against (sim/diagnostics.test.ts): every healthy
 * channel comes in under 0.05 RMS of its reference, and the failing knee comes
 * in over 0.12. Putting them in one module — rather than once in the strip
 * that tints a trace, once in the board that flips a chip, and once in the log
 * that prints a number — is what stops the three from ever disagreeing about
 * whether the same channel is healthy.
 *
 * Pure and array-based on purpose: no canvas, no React, no store. The strip
 * calls it once per channel and caches the result; nothing here runs per frame.
 */

/** Under this, a channel hugs its reference. */
export const RMS_HEALTHY = 0.05;
/** Over this, a channel is failing rather than merely noisy. */
export const RMS_FAILING = 0.12;

/** Machine-space status slots: --nominal, --warn, --alert. */
export type ChannelTone = "nominal" | "warn" | "alert";

export function channelTone(rms: number): ChannelTone {
  if (rms > RMS_FAILING) return "alert";
  if (rms > RMS_HEALTHY) return "warn";
  return "nominal";
}

/**
 * Root-mean-square difference over `[from, to)`.
 *
 * The same measure the sim's own test suite uses to assert the storyline, so
 * the number the console prints in the log is the number the contract is
 * written in. Bounds are clamped rather than trusted: a windowed call near the
 * start of a sweep asks for samples that do not exist yet.
 */
export function rmsDelta(
  wave: readonly number[],
  ref: readonly number[],
  from = 0,
  to = wave.length,
): number {
  const lo = Math.max(0, Math.min(from, wave.length));
  const hi = Math.max(lo, Math.min(to, wave.length, ref.length));
  const n = hi - lo;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = lo; i < hi; i += 1) {
    const d = (wave[i] ?? 0) - (ref[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}

/**
 * Peak amplitude ratio — "1.6x reference". The reading a technician actually
 * wants from a gain fault, and the one the verdict's headline is about.
 */
export function gainRatio(wave: readonly number[], ref: readonly number[]): number {
  let w = 0;
  let r = 0;
  for (let i = 0; i < ref.length; i += 1) {
    w = Math.max(w, Math.abs(wave[i] ?? 0));
    r = Math.max(r, Math.abs(ref[i] ?? 0));
  }
  return r === 0 ? 1 : w / r;
}

/**
 * Sliding window over which a sample's *local* divergence is judged.
 *
 * Roughly a sixth of a 120-sample channel — long enough that the measure is
 * about the envelope rather than about one noisy point, short enough that it
 * tracks a gain that is still ramping. Cumulative RMS was the obvious
 * alternative and it is worse for exactly the reason it sounds better: it
 * averages the whole history, so a fault that grows across the window paints
 * the last sample with the innocence of the first.
 */
export const TONE_WINDOW = 20;

/** Root-mean-square of a series over `[from, to)`. */
function rms(series: readonly number[], from: number, to: number): number {
  const n = to - from;
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = from; i < to; i += 1) {
    const v = series[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** Below this the reference carries no energy to measure a fault against. */
const REF_ENERGY_FLOOR = 1e-3;

/**
 * Per-sample tone for a whole channel, written into a caller-owned buffer.
 *
 * This is what lets one trace change colour along its length — phosphor where
 * it still tracks, amber where it has left the healthy band, alert red where
 * it has gone. The knee's fault ramps from 1.35x to 1.8x gain across the
 * window, so the trace itself shows the failure *developing* rather than
 * announcing a verdict with a flat colour. A non-engineer reads the gradient
 * as "this got worse", which is precisely what happened.
 *
 * Writes into `out` rather than returning an array: computed once per channel
 * on arrival, but the buffers belong to the strip, and a canvas instrument in
 * this codebase does not allocate.
 *
 * ## Why the local measure is normalised
 *
 * The obvious implementation — take the plain RMS deviation over a window and
 * compare it to the two thresholds — produces a trace that flickers. A gain
 * fault's deviation is proportional to the reference *at that point*, so a
 * window sitting on the quiet part of a gait cycle measures a smaller error
 * than the identical fault measured on a peak. On the scripted knee that put
 * the reading either side of 0.12 four times in the first twenty samples, and
 * a trace that changes tone with the waveform's own rhythm reads as noise —
 * the exact opposite of the thing it is meant to show.
 *
 * So the local deviation is divided by the local reference energy, which is
 * what makes it a measure of the *fault* rather than of where in the stride we
 * happen to be looking, and then restated on the channel's own energy scale so
 * it can still be compared against the same two thresholds everything else
 * uses. For a pure gain fault this reduces exactly to (gain − 1) × reference
 * energy: monotonic while the gain ramps, and phase-independent.
 */
export function writeSampleTones(
  wave: readonly number[],
  ref: readonly number[],
  out: Uint8Array,
  window = TONE_WINDOW,
): void {
  const n = Math.min(wave.length, ref.length, out.length);
  const half = Math.floor(window / 2);
  const channelEnergy = rms(ref, 0, n);

  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    const localDelta = rmsDelta(wave, ref, lo, hi);
    const localEnergy = rms(ref, lo, hi);
    // A window with no reference energy in it has nothing to be relatively
    // wrong against; fall back to the absolute reading rather than dividing.
    const severity =
      localEnergy > REF_ENERGY_FLOOR
        ? (localDelta / localEnergy) * channelEnergy
        : localDelta;
    out[i] = severity > RMS_FAILING ? 2 : severity > RMS_HEALTHY ? 1 : 0;
  }
}

/** Buffer index → tone name, the strip's palette lookup. */
export const TONE_BY_INDEX: readonly ChannelTone[] = ["nominal", "warn", "alert"];
