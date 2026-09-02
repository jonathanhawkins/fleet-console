"use client";

import * as React from "react";
import {
  JSAnimation,
  useMotionValue,
  type ValueAnimationTransition,
} from "framer-motion";
import { descentTimeline, registerFrame } from "@/components/console";
import { pushSample, trailVelocity, type PointerSample } from "@/lib/motion";
import {
  DRAG_SLOP_PX,
  releaseSpring,
  sheetOffset,
  sheetRelease,
  SPRING_MINIMIZE_S,
  SPRING_RESTORE_S,
  SPRING_SETTLE_S,
  springTransition,
  type SheetSpring,
} from "./sheet-gesture";

/**
 * The verdict, at sheet scale, with a hand on it.
 *
 * Below 64rem the conclusion is not a card in a column — there is no third
 * column to land in — so it takes the whole body of the instrument between the
 * session header and the status line. That surface can be put down two ways.
 * The `_` control has always been one. This is the other: drag it, and it goes
 * where you push it.
 *
 * ## Why the sheet is grabbable and the board's card is not
 *
 * A sheet is a thing lying over other things; a card in a column is part of a
 * layout. The gesture exists here because there is a *surface* covering evidence
 * the operator may want back, and because a thumb is already on the glass — on a
 * desk the same conclusion sits in the centre column beside its evidence,
 * covering nothing, with a pointer that has a 24px control two inches away. A
 * board panel that could be flung off the screen would be a board panel
 * pretending to be a sheet.
 *
 * ## The header is the handle, and nothing else is
 *
 * The obvious design is "drag anywhere on the sheet when it is scrolled to the
 * top". It was built, measured on a real touch stack, and removed: at
 * `scrollTop === 0` the browser has already claimed a downward touch for the
 * scroller — `touch-action` is resolved before the first pointermove is
 * delivered — so the sheet moved 0.6px where the header moved a clean 100px for
 * the same gesture. The only way to win that argument is `touch-action: none` on
 * the scroller plus a hand-rolled scroller underneath it, and hand-rolled
 * scrolling on the one surface whose job is *being read* is a bad trade at any
 * price.
 *
 * So the drag lives where a drag cannot be confused with a scroll. The header is
 * 134px tall and full width on a 390px phone — several times the size of the
 * grabber pill this instrument is not allowed to draw — and it carries MINIMIZE
 * as well, so the region a hand reaches for to put the conclusion down does both
 * things. An affordance that works every time in one place beats one that works
 * sometimes everywhere; the second kind teaches nothing.
 *
 * ## What a drag can and cannot decide
 *
 * It can MINIMIZE, and it can settle back. It cannot RETURN. Returning archives
 * the incident, and an incident logged because a thumb slipped is the one class
 * of harm this console — whose entire subject is reporting a machine honestly —
 * must not have. So the gesture's whole vocabulary is a view state that a single
 * tap on the chip it becomes will undo, and the semantic exit stays a button
 * that says what it does. (sheet-gesture.ts holds every threshold.)
 *
 * ## Where it goes when it goes
 *
 * Down, and out through the bottom edge, into the status rule where the chip is
 * already waiting. That is not decoration: the thing the sheet becomes lives at
 * the bottom of the screen, so the sheet leaves at the bottom of the screen, and
 * a restore brings it back up the same path it left by. The board it was
 * covering is revealed continuously underneath as it travels, so the operator
 * can see what they are uncovering while they are uncovering it rather than
 * after.
 *
 * ## The exit is not a point of no return
 *
 * The sheet is in the air for 151–257 ms on its way out, and for that whole
 * window it is still a surface on a screen with a thumb near it. So it stays
 * catchable and it stays re-aimable:
 *
 * - **Grabbed mid-exit**, it stops dead under the finger and the release
 *   re-decides from scratch — thrown back up to full, or let go to carry on
 *   leaving. There is nothing special about the direction it happened to be
 *   travelling in when the hand arrived.
 * - **Touched and let go mid-exit** without a drag, it resumes: the flight is
 *   paused on pointer-down and restarted from the pixel and speed it was frozen
 *   at, which is what "interruptible" has to mean for a tap that turned out not
 *   to be a gesture.
 * - **RESTORE tapped mid-exit** re-aims the flight in place. It used to be
 *   queued behind the exit — the sheet finished leaving, unmounted, remounted
 *   and sprang up from the bottom edge, so a tap 40 ms into a 200 ms exit cost
 *   most of a second and a full round trip past a screen edge for a state the
 *   operator had already changed their mind about.
 *
 * All three are the same mechanism: every spring is aimed from the presentation
 * value at the live velocity, so re-aiming one is arithmetic, not choreography.
 *
 * ## Reduced motion
 *
 * The gesture stays. `prefers-reduced-motion` is a request about motion the
 * *interface* performs; a surface tracking a finger 1:1 is motion the
 * *operator* performs — the same class of thing as scrolling, which no such
 * preference turns off, and not vestibular, because nothing on screen moves
 * that the hand did not just move. Removing the drag here left a phone with one
 * way to put the conclusion down where every other phone had two, which is the
 * shape of an accessibility fix that quietly removes a capability.
 *
 * What goes is everything the sheet does *by itself*. The release decision is
 * untouched — flick threshold, projection, commit line, all of it — but the
 * state it decides on is applied on the frame the finger lifts instead of being
 * sprung to, so there is no flight to watch. The rubber band stays for the same
 * reason the drag does: it is resistance under a hand, not an animation, and a
 * boundary that freezes rather than resists reads as a break.
 *
 * The sheet still has to arrive and leave somewhere, and it does it the way the
 * rest of this product does under the preference: a 200 ms opacity crossfade,
 * the same swap PRD §5 gives the descent, read off the reduced timeline rather
 * than typed in here. A hard cut is not the reduced version of a transition, it
 * is the absence of one — and what it loses is the only thing the transition was
 * carrying, which is that this surface and the chip in the status rule are the
 * same object.
 *
 * ## Frames
 *
 * Nothing in a drag, a settle or a crossfade touches React. Each writes one
 * composited property straight onto the sliding element — the drag from its own
 * rAF, which coalesces a burst of pointermove into the single frame that can be
 * painted, and the spring and the crossfade from the shared frame loop
 * (frame-loop.ts — the same one the six waveform canvases behind this surface
 * are drawing from), because those have to be sampled every frame whether or
 * not an event arrived. The spring is framer-motion's, aimed at a motion
 * value; what keeps it off framer's own scheduler is the driver below, which
 * hands its ticks to the shared loop. Two schedulers, one property each, zero
 * renders, on the one screen the demo is built around.
 */

/**
 * The reduced-motion swap, in milliseconds, taken from the descent's own
 * reduced timeline (PRD §5). One number for the whole product's answer to
 * "this surface has to change and you asked not to watch it travel".
 */
const RM_CROSSFADE_MS = descentTimeline(true).wipeMs;

type Driver = NonNullable<ValueAnimationTransition["driver"]>;

/**
 * The shared frame loop, as the driver framer's spring ticks from.
 *
 * A framer animation defaults to framer's own frameloop, which on this screen
 * would be a second requestAnimationFrame beside the one every canvas behind
 * the sheet draws from (CLAUDE.md non-negotiable #3). This driver subscribes
 * the animation to frame-loop.ts instead, for exactly as long as it runs.
 *
 * Its clock starts on the first frame the spring is sampled on, not at the
 * commit that aimed it — `now()` answers "not yet", and the animation dates
 * itself from the first timestamp it actually sees. A `performance.now()`
 * read at commit time and the timestamp the first frame is handed are up to a
 * frame apart in either direction, which puts a jump at t = 0 of the exact
 * kind an interruptible spring exists to remove; seeding the origin from the
 * first sampled frame makes the travel monotonic by construction. (Full
 * receipt: the note in components/fleet/incident-banner.tsx, where it was
 * measured.)
 */
const frameLoopDriver: Driver = (update) => {
  let leave: (() => void) | null = null;
  return {
    start: () => {
      leave ??= registerFrame(update);
    },
    stop: () => {
      leave?.();
      leave = null;
    },
    now: () => Number.POSITIVE_INFINITY,
  };
};

export interface VerdictSheetProps {
  /** Whether the conclusion should be up. False plays the exit, then unmounts. */
  open: boolean;
  /**
   * Put it down. Called by the `_` control and by a drag that committed — never
   * by anything that completes the ascent.
   */
  onMinimize: () => void;
  /**
   * Pick it back up. Called when a drag catches the sheet on its way out and
   * throws it back to full: that is the operator changing their mind mid-exit,
   * and the chip in the status rule has to hear about it or the console ends up
   * showing a conclusion it believes is minimized.
   */
  onRestore: () => void;
  /**
   * The sheet has finished covering the board, or finished leaving it. Drives
   * `inert` on what is underneath — see the note in descent-stage.tsx about why
   * that follows the travel and not the state.
   */
  onCoveredChange?: (covered: boolean) => void;
  /** `prefers-reduced-motion`: the drag stays, the physics goes. See above. */
  reduced: boolean;
  children: React.ReactNode;
}

/** A running spring, and what it was aimed at. */
interface Flight {
  to: number;
  response: number;
  stop: () => void;
  onSettled?: () => void;
}

/** A running reduced-motion crossfade. */
interface Fade {
  to: number;
  stop: () => void;
  onDone?: () => void;
}

export function VerdictSheet({
  open,
  onMinimize,
  onRestore,
  onCoveredChange,
  reduced,
  children,
}: VerdictSheetProps) {
  /**
   * Mounted covers open plus the exit that follows closing it. It is the only
   * React state in this component and it changes at most twice per minimize.
   */
  const [mounted, setMounted] = React.useState(open);

  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const slideRef = React.useRef<HTMLDivElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  /**
   * Pixels below rest. The presentation value — read it, never a target. A
   * motion value so the spring can be aimed at it; every write to the DOM
   * still goes through `write` below.
   */
  const offset = useMotionValue(0);
  /** 0–1, and only ever moved by the reduced-motion crossfade. */
  const opacityRef = React.useRef(1);
  /** Live speed of whatever is moving the sheet, px/s. Zero at rest. */
  const velocityRef = React.useRef(0);
  const flightRef = React.useRef<Flight | null>(null);
  const fadeRef = React.useRef<Fade | null>(null);
  /**
   * The velocity a committing flick released at, handed across the React update
   * that flips `open`. Without it a flick-to-minimize would stop dead at the
   * release point and start again from zero — one frame of stutter, invisible in
   * a screenshot and unmissable under a thumb.
   */
  const handoffRef = React.useRef<number | null>(null);
  /** The first arrival is a conclusion appearing, not a sheet returning. */
  const arrivedRef = React.useRef(false);
  /** The sheet left through the bottom and owes an entrance if it comes back. */
  const parkedRef = React.useRef(false);
  /** What the board underneath was last told. */
  const coveredRef = React.useRef(false);
  /**
   * Restart the transition a pointer-down interrupted, from wherever it was
   * frozen. Set on pointer-down, spent by a release that never became a drag,
   * dropped by one that did.
   */
  const resumeRef = React.useRef<(() => void) | null>(null);

  /**
   * The parent's callbacks and `open`, held rather than depended on. They are
   * inline values in a component that re-renders on every scan event, and a
   * gesture effect that re-subscribed on each of those would tear its own
   * listeners off mid-drag — which is exactly what used to happen to the exit.
   */
  const minimizeRef = React.useRef(onMinimize);
  const restoreRef = React.useRef(onRestore);
  const coveredCbRef = React.useRef(onCoveredChange);
  const openRef = React.useRef(open);
  React.useInsertionEffect(() => {
    minimizeRef.current = onMinimize;
    restoreRef.current = onRestore;
    coveredCbRef.current = onCoveredChange;
    openRef.current = open;
  }, [onMinimize, onRestore, onCoveredChange, open]);

  const write = React.useCallback(
    (px: number) => {
      offset.set(px);
      const el = slideRef.current;
      if (!el) return;
      el.style.transform = px === 0 ? "" : `translate3d(0, ${px}px, 0)`;
    },
    [offset],
  );

  const paint = React.useCallback((opacity: number) => {
    opacityRef.current = opacity;
    const el = slideRef.current;
    if (!el) return;
    el.style.opacity = opacity === 1 ? "" : opacity.toFixed(3);
  }, []);

  /** Whether the board underneath is covered. Deduped: the parent re-renders. */
  const setCovered = React.useCallback((covered: boolean) => {
    if (coveredRef.current === covered) return;
    coveredRef.current = covered;
    coveredCbRef.current?.(covered);
  }, []);

  /**
   * End whatever is moving the sheet, and give the layer back.
   *
   * `will-change` is a promise about the next few hundred milliseconds, not a
   * property, so it is cleared everywhere a transition ends — settled,
   * interrupted, or unmounted mid-flight — rather than only on the paths that
   * happened to be thought about.
   */
  const stopFlight = React.useCallback(() => {
    flightRef.current?.stop();
    flightRef.current = null;
    const el = slideRef.current;
    if (el && el.style.willChange === "transform") el.style.willChange = "";
  }, []);

  const stopFade = React.useCallback(() => {
    fadeRef.current?.stop();
    fadeRef.current = null;
    const el = slideRef.current;
    if (el && el.style.willChange === "opacity") el.style.willChange = "";
  }, []);

  /** The height the sheet has to clear to be gone: the box it is filling. */
  const travel = React.useCallback(
    () => wrapRef.current?.clientHeight ?? window.innerHeight,
    [],
  );

  /**
   * Start a spring from wherever the sheet is now.
   *
   * `spec.from` is always the presentation value and `spec.velocity` the live
   * one, so re-aiming mid-flight — a settle interrupted by a grab, a grab
   * released into a minimize, a RESTORE that arrived while the exit was still
   * in the air — continues from the exact pixel and the exact speed on screen.
   * Animating from the logical value instead is what produces the jump every
   * interruptible transition is trying not to have. Both are handed to framer
   * explicitly (`[from, to]` and `velocity`) rather than read back off the
   * motion value, whose own velocity estimate is a frame-difference on
   * framer's clock, not this one's.
   *
   * This is framer's value animation held directly rather than reached through
   * `animate()`: that wrapper hands `onComplete` to a promise, and a park that
   * lands a microtask after the frame that finished the exit is a frame the
   * unmount can miss — while the spring's own velocity, which every re-aim
   * above is built on, is only on the animation itself.
   */
  const fly = React.useCallback(
    (spec: SheetSpring, onSettled?: () => void) => {
      stopFlight();
      const el = slideRef.current;
      if (el) el.style.willChange = "transform";
      // Assigned once the animation exists; no frame can arrive before then.
      let velocity: (() => number) | null = null;
      const animation = new JSAnimation<number>({
        keyframes: [spec.from, spec.to],
        ...springTransition(spec.response),
        velocity: spec.velocity,
        driver: frameLoopDriver,
        motionValue: offset,
        onUpdate: (px) => {
          write(px);
          if (velocity) velocityRef.current = velocity();
        },
        onComplete: () => {
          // framer has already written `spec.to` exactly.
          velocityRef.current = 0;
          flightRef.current = null;
          const slide = slideRef.current;
          if (slide && slide.style.willChange === "transform")
            slide.style.willChange = "";
          // Landed at rest is the only moment the board is genuinely covered.
          if (spec.to === 0) setCovered(true);
          onSettled?.();
        },
      });
      // The analytic derivative of the spring at the frame it last wrote —
      // what a grab, a resume or a re-aim carries on from.
      velocity = () => animation.getGeneratorVelocity();
      flightRef.current = {
        to: spec.to,
        response: spec.response,
        stop: animation.stop,
        onSettled,
      };
    },
    [offset, setCovered, stopFlight, write],
  );

  /**
   * The reduced-motion crossfade: a linear opacity ramp on the shared loop.
   *
   * Length is proportional to the distance left to cover, which makes a
   * reversal free — catch a half-faded exit and the way back is half as long,
   * rather than 200 ms of watching an already-visible surface become visible.
   *
   * It cannot be a CSS transition: the reduced-motion clamp at the top of
   * globals.css zeroes every `transition-duration` in the document, which is
   * the correct global default and exactly wrong for the one transition that
   * exists *because* motion is reduced.
   */
  const fade = React.useCallback(
    (to: number, onDone?: () => void) => {
      stopFade();
      const from = opacityRef.current;
      const ms = RM_CROSSFADE_MS * Math.abs(to - from);
      if (ms < 1) {
        paint(to);
        onDone?.();
        return;
      }
      const el = slideRef.current;
      if (el) el.style.willChange = "opacity";
      // Seeded by the first frame, for the same reason `fly` is.
      let startedAt = -1;
      const stop = registerFrame((now) => {
        if (startedAt < 0) startedAt = now;
        const t = Math.min(1, (now - startedAt) / ms);
        paint(from + (to - from) * t);
        if (t < 1) return;
        stopFade();
        onDone?.();
      });
      fadeRef.current = { to, stop, onDone };
    },
    [paint, stopFade],
  );

  /** The far end of the exit: the sheet is gone, and owes an entrance. */
  const park = React.useCallback(() => {
    parkedRef.current = true;
    // The value only: the element is about to unmount, and a painted frame of
    // it back at rest on the way out would be a flash.
    offset.set(0);
    opacityRef.current = 1;
    velocityRef.current = 0;
    setCovered(false);
    setMounted(false);
  }, [offset, setCovered]);

  /* -- open / close ---------------------------------------------------------
     One effect owns every un-gestured transition. A committing drag routes
     through here too — it calls onMinimize() and lets the state change it
     causes start the exit — so there is exactly one place that knows how the
     sheet leaves, and the flick's velocity arrives with it. */
  React.useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    if (reduced) {
      fade(0, park);
      return;
    }
    const handoff = handoffRef.current;
    handoffRef.current = null;
    fly(
      {
        from: offset.get(),
        to: travel(),
        velocity: handoff ?? velocityRef.current,
        // A flick keeps the gesture's own spring, so the throw carries through
        // uninterrupted; the `_` control, which had no momentum behind it, gets
        // the short one and reads as a micro-transition.
        response: handoff === null ? SPRING_MINIMIZE_S : SPRING_SETTLE_S,
      },
      park,
    );
  }, [open, mounted, reduced, fade, fly, offset, park, travel]);

  /* -- the restore path -----------------------------------------------------
     Mounting while `open` and having been here before means the chip was
     tapped: come back up the way the sheet went down. The very first arrival
     is left alone — that is a conclusion appearing for the first time, and it
     has its own fade (verdict-card.tsx). */
  React.useLayoutEffect(() => {
    if (!mounted || !open) return;
    if (!arrivedRef.current) {
      arrivedRef.current = true;
      setCovered(true);
      return;
    }

    // Caught in the air. RESTORE arrived while the sheet was still leaving, so
    // the exit is re-aimed where it is — not allowed to finish, unmount, and
    // re-enter from the bottom edge for a state that never changed back.
    // Layout effect rather than passive, so not one painted frame of the sheet
    // continuing to leave after the chip said otherwise.
    const flight = flightRef.current;
    if (flight && flight.to !== 0) {
      fly({
        from: offset.get(),
        to: 0,
        velocity: velocityRef.current,
        response: SPRING_RESTORE_S,
      });
      return;
    }
    if (fadeRef.current && fadeRef.current.to === 0) {
      fade(1, () => setCovered(true));
      return;
    }
    // A flight already aimed at rest *is* the restore — a drag that settled
    // back, mid-flight, with the gesture's own spring under it. Re-aiming it
    // would throw away the velocity the finger put there.
    if (flight) return;

    // Only a sheet that actually left owes an entrance. A re-render while it is
    // already up must never re-launch it, which is why this is a latch set at
    // the far end of the exit rather than a guess from the current offset.
    if (!parkedRef.current) return;
    parkedRef.current = false;
    if (reduced) {
      write(0);
      paint(0);
      fade(1, () => setCovered(true));
      return;
    }
    const from = travel();
    write(from);
    fly({ from, to: 0, velocity: 0, response: SPRING_RESTORE_S });
  }, [mounted, open, reduced, fade, fly, offset, paint, setCovered, travel, write]);

  React.useEffect(() => {
    return () => {
      stopFlight();
      stopFade();
      setCovered(false);
    };
  }, [setCovered, stopFade, stopFlight]);

  /* -- the gesture ----------------------------------------------------------
     Gated on `mounted`, not on `open`: the exit is part of the sheet's life and
     the 151-257ms it spends in the air is time a thumb can reach it. Gated on
     nothing else — reduced motion keeps the drag and loses the physics (see the
     note at the top of the file). */
  React.useEffect(() => {
    const slide = slideRef.current;
    const scroller = scrollRef.current;
    if (!mounted || !slide || !scroller) return;

    /**
     * A drag in flight. `base` is where the sheet was when the pointer went
     * down — including mid-settle and mid-exit, which is what lets a moving
     * sheet be caught and thrown the other way — and `startY` is where the
     * finger was, so what the sheet follows is the *difference*. The sheet
     * never jumps to the finger.
     */
    let drag: {
      id: number;
      startY: number;
      base: number;
      engaged: boolean;
      trail: PointerSample[];
    } | null = null;
    let frame = 0;
    let latestY = 0;

    const commit = () => {
      if (!drag?.engaged) return;
      write(sheetOffset(drag.base + (latestY - drag.startY)));
    };

    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return;
      // The header, and only the header. See the note at the top of the file.
      if (!(e.target instanceof Element) || !e.target.closest("[data-sheet-grab]")) {
        return;
      }
      // Catching a moving sheet: freeze it where it is and take its velocity as
      // the starting point. Letting the spring keep running under the finger is
      // the "brick wall" this whole module exists to avoid.
      //
      // Freezing is not deciding, though. A touch that never becomes a drag has
      // said nothing about where the sheet was going, so what it interrupted is
      // remembered here and started again from the frozen pixel on release.
      const flight = flightRef.current;
      const fading = fadeRef.current;
      resumeRef.current = flight
        ? () =>
            fly(
              {
                from: offset.get(),
                to: flight.to,
                velocity: velocityRef.current,
                response: flight.response,
              },
              flight.onSettled,
            )
        : fading
          ? () => fade(fading.to, fading.onDone)
          : null;
      stopFlight();
      stopFade();
      drag = {
        id: e.pointerId,
        startY: e.clientY,
        base: offset.get(),
        engaged: false,
        trail: [],
      };
      latestY = e.clientY;
      pushSample(drag.trail, { t: e.timeStamp, v: e.clientY });
    };

    const onMove = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      latestY = e.clientY;
      pushSample(drag.trail, { t: e.timeStamp, v: e.clientY });

      if (!drag.engaged) {
        if (Math.abs(e.clientY - drag.startY) < DRAG_SLOP_PX) return;
        drag.engaged = true;
        // Past the threshold this is travel, so the layer is worth promoting —
        // and not one tap earlier, which promoted the whole surface every time
        // a thumb touched MINIMIZE.
        slide.style.willChange = "transform";
        // The surface is under a hand now, so it is not leaving and it is not
        // half-arrived. Whatever it was fading toward is over.
        resumeRef.current = null;
        paint(1);
        // Re-base on the frame the drag actually started, so the first ten
        // pixels of slop are not silently added to the sheet's travel.
        drag.startY = e.clientY;
        slide.setPointerCapture(e.pointerId);
        // Native scrolling and a 1:1 drag cannot both own the same finger.
        scroller.style.overflowY = "hidden";
        slide.dataset.dragging = "true";
      }

      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        commit();
      });
    };

    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (!drag || drag.id !== e.pointerId) return;
      const engaged = drag.engaged;
      const trail = drag.trail;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (engaged) {
        // Land on where the pointer actually let go, not on wherever the last
        // scheduled frame caught it — a flick releases inside the same frame as
        // its last move often enough to matter.
        latestY = e.clientY;
        pushSample(trail, { t: e.timeStamp, v: e.clientY });
        commit();
        if (slide.hasPointerCapture(e.pointerId))
          slide.releasePointerCapture(e.pointerId);
        scroller.style.overflowY = "";
        delete slide.dataset.dragging;
      }
      drag = null;
      if (!engaged) {
        // A tap, on a surface that was moving: let it carry on. (Nothing to
        // un-promote — a drag that never engaged never asked for a layer.)
        const resume = resumeRef.current;
        resumeRef.current = null;
        resume?.();
        return;
      }

      const input = {
        offset: offset.get(),
        velocity: cancelled ? 0 : trailVelocity(trail),
        height: travel(),
      };
      const decision = cancelled ? "settle" : sheetRelease(input);
      // Whether the sheet was on its way out when the hand arrived decides who
      // owns what happens next — not which way it was moving. A caught exit
      // released downward has to continue itself, because the state it would
      // hand to is the state the console is already in.
      const leaving = !openRef.current;

      if (decision === "minimize") {
        if (!leaving) {
          // Hand the velocity to the close effect rather than animating here:
          // one owner for how the sheet leaves, whatever asked it to.
          handoffRef.current = input.velocity;
          velocityRef.current = input.velocity;
          minimizeRef.current();
          return;
        }
        if (reduced) {
          fade(0, park);
          return;
        }
        fly(
          {
            from: input.offset,
            to: input.height,
            velocity: input.velocity,
            response: SPRING_SETTLE_S,
          },
          park,
        );
        return;
      }

      // Settling back from an exit is the operator taking the conclusion back.
      if (leaving) restoreRef.current();
      if (reduced) {
        // No flight: the end state, on the frame the finger lifted.
        write(0);
        velocityRef.current = 0;
        slide.style.willChange = "";
        setCovered(true);
        return;
      }
      fly(releaseSpring(input, "settle"));
    };

    const onUp = (e: PointerEvent) => finish(e, false);
    const onCancel = (e: PointerEvent) => finish(e, true);

    slide.addEventListener("pointerdown", onDown);
    slide.addEventListener("pointermove", onMove);
    slide.addEventListener("pointerup", onUp);
    slide.addEventListener("pointercancel", onCancel);
    return () => {
      slide.removeEventListener("pointerdown", onDown);
      slide.removeEventListener("pointermove", onMove);
      slide.removeEventListener("pointerup", onUp);
      slide.removeEventListener("pointercancel", onCancel);
      if (frame) cancelAnimationFrame(frame);
      scroller.style.overflowY = "";
      slide.style.willChange = "";
    };
  }, [
    mounted,
    reduced,
    fade,
    fly,
    offset,
    paint,
    park,
    setCovered,
    stopFade,
    stopFlight,
    travel,
    write,
  ]);

  if (!mounted) return null;

  return (
    <div
      ref={wrapRef}
      data-slot="verdict-sheet"
      // The clip is what lets the sheet leave through the bottom edge into the
      // status rule, and what keeps a rubber-banded pull from ever showing above
      // the session header. Both boundaries, one property.
      className="absolute inset-0 z-10 overflow-hidden"
    >
      <div
        ref={slideRef}
        data-slot="verdict-slide"
        // The surface that moves — deliberately not the scroller. An absolutely
        // positioned skirt inside a scroll container scrolls with the content;
        // here it hangs off a static box and stays put, covering the strip of
        // board that a rubber-banded pull would otherwise open at the bottom.
        className="absolute inset-0 bg-bg after:absolute after:inset-x-0 after:top-full after:h-16 after:bg-bg after:content-['']"
      >
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto overscroll-contain"
        >
          {children}
        </div>
      </div>
    </div>
  );
}
