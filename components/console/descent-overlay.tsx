"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import {
  selectDiagPhase,
  selectDiagWatching,
  useIncidentStore,
  type IncidentState,
} from "@/lib/stores";
import { DESCENT_ATTR, DESCENT_DIM_VAR, descentTimeline } from "./descent-motion";
import { usePageLock } from "./report-page-lock";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/**
 * The door into machine space.
 *
 * This component is a *gate*, not the descent. It holds three responsibilities
 * and deliberately no visuals: decide when the descent is allowed to begin,
 * drain the operator page underneath it, and mount the machine-space stage —
 * which is a `next/dynamic` boundary, so nothing canvas-heavy and no
 * framer-motion reaches the unit page's initial JS (PRD §7: "machine-space
 * bundle lazy-loads on first descent").
 *
 * **Trigger discipline.** Pressing "Run diagnostic" sends RUN_DIAGNOSTIC and
 * moves the store to `descending`; the banner shows its quiet in-progress
 * state and *nothing here happens*. The descent begins on `scanning` — which
 * only the sim's `scan_start` event can cause. No event, no descent. That is
 * the difference between a console and a screensaver: if the link is dead the
 * operator stays on an honest operator page with a banner that eventually
 * offers the action again, rather than being dropped into a diagnostic theatre
 * with no diagnostic behind it.
 *
 * **Leaving. (Amended 2026-08-24, by user direction.)** This gate used
 * to hold no Escape handler during the scan, and the stage offered no way out
 * before the verdict. The reasoning was that dismissing the overlay would hide
 * a scan rather than stop one, and that a surface which can be waved away
 * teaches the operator it was never load-bearing.
 *
 * Half of that still stands and is not up for revision: **the scan is not
 * cancellable from the UI.** There is no abort control, because the sim is
 * executing the sequence and a button claiming to stop it would be lying about
 * a machine.
 *
 * The other half was wrong, and one screen shows why: an operator who descends
 * into a twenty-five second scan is held there with no way back to the fleet —
 * eight other robots, one of which may be the reason they came — until the
 * scan chooses to finish. That is not a modal being load-bearing, it is a modal
 * being a cell. So the scan is now **leaveable**: CLOSE (and Escape) mid-scan
 * ascends without ending anything. The session goes on accumulating in the
 * incident store, the unit page shows "Diagnostic in progress" with a way back
 * in, and re-entering rebuilds the board from the store because the board was
 * never anything but a projection of it. The store's `watching` flag is what
 * carries that, and it is why `active` below is not simply the phase.
 *
 * At the verdict, CLOSE and Escape mean exactly what RETURN means — ascend and
 * log the incident — because at that point there *is* a decision on screen and
 * leaving it unrecorded would throw away the thing the operator came back with.
 */

/** Narrow: the session's identity, which is stable for the life of a scan. */
const selectSessionUnitId = (s: IncidentState): string | undefined => s.session?.unitId;

/**
 * The machine-space chunk, referenced twice by the same specifier so the
 * bundler emits one chunk: once as the lazy component, once as a warm-up.
 */
const importStage = () => import("@/components/machine/descent-stage");

const DescentStage = dynamic(() => importStage().then((m) => m.DescentStage), {
  ssr: false,
});

let warmed: Promise<unknown> | null = null;

/**
 * Pull the machine-space chunk into cache before it is needed.
 *
 * Called by the incident banner on mount: by the time a unit is troubled
 * enough to show a banner, the operator is one click from the descent, and the
 * descent is the one moment in this product that must not wait on a network
 * round trip. Idempotent, and harmless if the operator never presses anything.
 */
export function preloadMachineSpace(): void {
  warmed ??= importStage();
}

export interface DescentOverlayProps {
  /** Only this unit's session opens this overlay. */
  unitId: string;
}

export function DescentOverlay({ unitId }: DescentOverlayProps) {
  const phase = useIncidentStore(selectDiagPhase);
  const sessionUnitId = useIncidentStore(selectSessionUnitId);
  const watching = useIncidentStore(selectDiagWatching);
  const reducedMotion = usePrefersReducedMotion();
  const timeline = descentTimeline(reducedMotion);

  /**
   * Three conditions, and `watching` is the one that is about the operator
   * rather than about the scan. Without it, leaving a running scan would be
   * undone by the next render — and navigating back to a unit whose scan is
   * still going would drop the operator into machine space unasked, which is
   * the trap the close control exists to remove.
   */
  const active =
    watching && (phase === "scanning" || phase === "verdict") && sessionUnitId === unitId;

  /**
   * The stage outlives the session by one ascent: `completeAscent()` returns
   * the store to `idle` immediately, and the surface still has 250 ms of wipe
   * to play. So mounting is driven by this flag rather than by `active`, and
   * only the stage may clear it — when its exit animation has finished.
   *
   * Component state rather than the store's `exiting` snapshot, and the two are
   * not the same question. That snapshot says *what a departing
   * surface is showing*; this says *whether this page has a surface on it*, and
   * carries the clock the wipe is scheduled against. Driving the mount off a
   * store field would put a departed scan back on screen for an operator who
   * navigated away mid-exit and came back — the strand a store can have and a
   * component cannot, since this dies with the page. What the gate owes the
   * store in exchange is the collection below.
   */
  const [stageAt, setStageAt] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (active) setStageAt((at) => at ?? performance.now());
  }, [active]);

  const mounted = stageAt !== null;

  /**
   * The store's departing snapshot cannot outlive this gate.
   *
   * `dismissExit` normally arrives from the stage's own "away" completion,
   * below. An operator who navigates during those 250 ms takes the whole
   * subtree down before that animation can finish, and nothing would ever clear
   * the snapshot — the failure mode a per-component ref could not have, and the
   * price of modelling the fact once.
   *
   * Both edges, because a departing surface can only exist *inside* a mounted
   * gate: one that is arriving is as much a guarantee that nothing is mid-exit
   * as one that is leaving. Today every writer of the snapshot is reached from
   * inside the surface itself — RETURN and CLOSE on the verdict card, the
   * header's ABORT, this file's Escape handler — so the arriving edge is
   * belt-and-braces; it is here so that a future caller from *outside* machine
   * space (a transport-driven abort, say) cannot leave a snapshot standing that
   * no surface will ever collect. Unconditional and idempotent: with nothing
   * departing it is a no-op, so it costs nothing on an ordinary mount.
   */
  React.useEffect(() => {
    const dismiss = () => useIncidentStore.getState().dismissExit();
    dismiss();
    return dismiss;
  }, []);

  /**
   * Beat 1, and the reason it is an attribute rather than a component: what
   * has to desaturate is the whole operator page — header, eighteen live
   * telemetry canvases, footer — and none of it should re-render, or even
   * know, because a diagnostic opened above it. One write on `<html>`; the
   * `[data-descent]` rules in app/globals.css do the rest, on the compositor.
   *
   * Runs off `mounted`, which flips the moment the scan allows the stage up —
   * before the machine chunk has necessarily resolved — so the page starts
   * draining the instant `scan_start` lands.
   *
   * A layout effect, and the cleanup is why. A passive cleanup runs a
   * scheduler beat *after* the commit that removes the surface, and that beat
   * is a real state: the operator page still dimmed and scroll-locked with
   * nothing over it. Under a contended test suite that state was observed
   * directly — overlay gone from the DOM, attribute still standing (twice in
   * 112 loaded runs). Releasing in the layout phase makes both edges atomic
   * with their commit: the drain lands before the surface's first paint, and
   * the page is whole again in the same commit that takes the surface down.
   */
  React.useLayoutEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;

    root.style.setProperty(DESCENT_DIM_VAR, `${timeline.dimMs}ms`);
    root.setAttribute(DESCENT_ATTR, "under");

    return () => {
      root.style.setProperty(DESCENT_DIM_VAR, `${timeline.ascentRestoreMs}ms`);
      root.removeAttribute(DESCENT_ATTR);
    };
  }, [mounted, timeline.dimMs, timeline.ascentRestoreMs]);

  /**
   * Beat 1's other half: the page held still under a full-viewport surface,
   * without letting the reclaimed scrollbar shift the (still visible, still
   * dimming) page sideways.
   *
   * Counted, and shared with the two report gates (report-page-lock.ts). This
   * overlay used to keep its own copy, and the unit page mounts it beside the
   * incident report's gate — a scan adopted off the wire while a report is open
   * measured a gutter of zero and then handed the page back under the document
   * still covering it. Same layout-phase timing as the attribute above, which
   * is the point: both edges stay atomic with their commit.
   */
  usePageLock(mounted);

  if (!mounted) return null;

  return createPortal(
    <DescentStage
      unitId={unitId}
      startedAt={stageAt}
      active={active}
      // The exit has played out: the surface comes down and the store stops
      // holding the session it was carrying. One callback, because they are one
      // event — a snapshot outliving the surface that reads it is exactly the
      // strand the effect above exists to catch.
      onDismissed={() => {
        setStageAt(null);
        useIncidentStore.getState().dismissExit();
      }}
    />,
    document.body,
  );
}
