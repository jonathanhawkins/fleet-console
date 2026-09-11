"use client";

import * as React from "react";
import { registerFrame, usePrefersReducedMotion } from "@/components/console";
import { criticalSpring, springSettled } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  clampColumn,
  EDGE_AREA,
  EDGE_VAR,
  isLegalColumn,
  MACHINE_LAYOUT_KEY,
  maxColumnPx,
  minColumnPx,
  parseStoredLayout,
  SCAN_EDGES,
  serializeLayout,
  type ClampContext,
  type ScanEdge,
  type ScanLayout,
} from "./machine-layout";

/**
 * The three scan columns, and the two dividers between them made draggable.
 *
 * ## The dividers were already there
 *
 * `.scan-grid` has always drawn its rules the cheap way: a 1px gap with the
 * line colour showing through from the grid's own background. That is still how
 * they are drawn. The handles are transparent 8px strips parked on top of the
 * gaps, and the only thing they paint is the phosphor rule that replaces the
 * dim one while the pointer is on them. Nothing about the resting board changed
 * to make it resizable, which is the whole point: an instrument that grows
 * grab-bars is an instrument that has stopped looking like an instrument. There
 * are no dots, no chevrons, no shaded gutters — the affordance is the cursor
 * and the line lighting up, and both cost nothing when nobody is reaching.
 *
 * ## Why none of this is React state
 *
 * A pointermove-driven `setState` would re-render six waveform canvases, a
 * virtualized log and the parts manifest on every frame of a drag, on the one
 * screen the demo is built around. So the drag writes two CSS custom properties
 * on the grid element and stops. The tracks are `minmax(0, var(--scan-log))`,
 * the handles are positioned off the same two variables, and `aria-valuenow` is
 * an attribute write — so a full drag is: one rAF, two style writes, zero
 * React renders, zero store commits. The canvases resize because they are each
 * under a ResizeObserver that re-reads devicePixelRatio and forces a redraw
 * (waveform-deck.tsx), which is the correct owner of that problem and was
 * already there.
 *
 * ## Three columns start at 1024px
 *
 * The floors (18 + 24 + 20 rem) are 62 rem, which is what they are *for*: they
 * seat exactly at 64 rem with the two gaps. So the three-column board — the
 * shape this whole surface is designed as — now begins at 1024 px rather than
 * 1280 px, and the handles are live wherever it is. Below that the layout is
 * stacked, the variables are not read by any rule, and the handles are
 * `display: none`, so they are out of the tab order without a JS gate.
 */

const NUDGE_PX = 8;
const NUDGE_FAST_PX = 32;

/**
 * The reset's spring, in seconds of natural period.
 *
 * A double-click used to hand the column back to the stylesheet in one frame,
 * which is correct in every way except that the operator could not see it
 * happen: a 90px column change with no travel between the two widths reads as a
 * repaint, and the eye has nothing to follow from where the divider was to where
 * it went. At this response the divider is 95 % of the way home in 166 ms —
 * inside the PRD's micro band — and it is critically damped, because a
 * diagnostic board's dividers do not spring past their marks.
 */
const RESET_RESPONSE_S = 0.22;

const OTHER: Record<ScanEdge, ScanEdge> = { log: "sweep", sweep: "log" };

const EDGE_LABEL: Record<ScanEdge, string> = {
  log: "Subsystem walk column width",
  sweep: "Channel sweep column width",
};

export interface ScanColumnsProps {
  className?: string;
  /**
   * Take the whole board out of the tab order and out of hit-testing. Set while
   * the phone's verdict sheet is over it: the panels are still mounted (that is
   * what makes MINIMIZE instant) but they are behind an opaque surface, and a
   * keyboard that can tab into a log nobody can see has learned the sheet was
   * drawn rather than built.
   */
  inert?: boolean;
  children: React.ReactNode;
}

export function ScanColumns({ className, inert, children }: ScanColumnsProps) {
  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const handles = React.useRef<Record<ScanEdge, HTMLDivElement | null>>({
    log: null,
    sweep: null,
  });

  /**
   * Held in a ref rather than depended on, because the effect below owns
   * listeners, a ResizeObserver and a restored layout: re-running it because a
   * media query flipped would tear all of that down to change one branch that
   * is only read inside a double-click handler.
   */
  const reduced = usePrefersReducedMotion();
  const reducedRef = React.useRef(reduced);
  React.useInsertionEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);

  // Layout effect, not effect: a stored layout has to be on the element before
  // the browser paints, or every reload of a customised board flashes the
  // default one first. This subtree only ever mounts from a click, so there is
  // no server render to warn about.
  React.useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const context = (): ClampContext => ({
      total: grid.getBoundingClientRect().width,
      rem: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
    });

    /** What the column is *actually* rendering at, which is the only truth. */
    const widthOf = (edge: ScanEdge): number =>
      grid
        .querySelector<HTMLElement>(`[data-area="${EDGE_AREA[edge]}"]`)
        ?.getBoundingClientRect().width ?? 0;

    /** The inline override, or null where the stylesheet is still in charge. */
    const overrideOf = (edge: ScanEdge): number | null => {
      const raw = grid.style.getPropertyValue(EDGE_VAR[edge]);
      const px = parseFloat(raw);
      return raw && Number.isFinite(px) ? px : null;
    };

    /**
     * What a gesture already knows, so that a frame does not have to ask again.
     *
     * `apply` writes a custom property and then describes the result to a
     * screen reader, and describing it used to mean three `getBoundingClientRect`
     * reads — after the write, in the same frame, which is a forced synchronous
     * layout of the whole board sixty times a second for as long as a divider is
     * moving. Nothing in those reads is news mid-gesture: the grid is not
     * resizing, the other column is not moving, and the width being reported is
     * the number just written. A drag measures once, at pointerdown, and hands
     * it down. Whoever has nothing to hand down still measures, which is the
     * right cost for the once-per-gesture cases (a restore, a settle, a
     * viewport change).
     */
    const syncAria = (
      edge: ScanEdge,
      known?: { ctx: ClampContext; other: number; now: number },
    ) => {
      const handle = handles.current[edge];
      if (!handle) return;
      const ctx = known?.ctx ?? context();
      const other = known?.other ?? widthOf(OTHER[edge]);
      const min = Math.round(minColumnPx(edge, ctx));
      const max = Math.round(Math.max(min, maxColumnPx(edge, other, ctx)));
      const now = Math.round(known?.now ?? widthOf(edge));
      handle.setAttribute("aria-valuemin", String(min));
      handle.setAttribute("aria-valuemax", String(max));
      handle.setAttribute("aria-valuenow", String(now));
      // Pixels are what the operator is moving, but "312" read aloud is not a
      // width. The text says the unit once so the number means something.
      handle.setAttribute("aria-valuetext", `${now} pixels`);
    };

    const apply = (
      edge: ScanEdge,
      px: number,
      known?: { ctx: ClampContext; other: number },
    ) => {
      grid.style.setProperty(EDGE_VAR[edge], `${px}px`);
      syncAria(edge, known && { ...known, now: px });
    };

    const persist = () => {
      const layout: ScanLayout = { log: overrideOf("log"), sweep: overrideOf("sweep") };
      try {
        localStorage.setItem(MACHINE_LAYOUT_KEY, serializeLayout(layout));
      } catch {
        // Private mode, a full quota, a locked-down kiosk. The board is fully
        // usable without persistence; losing it is not worth a thrown drag.
      }
    };

    // --- restore, and keep honest across viewport changes --------------------

    let restored = false;

    const restore = () => {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(MACHINE_LAYOUT_KEY);
      } catch {
        return;
      }
      const stored = parseStoredLayout(raw);
      for (const edge of SCAN_EDGES) {
        const px = stored[edge];
        // Legal *here*: a width saved on a wide display is well-formed and
        // still wrong on a laptop, and the right answer to a layout that does
        // not fit is the designed one, not a squeezed version of someone's
        // Tuesday.
        if (px !== null && isLegalColumn(edge, px, widthOf(OTHER[edge]), context())) {
          grid.style.setProperty(EDGE_VAR[edge], `${px}px`);
        }
      }
    };

    /**
     * Bring any override back inside the stops for the width we now have.
     *
     * Live resizing clamps rather than discards, which is the opposite of what
     * `restore` does and deliberately so: dragging a window narrow and back is
     * one gesture, and a layout that evaporated in the middle of it would read
     * as a bug. A stored layout, by contrast, has no gesture around it.
     */
    const reclamp = () => {
      for (const edge of SCAN_EDGES) {
        const px = overrideOf(edge);
        if (px === null) continue;
        const next = clampColumn(edge, px, widthOf(OTHER[edge]), context());
        if (next !== Math.round(px)) grid.style.setProperty(EDGE_VAR[edge], `${next}px`);
      }
    };

    // Resizing is only a concept where the columns are side by side. The
    // stylesheet owns that threshold; this reads it back rather than restating
    // it, so the two cannot drift apart.
    const threeUp = () =>
      getComputedStyle(grid).gridTemplateAreas.includes("log board waves");

    const sync = () => {
      if (!threeUp()) return;
      if (!restored) {
        restored = true;
        restore();
      }
      reclamp();
      for (const edge of SCAN_EDGES) syncAria(edge);
    };

    sync();

    // The grid is full-width, so its own box changes only with the viewport —
    // and the properties written here resize the *tracks*, never the grid. No
    // feedback loop, and no need to observe the panels.
    const observer = new ResizeObserver(sync);
    observer.observe(grid);

    // --- the reset, animated -------------------------------------------------

    /** Cancel handles for a reset in flight, one per edge. */
    const resets: Partial<Record<ScanEdge, () => void>> = {};

    const cancelReset = (edge: ScanEdge) => {
      resets[edge]?.();
      delete resets[edge];
    };

    /**
     * Walk a column from where it is to the width the stylesheet would give it,
     * then hand the property back.
     *
     * The destination is *measured*, not remembered: the property is removed for
     * one synchronous read so the cascade can answer with today's designed width,
     * then written straight back before the browser has a chance to paint. That
     * keeps the original decision intact — a reset means "whatever the design
     * says now", not "the number that was in the stylesheet the day you
     * double-clicked" — while still giving the animation a target to travel to.
     *
     * Under `prefers-reduced-motion` the travel is the part that goes: the
     * property is already removed by the time the decision is made, so the
     * reduced path is the one-frame reset this gesture used to be, reached by
     * doing nothing further. The global clamp in globals.css cannot help here —
     * this is a JS spring writing a custom property, and CSS has no opinion
     * about it — which is exactly why the branch has to be explicit.
     */
    const animateReset = (edge: ScanEdge) => {
      cancelReset(edge);
      const from = widthOf(edge);
      const override = grid.style.getPropertyValue(EDGE_VAR[edge]);
      grid.style.removeProperty(EDGE_VAR[edge]);
      const to = widthOf(edge);
      if (!override || Math.abs(to - from) < 1 || reducedRef.current) {
        syncAria(edge);
        persist();
        return;
      }
      grid.style.setProperty(EDGE_VAR[edge], `${from}px`);

      // Same bargain the drag makes: neither the grid nor the far column moves
      // while this one springs home, so the travel reads them once.
      const ctx = context();
      const other = widthOf(OTHER[edge]);

      const spec = { from, to, velocity: 0, response: RESET_RESPONSE_S };
      // The spring's clock is the frame loop's, not the wall clock's: the
      // `performance.now()` of this handler and the timestamp the first rAF
      // callback is handed are up to a frame apart in either direction, which
      // puts a jump on frame one of a travel whose entire purpose is to be
      // followed. Seeded from the first frame instead, t starts at exactly zero
      // and the column cannot leave before it starts. (Measured, with numbers,
      // in the note in components/fleet/incident-banner.tsx.)
      let startedAt = -1;
      const stop = registerFrame((now) => {
        if (startedAt < 0) startedAt = now;
        const sample = criticalSpring(spec, (now - startedAt) / 1000);
        if (springSettled(sample, to)) {
          cancelReset(edge);
          // The stylesheet takes the column back. This is the whole point of
          // the gesture and it happens at the *end* of the travel, so a later
          // change to the designed width still reaches operators who once
          // double-clicked instead of being outvoted by a frozen number.
          grid.style.removeProperty(EDGE_VAR[edge]);
          syncAria(edge);
          persist();
          return;
        }
        apply(edge, Math.round(sample.value), { ctx, other });
      });
      resets[edge] = stop;
    };

    // --- pointer -------------------------------------------------------------

    const cleanups: Array<() => void> = [
      () => observer.disconnect(),
      () => {
        for (const edge of SCAN_EDGES) cancelReset(edge);
      },
    ];

    for (const edge of SCAN_EDGES) {
      const handle = handles.current[edge];
      if (!handle) continue;

      const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // A hand on the divider outranks a reset that is still travelling: the
        // drag starts from the width on screen this frame, not from wherever
        // the spring was heading.
        cancelReset(edge);
        handle.setPointerCapture(e.pointerId);
        handle.dataset.dragging = "true";

        const ctx = context();
        const other = widthOf(OTHER[edge]);
        const startX = e.clientX;
        const startPx = widthOf(edge);
        let frame = 0;
        let latestX = startX;
        let moved = false;

        const commit = () => {
          // The sweep column grows as its divider travels left, so its delta is
          // the pointer's, mirrored.
          const travel = latestX - startX;
          const delta = edge === "log" ? travel : -travel;
          apply(edge, clampColumn(edge, startPx + delta, other, ctx), { ctx, other });
        };

        const onMove = (ev: PointerEvent) => {
          moved = true;
          latestX = ev.clientX;
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            commit();
          });
        };

        const onUp = (ev: PointerEvent) => {
          if (frame) cancelAnimationFrame(frame);
          frame = 0;
          // Land on where the pointer actually let go, not on wherever the last
          // frame happened to catch it. Without this a flick — release inside
          // the same frame as the last move — cancels a scheduled rAF that had
          // not run yet, and the whole gesture is silently thrown away.
          if (moved) {
            latestX = ev.clientX;
            commit();
          }
          handle.releasePointerCapture(ev.pointerId);
          delete handle.dataset.dragging;
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          // A press that never moved is not a resize, and must not overwrite a
          // stored layout with the widths that were already on screen.
          if (moved) persist();
        };

        // Capture retargets the moves to the handle, so the drag survives the
        // pointer crossing a canvas, leaving the window, or outrunning a frame.
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      };

      const onKeyDown = (e: KeyboardEvent) => {
        const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        if (dir === 0) return;
        e.preventDefault();
        // Same rule as the pointer: an arrow key is the operator taking the
        // divider back off a reset that is still on its way home.
        cancelReset(edge);
        // The separator moves the way the arrow points; which column that grows
        // depends on which side of it the column is.
        const step = (e.shiftKey ? NUDGE_FAST_PX : NUDGE_PX) * dir;
        const delta = edge === "log" ? step : -step;
        apply(
          edge,
          clampColumn(edge, widthOf(edge) + delta, widthOf(OTHER[edge]), context()),
        );
        persist();
      };

      const onDoubleClick = () => animateReset(edge);

      handle.addEventListener("pointerdown", onPointerDown);
      handle.addEventListener("keydown", onKeyDown);
      handle.addEventListener("dblclick", onDoubleClick);
      cleanups.push(() => {
        handle.removeEventListener("pointerdown", onPointerDown);
        handle.removeEventListener("keydown", onKeyDown);
        handle.removeEventListener("dblclick", onDoubleClick);
      });
    }

    return () => {
      for (const off of cleanups) off();
    };
  }, []);

  return (
    <div ref={gridRef} inert={inert} className={cn("scan-grid", className)}>
      {children}
      {SCAN_EDGES.map((edge) => (
        <div
          key={edge}
          ref={(el) => {
            handles.current[edge] = el;
          }}
          data-slot="scan-handle"
          data-edge={edge}
          className="scan-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={EDGE_LABEL[edge]}
          tabIndex={0}
        />
      ))}
    </div>
  );
}
