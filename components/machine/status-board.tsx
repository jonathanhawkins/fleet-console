"use client";

import * as React from "react";
import { usePrefersReducedMotion } from "@/components/console";
import { buildManifest } from "./manifest-spec";
import { PartsManifest } from "./parts-manifest";
import { machineComponent, machineJoint } from "./scan-copy";
import { useDiagSession, useStackedScan } from "./scan-state";
import { UnitSilhouette } from "./unit-silhouette";
import { useWireframeModel, WireframeElevation } from "./wireframe-elevation";

/**
 * The board: the machine's own picture of itself, and the inventory beside it.
 *
 * The composition is the eva parts-status frame — a central elevation flanked
 * by numbered columns — resolved to two columns rather than three, because the
 * reference has forty-six rows to hang on both sides and this scan has fifteen.
 * Splitting fifteen rows around a figure would leave two short columns and no
 * inventory; keeping them together leaves one column that reads top to bottom
 * like the manifest it is.
 *
 * The elevation sits on the left and the manifest on the right for a reason
 * that only shows up once something breaks. This is a *front* elevation, so
 * the robot's left knee is drawn on the viewer's right — the side the manifest
 * is on — and the leader line from the damaged joint to its DAMAGED row is
 * therefore a short run across open space rather than a line dragged over the
 * drawing. The alternative reads as a diagram with a scribble through it.
 *
 * Everything here is derived from the session (manifest-spec.ts). A page
 * refreshed mid-scan reconstructs this board exactly from the prefix the host
 * replays, because there is nothing to reconstruct: it is a projection.
 *
 * ## Two elevations, one slot
 *
 * The drawing in that slot is normally the *model's* wireframe — the same GLB
 * the component viewer renders, projected here as line segments
 * (wireframe-elevation.tsx). It arrives over the network, so until it does (and
 * for good, if it never does) the slot holds the hand-drawn SVG elevation,
 * which is a finished drawing rather than a placeholder and needs no apology.
 * Both fill the identical box, so the swap costs no layout.
 *
 * ## No elevation on a phone
 *
 * Under 48rem the drawing is not shown at all, and the manifest takes the whole
 * width. The elevation's job on this board is not to be a picture of a robot —
 * the unit page has one of those, two taps away. Its job is to be the far end
 * of the magenta leader line: the object that says *this module and that row
 * are the same thing*, in a short horizontal run across open space, which is
 * the entire reason the figure sits left of the inventory. At 375px there is no
 * horizontal run to make. A leader would have to be dragged down the flank of
 * the drawing to reach a row underneath it — the scribble-through-the-diagram
 * this arrangement exists to avoid — and without it the figure is a turntable
 * spending a third of the screen, and a canvas and a per-frame draw, on the
 * device least able to lend them. The DAMAGED stamp is the statement; the row
 * it is on is the one that can actually be read.
 *
 * Not rendered rather than `display: none`, which is why this is the one
 * layout decision in machine space that reaches for a JS media query.
 */

export function StatusBoard() {
  const session = useDiagSession();
  const entries = React.useMemo(() => buildManifest(session), [session]);
  const flag = session?.flag ?? null;
  const reducedMotion = usePrefersReducedMotion();
  const stacked = useStackedScan();
  const model = useWireframeModel();
  const live = model !== null;
  /** The drawing, and with it the leader line, exist only where both fit. */
  const drawn = !stacked;

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const elevationRef = React.useRef<HTMLDivElement | null>(null);
  const markRef = React.useRef<SVGGElement | null>(null);
  const rowRef = React.useRef<HTMLDivElement | null>(null);

  /**
   * The leader line is measured, not computed, and it is written to the DOM
   * rather than to state.
   *
   * Measured, because its two ends live in different coordinate systems — one
   * is inside a drawing that scales with the panel, the other is a text row
   * whose height depends on the font that loaded — and the only thing that
   * knows where they actually are is layout. Deriving it from constants would
   * mean a line that points near the knee until someone changes a line-height.
   *
   * Written imperatively, because with the wireframe up the anchor *moves*:
   * the knee module travels across the box as the turntable turns, and the line
   * has to stay on it. Sixty state commits a second to redraw four numbers into
   * one polyline would re-render the whole board — fifteen manifest rows — for
   * a shape change React cannot help with. So the ends live in refs and the
   * frame callback pushes them straight onto the element.
   */
  const anchor = React.useRef({ x: 0, y: 0, clearX: 0, set: false });
  const local = React.useRef({ x: 0, y: 0, clearX: 0, set: false });
  const origin = React.useRef({ x: 0, y: 0, set: false });
  const end = React.useRef({ x: 0, y: 0, set: false });
  const groupRef = React.useRef<SVGGElement | null>(null);
  const polyRef = React.useRef<SVGPolylineElement | null>(null);
  const dotRef = React.useRef<SVGCircleElement | null>(null);

  const paintLeader = React.useCallback(() => {
    const a = anchor.current;
    const e = end.current;
    const group = groupRef.current;
    const poly = polyRef.current;
    const dot = dotRef.current;
    if (!a.set || !e.set || !group || !poly || !dot) return;
    const x1 = round(a.x);
    const y1 = round(a.y);
    // The elbow. It has to clear the *whole figure*, not just the module the
    // line starts on: this is a callout leaving a drawing, and a vertical run
    // laid down the robot's flank is the scribble-through-the-diagram this
    // board's whole left-right arrangement exists to avoid. `clearX` is the
    // figure's right edge at the current yaw, so the corner breathes out and
    // in as it turns; the clamp keeps a readable horizontal run at the row.
    const midX = round(Math.min(Math.max(x1 + 10, a.clearX), e.x - 8));
    poly.setAttribute("points", `${x1},${y1} ${midX},${y1} ${midX},${e.y} ${e.x},${e.y}`);
    dot.setAttribute("cx", `${x1}`);
    dot.setAttribute("cy", `${y1}`);
    group.style.visibility = "visible";
  }, []);

  /** The wireframe's per-frame report, in canvas-local px. */
  const handleAnchor = React.useCallback(
    (x: number, y: number, clearX: number) => {
      local.current.x = x;
      local.current.y = y;
      local.current.clearX = clearX;
      local.current.set = true;
      const o = origin.current;
      if (!o.set) return;
      anchor.current.x = o.x + x;
      anchor.current.y = o.y + y;
      anchor.current.clearX = o.x + clearX;
      anchor.current.set = true;
      paintLeader();
    },
    [paintLeader],
  );

  React.useEffect(() => {
    if (!flag || !drawn) {
      anchor.current.set = false;
      local.current.set = false;
      origin.current.set = false;
      end.current.set = false;
      return;
    }

    const measure = () => {
      const container = containerRef.current;
      const row = rowRef.current;
      if (!container || !row) return;

      const base = container.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.width === 0) return;
      end.current.x = r.left - base.left - 4;
      end.current.y = r.top + r.height / 2 - base.top;
      end.current.set = true;

      if (live) {
        // The canvas reports its anchor in its own box; layout supplies the
        // offset from that box to the container, and only layout changes it.
        const box = elevationRef.current;
        if (!box) return;
        const b = box.getBoundingClientRect();
        origin.current.x = b.left - base.left;
        origin.current.y = b.top - base.top;
        origin.current.set = true;
        if (!local.current.set) return; // the next frame will supply it
        anchor.current.x = origin.current.x + local.current.x;
        anchor.current.y = origin.current.y + local.current.y;
        anchor.current.clearX = origin.current.x + local.current.clearX;
      } else {
        // The SVG elevation anchors at the damage hatch's right edge, which is
        // already clear of the drawing, so the elbow only has to be far enough
        // out to read as a corner.
        const mark = markRef.current;
        if (!mark) return;
        const m = mark.getBoundingClientRect();
        if (m.width === 0) return;
        anchor.current.x = m.right - base.left;
        anchor.current.y = m.top + m.height / 2 - base.top;
        anchor.current.clearX =
          anchor.current.x + Math.max(10, (end.current.x - anchor.current.x) * 0.32);
      }
      anchor.current.set = true;
      paintLeader();
    };

    // Two passes: one now, one after the browser has settled fonts and the
    // drawing has actually mounted.
    measure();
    const raf = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [flag, live, drawn, paintLeader]);

  return (
    <div
      ref={containerRef}
      className="relative flex min-h-0 flex-1 items-stretch gap-4 overflow-auto p-3"
    >
      {/* Top-aligned with the manifest and sized to roughly its height. The
          drawing and the inventory are two views of one machine, and a figure
          floating at the centre of a tall panel while the rows it belongs to
          sit at the top reads as two unrelated objects — with the leader line
          then having to travel the whole panel to prove otherwise. */}
      {drawn ? (
        <div className="flex w-[9rem] shrink-0 flex-col items-center gap-2 self-start">
          <div ref={elevationRef} className="h-[22rem] w-full">
            {model ? (
              <WireframeElevation
                data={model}
                damagedJoint={flag?.joint ?? null}
                channels={session?.channels}
                reducedMotion={reducedMotion}
                onAnchorChange={handleAnchor}
                className="size-full"
              />
            ) : (
              <UnitSilhouette damagedJoint={flag?.joint ?? null} markRef={markRef} />
            )}
          </div>
          {/* One label, and it changes when the drawing does: the hand-drawn
              fallback really is a front elevation, and the wireframe really is
              not — it turns. Saying "FRONT" over a figure at three-quarter yaw
              would be the board's first inaccuracy. */}
          <span className="text-label text-ink-muted uppercase">
            {live ? "Live model elev." : "Front elev."}
          </span>
          {/* Same invitation the operator's component view makes ("Drag to
              turn") — the wireframe is a control now, and a control that looks
              exactly like a picture is a control nobody finds. */}
          {live ? (
            <span className="text-label text-ink-muted uppercase opacity-60">
              Drag to turn
            </span>
          ) : null}
        </div>
      ) : null}

      <PartsManifest
        entries={entries}
        damagedRowRef={rowRef}
        className="max-w-[46rem] flex-1 self-start"
      />

      {flag && drawn ? (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
          fill="none"
        >
          {/*
            The one magenta in the product.

            The PRD allows it "sparingly, per the EVA panels", and this is the
            single place it is spent: the line connecting the damaged region of
            the drawing to the row that names it. It gets to be the only object
            on screen in that hue because it is the only object on screen whose
            entire job is to say *these two things are the same thing*.

            Hidden until the first paint has real coordinates — a leader line
            briefly pinned to the panel's top-left corner is worse than no
            leader line.
          */}
          <g ref={groupRef} style={{ visibility: "hidden" }}>
            <polyline ref={polyRef} stroke="var(--signal)" strokeWidth="1" />
            <circle ref={dotRef} r="1.75" fill="var(--signal)" />
          </g>
        </svg>
      ) : null}

      {/* The board's own summary, for a reader who cannot see the chips. */}
      <p className="sr-only">
        {flag
          ? `${machineJoint(flag.joint)} ${machineComponent(flag.component)} damaged; all other checked components operating.`
          : `${entries.filter((e) => e.state === "operating").length} of ${entries.length} components checked and operating.`}
      </p>
    </div>
  );
}

/** Tenths of a pixel: enough for a hairline, short enough to keep the attribute
 *  string from churning on float noise. */
const round = (v: number): number => Math.round(v * 10) / 10;
