import { DECEL_SHEET, projectMomentum, rubberband } from "@/lib/motion";

/**
 * The verdict sheet's gesture, as numbers — every threshold the drag decides
 * anything with, and none of the DOM it decides it on.
 *
 * Same split, and the same reason, as machine-layout.ts beside it: the code that
 * consumes this runs inside a pointermove handler and is forbidden from
 * re-rendering, which makes it exactly the sort of code that grows a quiet
 * off-by-a-threshold bug nobody can see until a demo. So the decisions live
 * here as functions of numbers, and sheet-gesture.test.ts asserts them.
 *
 * ## What the gesture is allowed to do
 *
 * MINIMIZE, and settling back. That is the entire vocabulary, and the omission
 * is the point: RETURN TO CONSOLE archives the incident, and an incident logged
 * because a thumb slipped is a real harm in a console whose whole subject is
 * telling the truth about a machine. So the drag can put the conclusion down —
 * a view state, reversible with one tap on the chip it becomes — and the only
 * way out of machine space stays a button that says what it does.
 */

/* ---------------------------------------------------------------------------
   Thresholds
--------------------------------------------------------------------------- */

/**
 * How far a pointer must travel before this is a drag and not a tap.
 *
 * Ten pixels, the platform figure, and load-bearing here: the sheet's header
 * carries the MINIMIZE control and the body carries three acknowledgement
 * buttons, so a gesture that committed on the first pixel of movement would
 * turn every slightly-imprecise tap into a nudge of the whole surface. Below the
 * threshold nothing moves at all — not a partial follow, not a hint — because a
 * surface that twitches under a tap reads as an accident either way.
 */
export const DRAG_SLOP_PX = 10;

/**
 * A flick: past this speed the *direction* decides, and where the sheet happens
 * to be does not.
 *
 * 550 px/s is roughly a phone screen and a half per second — comfortably above
 * the speed a careful drag ends at, comfortably below what a deliberate throw
 * reaches. This rule runs before the projection below because that is the honest
 * reading of the gesture: someone who flicks the sheet downward two centimetres
 * from the top has said what they want, and answering "you did not drag far
 * enough" would be the console overruling them with a ruler.
 */
export const FLICK_VELOCITY_PX_S = 550;

/**
 * How far down the sheet's projected resting point has to be for a slow drag to
 * commit: just over a third of its own height.
 *
 * Not half. The two outcomes are not equally expensive — minimizing is one tap
 * from undone and the chip that undoes it is where the sheet just went, while
 * settling back costs a second gesture on a conclusion the operator was clearly
 * trying to put down. Asymmetric costs get an asymmetric threshold.
 */
export const COMMIT_FRACTION = 0.35;

/**
 * The ceiling on upward travel, in pixels: drag the sheet above its full height
 * and it gives about 30 px, then effectively nothing.
 *
 * Small on purpose. Above the sheet is the session header — the frame that says
 * whose scan this is — and it is not a thing the conclusion may cover, so the
 * budget is sized to read as resistance rather than as travel. See
 * {@link sheetOffset}: the resistance is asymptotic, so this is a hard ceiling
 * and not a clamp that can be hit.
 */
export const RUBBER_CEILING_PX = 48;

/**
 * Spring responses, in seconds — SwiftUI's `response`, not durations.
 *
 * `SETTLE` is what a released drag lands with. It inherits the release velocity,
 * so its real length is the gesture's: park the sheet gently and it eases the
 * last few pixels, throw it and it is gone.
 *
 * `MINIMIZE` and `RESTORE` are the un-gestured paths — the `_` control and the
 * chip. They are deliberately unequal in the same direction the descent is:
 * PRD §5 has the return ascend faster than the descent arrives, so putting the
 * conclusion down is quicker than picking it back up.
 *
 * The numbers are chosen against the PRD's 120–180 ms micro band, using 95 % of
 * travel as the point the eye stops following (a critically damped spring is
 * 95 % done at t = 4.74/ω, ω = 2π/response). On the 744 px sheet a 390×844 phone
 * actually renders, MINIMIZE reads as complete at 151 ms and RESTORE at 196 ms,
 * with the remaining pixels sub-perceptual. Anything slower puts a surface
 * nobody threw outside the band; anything faster stops reading as travel at all,
 * which is the teleport this replaced.
 */
export const SPRING_SETTLE_S = 0.34;
export const SPRING_MINIMIZE_S = 0.2;
export const SPRING_RESTORE_S = 0.26;

/**
 * Where the sheet will settle when released at rest: closer than this to the
 * target, and slower than this, and it is there. Half a pixel is below what a
 * display can show; 8 px/s is a frame of sub-pixel drift.
 */
export const SPRING_REST_DELTA_PX = 0.5;
export const SPRING_REST_SPEED_PX_S = 8;

/** A flight the sheet is about to make: from where, to where, already how fast, and how quickly. */
export interface SheetSpring {
  /** The presentation value the spring starts from, px below rest. */
  from: number;
  to: number;
  /** px/s, positive downward — the live speed at the moment of aiming. */
  velocity: number;
  /** Seconds; see {@link SPRING_SETTLE_S}. */
  response: number;
}

/**
 * A response, as framer-motion spring physics.
 *
 * `response` is SwiftUI's: the period of the undamped oscillation, so the
 * natural frequency is ω = 2π/response and the stiffness ω² (unit mass).
 * Damping is set to exactly 2ω — critical — which is the fastest return with
 * no overshoot, and the reason a sheet thrown back up lands on the header's
 * rule rather than bouncing off it. The rest thresholds are the sheet's own;
 * framer's defaults tighten for short travel, and a 3px settle is not a
 * different animation from a 700px one.
 */
export function springTransition(response: number) {
  const omega = (2 * Math.PI) / response;
  return {
    type: "spring",
    stiffness: omega * omega,
    damping: 2 * omega,
    mass: 1,
    restDelta: SPRING_REST_DELTA_PX,
    restSpeed: SPRING_REST_SPEED_PX_S,
  } as const;
}

/* ---------------------------------------------------------------------------
   Tracking
--------------------------------------------------------------------------- */

/**
 * Where the sheet sits for a given amount of finger travel, in pixels below its
 * resting position.
 *
 * Downward is 1:1 and unresisted — the surface is glued to the finger for the
 * entire journey, which is the one property that makes a drag feel like touching
 * a thing rather than operating a control. Upward is rubber-banded against a
 * small budget, so the boundary announces itself by resisting instead of by
 * freezing.
 *
 * `travel` is already the delta from where the pointer went *down*, which is how
 * the grab offset is respected: the sheet does not jump to the finger on the
 * first move, it moves by exactly as much as the finger has.
 */
export function sheetOffset(travel: number, ceiling = RUBBER_CEILING_PX): number {
  if (travel >= 0) return travel;
  return rubberband(travel, ceiling);
}

/* ---------------------------------------------------------------------------
   The decision
--------------------------------------------------------------------------- */

export type SheetRelease = "minimize" | "settle";

export interface ReleaseInput {
  /** Where the sheet is, in px below full. Negative while rubber-banded. */
  offset: number;
  /** Release velocity in px/s, positive downward. */
  velocity: number;
  /** The sheet's own height: how far it travels to be gone. */
  height: number;
}

/**
 * Minimize, or settle back — decided from where the gesture is *going*, not
 * from where it stopped.
 *
 * Velocity first, then the projected resting point, then position by itself
 * only as the degenerate case where the projection of a zero velocity is the
 * position. A sheet that snapped to whichever state was nearest at the instant
 * of release would ignore the throw entirely, which is the single most common
 * way a bottom sheet feels wrong.
 */
export function sheetRelease({ offset, velocity, height }: ReleaseInput): SheetRelease {
  if (velocity >= FLICK_VELOCITY_PX_S) return "minimize";
  if (velocity <= -FLICK_VELOCITY_PX_S) return "settle";
  const projected = offset + projectMomentum(velocity, DECEL_SHEET);
  return projected >= height * COMMIT_FRACTION ? "minimize" : "settle";
}

/**
 * The spring that carries the release: same velocity the finger had, aimed at
 * whichever state {@link sheetRelease} chose.
 *
 * Handing the velocity over is what removes the seam. Without it the sheet stops
 * dead at the release point and starts again from zero — a stutter of exactly
 * one frame, which is both invisible in a screenshot and immediately obvious
 * under a thumb.
 */
export function releaseSpring(input: ReleaseInput, decision: SheetRelease): SheetSpring {
  return {
    from: input.offset,
    to: decision === "minimize" ? input.height : 0,
    velocity: input.velocity,
    response: SPRING_SETTLE_S,
  };
}
