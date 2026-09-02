/**
 * The descent's clock, as data.
 *
 * PRD §5 gives the transition three beats and one rule: the operator page
 * desaturates and dims (200 ms), a black surface wipes bottom-to-top (350 ms,
 * custom ease), mono type "boots" with staggered line reveals; the return
 * ascends in reverse, faster. This module is those numbers and nothing else —
 * no React, no framer-motion, no DOM — so the choreography can be read in one
 * place, asserted in a test, and consumed identically by the overlay gate
 * (which lives in the always-loaded console layer) and by the machine-space
 * stage (which does not).
 *
 * Keeping it here rather than inside the lazy chunk is deliberate: the gate
 * starts beat 1 the instant `scan_start` lands, before the machine bundle has
 * necessarily resolved, and it cannot import the numbers from a module it is
 * trying not to pull into the unit page's initial JS.
 */

/**
 * The wipe's ease: steep start, soft landing.
 *
 * A surface rising over a page is a physical event — it should leave with
 * conviction and settle rather than arrive at constant speed. A symmetric
 * ease-in-out starts *slowly*; that is right for a panel that has to
 * acknowledge being pushed, and wrong for one that is meant to feel like it
 * was released. At these control points the wipe covers roughly three quarters
 * of the viewport in the first 30 % of its 350 ms and spends the rest easing
 * into the top edge, which is what reads as weight.
 *
 * A four-number tuple because that is framer-motion's cubic-bezier form — and
 * framer-motion is the only thing that ever drives the wipe, so this tuple is
 * the single source of truth for the curve. There is deliberately no CSS twin
 * to keep in step.
 */
export const EASE_WIPE: [number, number, number, number] = [0.2, 0.72, 0.22, 1];

/** Milliseconds. Every beat is an offset from the moment `scan_start` lands. */
export interface DescentTimeline {
  /** Beat 1: the operator page drains and dims under the overlay. */
  dimMs: number;
  /** Beat 2: the black surface wipes bottom-to-top. Starts when the dim ends. */
  wipeAtMs: number;
  wipeMs: number;
  /**
   * Beat 2, after it lands: the leading edge stops leading and becomes the
   * board's top frame line, dimming to a hairline over this long.
   *
   * Slower than anything else in the descent on purpose — it is the one beat
   * nobody is meant to watch. A rule that snapped from full phosphor to 34 %
   * would read as a second event after the wipe; at this length the eye has
   * already moved on to the chrome booting underneath it.
   */
  edgeDimMs: number;
  /** Beat 3: machine chrome reveals, staggered. Starts when the wipe lands. */
  bootAtMs: number;
  /** Gap between consecutive boot reveals. */
  bootStaggerMs: number;
  /** Each boot element's own reveal. */
  bootMs: number;
  /**
   * Ascent: the board leaves, all at once, ahead of the surface.
   *
   * Leaving is not a reverse boot. The instrument goes in one beat so that the
   * wipe carries black rather than a half-erased board, which means this has to
   * be comfortably shorter than {@link ascentWipeMs} in either timeline — and
   * it is the same number in both, because it is already an opacity fade and an
   * opacity fade is what the reduced timeline would have asked for.
   */
  boardExitMs: number;
  /** Ascent: the surface wipes back down. */
  ascentWipeMs: number;
  /** Ascent: the operator page returns to full colour once the surface is gone. */
  ascentRestoreMs: number;
  /** True when the whole thing is a crossfade instead (prefers-reduced-motion). */
  reduced: boolean;
}

/**
 * Full choreography. Eight boot elements at a 45 ms stagger plus a 240 ms
 * reveal puts beat 3 at ~555 ms, so the descent runs 550 + 555 ≈ 1.1 s from
 * `scan_start` to a settled board — long enough to register as a passage, and
 * bounded by the fact that the first walk line is already streaming behind it.
 */
const FULL: DescentTimeline = {
  dimMs: 200,
  wipeAtMs: 200,
  wipeMs: 350,
  edgeDimMs: 450,
  bootAtMs: 550,
  bootStaggerMs: 45,
  bootMs: 240,
  boardExitMs: 120,
  ascentWipeMs: 250,
  ascentRestoreMs: 150,
  reduced: false,
};

/**
 * `prefers-reduced-motion`: one 200 ms crossfade, zero translation, zero
 * stagger (PRD §5). Not a shortened version of the full timeline — a different
 * one. Every offset collapses to zero so nothing waits on a beat that no
 * longer exists, and the surface arrives by opacity alone.
 *
 * Two beats do not collapse, for opposite reasons. `edgeDimMs` is 0 because
 * there is no leading edge here to dim: the surface fades rather than climbing,
 * so what would have become the frame line is simply drawn as the frame line
 * (`.descent-edge--static`). `boardExitMs` keeps its 120 ms because it was
 * never travel — the board leaves by opacity in both timelines, and it still
 * has to be gone before the surface is.
 */
const REDUCED: DescentTimeline = {
  dimMs: 200,
  wipeAtMs: 0,
  wipeMs: 200,
  edgeDimMs: 0,
  bootAtMs: 0,
  bootStaggerMs: 0,
  bootMs: 200,
  boardExitMs: 120,
  ascentWipeMs: 200,
  ascentRestoreMs: 150,
  reduced: true,
};

export function descentTimeline(reducedMotion: boolean): DescentTimeline {
  return reducedMotion ? REDUCED : FULL;
}

/** Total time from `scan_start` to a fully booted board. Diagnostics and tests. */
export function descentDurationMs(t: DescentTimeline, bootElements: number): number {
  return t.bootAtMs + Math.max(0, bootElements - 1) * t.bootStaggerMs + t.bootMs;
}

/** framer-motion speaks seconds; the rest of this codebase speaks milliseconds. */
export const secs = (ms: number): number => ms / 1000;

/**
 * The attribute the overlay writes on `<html>` to drain the operator page, and
 * the custom property that times it in both directions.
 *
 * The dim is CSS rather than an animated React subtree because the thing being
 * desaturated is the entire page the operator was just reading — header,
 * telemetry canvases, footer. One attribute write greys all of it without
 * re-rendering a single component, and the page never learns that a descent
 * exists. See the `[data-descent]` block in app/globals.css.
 */
export const DESCENT_ATTR = "data-descent";
export const DESCENT_DIM_VAR = "--descent-dim-ms";
