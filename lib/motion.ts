/**
 * Fluid-interface physics: what happens after the finger lets go.
 *
 * Four functions, no React, no DOM, no framer-motion — so every gesture surface
 * in the app decides "where does this land, and how does it get there" from the
 * same arithmetic, and that arithmetic can be asserted in a test instead of
 * eyeballed at 60 fps.
 *
 * ## Why springs rather than durations
 *
 * A scripted `duration` animation cannot answer the only question that matters
 * mid-gesture: *what is on screen right now, and how fast is it moving?* Grab a
 * 300 ms tween 100 ms in and the honest options are to jump or to wait. A spring
 * has neither problem — it is defined by a position and a velocity, so it can be
 * re-aimed from wherever it currently is at whatever speed it currently has, and
 * the seam between "the finger was moving it" and "physics is moving it" simply
 * does not exist.
 *
 * This does not make the descent a spring. PRD §5 gives the product exactly one
 * orchestrated moment with fixed, designed timings, and it stays scripted
 * because nobody is holding it. Springs are for the things a hand is on.
 *
 * ## Why every spring here is critically damped
 *
 * `damping = 1.0`, everywhere, with no parameter to say otherwise. Overshoot is
 * how a surface says "you threw me" — it is only honest when the user's own
 * momentum preceded it, and the two momentum gestures this app has (the verdict
 * sheet, the column dividers) are both in machine space. An EVA diagnostic
 * console does not bounce; a readout that sprang past its mark and came back
 * would be the instrument editorialising. So the spring is the critically damped
 * closed form, which is exact at any timestep, drift-free, and cheaper than an
 * integrator: no substepping, no accumulated error, identical results whether
 * the frame took 4 ms or 40.
 */

/* ---------------------------------------------------------------------------
   Momentum projection
--------------------------------------------------------------------------- */

/**
 * Deceleration rates, per millisecond of coast.
 *
 * These are the `d` in `v(t) = v₀ · d^t_ms` — the exponential decay every
 * scroll view on every platform uses, and the model Apple's own projection
 * function assumes (*Designing Fluid Interfaces*, WWDC18). Not the
 * physics-textbook `v²/2a`: constant deceleration overshoots badly at speed and
 * feels like ice.
 *
 * `SCROLL` (0.998) is UIScrollView's: a flick coasts for the better part of a
 * second and travels half its velocity in pixels. That is right for a list you
 * are throwing and wrong for a decision you are making — at 0.998 a gentle
 * 400 px/s nudge on the verdict sheet projects 200 px, which is most of a phone
 * screen, and the sheet would dismiss itself on gestures that did not mean it.
 *
 * `SHEET` (0.995, so a flick carries ~⅕ of its velocity in pixels) is the rate
 * this app ships on the sheet: firm enough that a deliberate flick clearly
 * commits, damped enough that a lazy drag near the threshold does not.
 *
 * `ORBIT` (0.992) is faster still, because the turntable is not being thrown to
 * a destination — it is being handed back to its own slow yaw, and a spin that
 * took two seconds to give up would be a turntable arguing.
 */
export const DECEL_SCROLL = 0.998;
export const DECEL_SHEET = 0.995;
export const DECEL_ORBIT = 0.992;

/**
 * Where a flick would come to rest, in the units of `velocity` per second.
 *
 * Apple's exact projection function. The integral of `v₀·d^t` to infinity, with
 * the 1/1000 converting the per-second velocity a pointer reports into the
 * per-millisecond base the decay is written in.
 *
 * Use it to pick the *target*, then hand the same release velocity to the spring
 * that travels there (see {@link criticalSpring}). Choosing the target from the
 * release point instead — "which snap point is nearest my finger" — is what
 * makes a sheet feel like it ignored the throw.
 */
export function projectMomentum(velocity: number, decelerationRate = DECEL_SHEET): number {
  return (velocity / 1000) * (decelerationRate / (1 - decelerationRate));
}

/* ---------------------------------------------------------------------------
   Rubber-banding
--------------------------------------------------------------------------- */

/** UIScrollView's resistance constant, and the only one that feels right. */
export const RUBBER_CONSTANT = 0.55;

/**
 * How far a surface actually moves when dragged `overshoot` past its stop.
 *
 * Progressive resistance, asymptotic to `dimension`. The finger is met at
 * `constant` of its speed from the very first pixel — 55 %, which is why an iOS
 * bounce feels weighted rather than loose — and the ratio falls away from there,
 * so the surface can never travel further than `dimension` no matter how hard it
 * is pulled. A hard stop at the boundary reads as *frozen*, and the operator's
 * next thought is "did it break"; resistance reads as "you have reached the end
 * of it", which is the true statement.
 *
 * Note that `dimension` is the *travel ceiling*, not the size of the element.
 * UIScrollView passes the view's own height because a scroll view may legitimately
 * bounce a long way; a sheet that is already at its full height has somewhere it
 * must not go (over the session header that frames it), so it passes a small
 * budget instead and the ceiling does the clipping for free.
 */
export function rubberband(
  overshoot: number,
  dimension: number,
  constant = RUBBER_CONSTANT,
): number {
  if (overshoot === 0 || dimension <= 0) return 0;
  const magnitude = Math.abs(overshoot);
  const resisted = (magnitude * dimension * constant) / (dimension + constant * magnitude);
  return Math.sign(overshoot) * resisted;
}

/* ---------------------------------------------------------------------------
   The spring
--------------------------------------------------------------------------- */

export interface SpringSample {
  value: number;
  velocity: number;
}

export interface SpringSpec {
  /** Where it is now — the *presentation* value, never the logical one. */
  from: number;
  /** Where it is going. */
  to: number;
  /** How fast it is already moving, in units per second. Sign matters. */
  velocity: number;
  /**
   * The spring's natural period in seconds — SwiftUI's `response`, not a
   * duration. A critically damped spring has no duration; it approaches its
   * target forever and we stop drawing when the difference stops mattering.
   * Smaller is snappier: ω = 2π/response.
   */
  response: number;
}

/**
 * A critically damped spring, sampled at time `t` seconds after release.
 *
 * The closed form of ẍ = -ω²x - 2ωẋ at ζ=1:
 *
 *   x(t) = target + (A + Bt)·e^(-ωt),  A = from - target,  B = v₀ + ωA
 *   ẋ(t) = (B - ω(A + Bt))·e^(-ωt)
 *
 * Exact, so the result depends on elapsed time and never on how many frames it
 * took to get there — a dropped frame produces a correct sample rather than an
 * accumulated error, which is the difference between a settle that looks the
 * same on a fast laptop and a busy phone.
 *
 * Interrupting is just calling this again with a new spec built from the last
 * sample's `value` and `velocity`: the surface continues from exactly where it
 * is, at exactly the speed it had, toward somewhere else. That is the whole
 * mechanism behind "grab it mid-flight and it does not jump".
 */
export function criticalSpring(spec: SpringSpec, t: number): SpringSample {
  const omega = (2 * Math.PI) / spec.response;
  const a = spec.from - spec.to;
  const b = spec.velocity + omega * a;
  const decay = Math.exp(-omega * t);
  return {
    value: spec.to + (a + b * t) * decay,
    velocity: (b - omega * (a + b * t)) * decay,
  };
}

/**
 * Close enough to stop drawing: inside half a device pixel of the target, and
 * slow enough that it would take an eighth of a second to cross another one.
 *
 * Both halves are needed. Position alone stops a fast spring the instant it
 * crosses its target, mid-flight; velocity alone keeps a settled surface on the
 * frame loop forever, because an exponential never actually arrives.
 *
 * The two thresholds are deliberately not the same number. A critically damped
 * spring's tail is sub-pixel in position long before it is sub-pixel per second
 * in speed, so matching them would hold a visibly-finished surface on the frame
 * loop for another 200 ms of frames that change nothing.
 */
export function springSettled(
  sample: SpringSample,
  to: number,
  posEpsilon = 0.5,
  velEpsilon = 8,
): boolean {
  return (
    Math.abs(sample.value - to) < posEpsilon && Math.abs(sample.velocity) < velEpsilon
  );
}

/* ---------------------------------------------------------------------------
   Velocity blending
--------------------------------------------------------------------------- */

/**
 * A velocity decaying from `from` toward `to` — the same exponential the
 * projection above integrates, exposed as the value rather than the distance.
 *
 * The turntable uses it and needs both of its endings from one formula. Release
 * it with the pointer still over the model and `to` is 0, so the spin coasts to
 * a stop under the cursor that stopped it. Release it with a finger, which
 * leaves the element, and `to` is the ambient 4.6°/s, so the throw decays *into*
 * the idle rotation instead of cutting to it. A hard cut from 300°/s to 4.6°/s
 * is a brick wall, and a brick wall is the thing this whole module exists to
 * avoid.
 */
export function blendVelocity(
  from: number,
  to: number,
  elapsedMs: number,
  decelerationRate = DECEL_ORBIT,
): number {
  return to + (from - to) * Math.pow(decelerationRate, elapsedMs);
}

/* ---------------------------------------------------------------------------
   Pointer velocity
--------------------------------------------------------------------------- */

/** One sampled pointer position. Milliseconds and pixels, as the event gives them. */
export interface PointerSample {
  t: number;
  v: number;
}

/**
 * Velocity in units per second from a short trail of samples, measured over the
 * most recent `windowMs` and nothing older.
 *
 * The last two events are not enough: pointer deltas are quantised and a 4 ms
 * gap between two identical coordinates reports either zero or something absurd,
 * so a flick that ends on a duplicate frame registers as a release from a
 * standstill. A window is also what makes a *stop* legible — hold still for
 * 60 ms at the end of a long drag and every sample in the window is the same
 * point, which is a true zero and exactly what should happen: park a sheet
 * carefully and it stays parked rather than continuing because of how it got
 * there.
 */
export function trailVelocity(trail: readonly PointerSample[], windowMs = 60): number {
  const last = trail[trail.length - 1];
  if (!last || trail.length < 2) return 0;
  let first = trail[0]!;
  for (let i = trail.length - 1; i >= 0; i--) {
    first = trail[i]!;
    if (last.t - first.t >= windowMs) break;
  }
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return ((last.v - first.v) / dt) * 1000;
}

/**
 * Append a sample and drop everything older than the window twice over — enough
 * history for {@link trailVelocity} to have a full window, bounded so a slow
 * two-second drag does not accumulate a thousand objects.
 */
export function pushSample(
  trail: PointerSample[],
  sample: PointerSample,
  windowMs = 60,
): void {
  trail.push(sample);
  const cutoff = sample.t - windowMs * 2;
  let drop = 0;
  while (drop < trail.length - 2 && trail[drop]!.t < cutoff) drop++;
  if (drop > 0) trail.splice(0, drop);
}
