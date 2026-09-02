"use client";

import * as React from "react";
import { TELEMETRY_RING_CAPACITY, type TelemetryMetric } from "@/lib/stores";
import { cn } from "@/lib/utils";
import {
  envelope,
  isDescentOccluded,
  jointLabel,
  METRIC_SPEC,
  registerFrame,
  SectionLabel,
  stripScales,
} from "@/components/console";
import { mirrorJoint } from "../part-selection";
import { EMPTY_AXES, planAxes, plotHeightFor } from "./strip-axes";
import { drawStrip, type StripSubject } from "./strip-draw";
import { CompareToggle, ExpandCaret } from "./strip-expanded";
import { FALLBACK_PALETTE, readPalette, type StripRuntime } from "./strip-runtime";
import { READOUT, StripValue } from "./strip-value";

/**
 * The canvas host. Everything here is arranged so that a 10 Hz batch costs
 * React nothing (PRD §7): the host renders once, on mount; samples are read
 * out of the telemetry channel's rings by the shared rAF loop (frame-loop.ts)
 * into module scratch; the only text that moves is the live numeral on the
 * one-second ticker; the cursor readout is written with `textContent` from the
 * frame callback. No `useFleetStore` subscription may ever appear in here.
 */

/** Roughly a fifth of the visible window: enough vertical to read a shape. */
export const TELEMETRY_STRIP_HEIGHT = 56;

/**
 * Three times the resting height: below ~140 px the axis figures crowd the
 * trace, past ~200 px one measure starts claiming the page from seventeen.
 */
export const TELEMETRY_STRIP_EXPANDED_HEIGHT = 168;

export interface TelemetryStripProps extends Omit<
  React.ComponentPropsWithoutRef<"div">,
  "children"
> {
  unitId: string;
  /** Wire name, e.g. "knee_L" — the envelope is looked up from it. */
  joint: string;
  metric: TelemetryMetric;
  /** CSS pixels. Defaults to {@link TELEMETRY_STRIP_HEIGHT}. */
  height?: number;
  /** Grown into the focus canvas: axes, value scale, labelled reference. */
  expanded?: boolean;
  /** Provided by the grid; makes the label row the expand control. */
  onToggleExpand?: () => void;
}

export function TelemetryStrip({
  className,
  unitId,
  joint,
  metric,
  height,
  expanded = false,
  onToggleExpand,
  ...props
}: TelemetryStripProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const readoutRef = React.useRef<HTMLElement | null>(null);
  const deltaRef = React.useRef<HTMLElement | null>(null);
  const runtime = React.useRef<StripRuntime>({
    ctx: null,
    scales: null,
    width: 0,
    height: 0,
    plotHeight: 0,
    dpr: 1,
    drawnVersion: -1,
    drawnCursor: null,
    // The layout effect below reacts to changes only; a strip that mounts
    // already expanded has to start correct.
    expanded,
    compare: false,
    palette: FALLBACK_PALETTE,
    axes: [],
    readout: null,
    delta: null,
    wroteValue: "",
    wroteTone: "",
    wroteDelta: "",
    draw: () => {},
  });
  const env = envelope(joint, metric);
  const spec = METRIC_SPEC[metric];
  const boxHeight =
    height ?? (expanded ? TELEMETRY_STRIP_EXPANDED_HEIGHT : TELEMETRY_STRIP_HEIGHT);
  const mirror = mirrorJoint(joint);

  // A strip that collapses keeps the flag: an operator who drops out of the
  // expansion and comes back should find their comparison where they left it.
  const [comparing, setComparing] = React.useState(false);
  const showCompare = expanded && mirror !== null;
  const overlay = showCompare && comparing;

  // Mount-only: re-running would churn the shared loop, and everything it
  // closes over is a ref or constant for the strip's life (keyed by joint+metric).
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const state = runtime.current;
    state.ctx = canvas.getContext("2d");
    state.readout = readoutRef.current;
    state.delta = deltaRef.current;
    const subject: StripSubject = { unitId, joint, metric, env, spec, mirror };
    const draw = () => drawStrip(state, subject);
    state.draw = draw;

    // Sized from the observer's contentRect, never from layout. It redraws
    // SYNCHRONOUSLY: observers run after layout and before paint while rAF ran
    // before both, so an invalidate-only resize would hand the compositor a
    // cleared canvas — a flash on a window resize, a 180 ms hole in every
    // instrument while the expansion animates its height.
    const resize = (width: number, height: number) => {
      const dpr = globalThis.devicePixelRatio || 1;
      if (width === state.width && height === state.height && dpr === state.dpr) return;
      state.width = width;
      state.height = height;
      state.dpr = dpr;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      state.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      state.plotHeight = plotHeightFor(height, state.expanded);
      state.scales = stripScales(TELEMETRY_RING_CAPACITY, width, state.plotHeight, env);
      state.palette = readPalette(canvas);
      state.axes =
        state.expanded && state.ctx ? planAxes(state.ctx, state, env, spec) : EMPTY_AXES;
      state.drawnVersion = -1;
      draw();
    };

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) resize(rect.width, rect.height);
    });
    observer.observe(canvas);

    const stop = registerFrame(() => {
      // Under an opaque descent every pixel is invisible and each hidden
      // mutation re-rasterizes the filter-flattened subtree. Skip BEFORE the
      // version compare and stay registered: the first frame after the ascent
      // fails the compare and repaints the caught-up trace at once.
      if (isDescentOccluded()) return;
      draw();
    });

    return () => {
      observer.disconnect();
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expansion changes what is drawn, and the height transition means the
  // observer may not fire for several frames: push the flag down and repaint
  // now so the axes arrive with the first pixel of the growth.
  React.useLayoutEffect(() => {
    const state = runtime.current;
    if (state.expanded === expanded) return;
    state.expanded = expanded;
    state.plotHeight = plotHeightFor(state.height, expanded);
    if (state.height > 0) {
      state.scales = stripScales(
        TELEMETRY_RING_CAPACITY,
        state.width,
        state.plotHeight,
        env,
      );
    }
    state.axes =
      expanded && state.ctx ? planAxes(state.ctx, state, env, spec) : EMPTY_AXES;
    state.drawnVersion = -1;
    state.draw();
  }, [expanded, env, spec]);

  // One render on the click that toggles the overlay, then a forced repaint so
  // the second trace arrives with the press rather than with the next batch.
  React.useLayoutEffect(() => {
    const state = runtime.current;
    if (state.compare === overlay) return;
    state.compare = overlay;
    state.drawnVersion = -1;
    state.draw();
  }, [overlay]);

  const readout = (
    <span className="relative inline-flex items-baseline">
      {/* In flow while the cursor is up: it reserves the width so the label
          row cannot twitch as the two readings swap. */}
      <span className="group-data-[scrubbing]/grid:opacity-0">
        <StripValue unitId={unitId} joint={joint} metric={metric} />
      </span>
      {/* Out of flow on purpose: its text is rewritten from the frame callback
          while a pointer is down. `whitespace-nowrap` is load-bearing — the
          box is sized by the numeral beside it, and without it the Δ wraps. */}
      <span
        ref={readoutRef}
        aria-hidden
        data-slot="strip-cursor-readout"
        data-tone="ink"
        className={cn(
          READOUT,
          "absolute top-0 right-0 whitespace-nowrap",
          "opacity-0 group-data-[scrubbing]/grid:opacity-100",
          "text-ink data-[tone=alert]:text-alert-ink data-[tone=warn]:text-warn-ink",
        )}
      >
        <span data-slot="strip-cursor-value">—</span>
        <span className="ml-1 text-ink-soft">{spec.unit}</span>
        {/* Always mounted so the frame callback holds a stable ref; `empty:hidden`
            so an un-compared strip pays nothing for it. */}
        <span
          ref={deltaRef}
          data-slot="strip-cursor-delta"
          className="ml-2 text-ink-soft empty:hidden"
        />
      </span>
    </span>
  );

  return (
    <div
      data-slot="telemetry-strip"
      data-joint={joint}
      data-metric={metric}
      data-expanded={expanded ? "" : undefined}
      className={cn("flex flex-col gap-1", className)}
      {...props}
    >
      {/* A row rather than one button: a compare toggle nested inside the
          expand button would be a button inside a button. */}
      <div className="flex items-baseline gap-2">
        {onToggleExpand ? (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            data-slot="strip-expand"
            className={cn(
              "group/strip flex min-w-0 flex-1 items-baseline justify-between gap-3",
              "rounded-md px-1.5 text-left",
              "transition-colors duration-[var(--dur-press)] ease-console",
              "hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
              "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center",
              // The hover ground bleeds to the cell's optical margin on the
              // left always, and on the right only when nothing sits there.
              showCompare ? "-ml-1.5" : "-mx-1.5",
            )}
          >
            <span className="flex items-baseline gap-1.5">
              <SectionLabel>{spec.label}</SectionLabel>
              <ExpandCaret expanded={expanded} />
            </span>
            {readout}
            <span className="sr-only">
              {jointLabel(joint)} — {expanded ? "collapse" : "expand"}
            </span>
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
            <SectionLabel>{spec.label}</SectionLabel>
            {readout}
          </div>
        )}
        {showCompare && mirror ? (
          <CompareToggle
            mirror={mirror}
            comparing={comparing}
            onToggle={() => setComparing((on) => !on)}
          />
        ) : null}
      </div>
      {/* aria-hidden: the numeral above is the same information as text.
          touch-pan-y: a horizontal scrub and a vertical scroll never argue.
          The height transition is the expansion; CSS carries it so a second
          click mid-flight re-targets, and reduced motion gets no travel. */}
      <canvas
        ref={canvasRef}
        aria-hidden
        className={cn(
          "block w-full touch-pan-y",
          "transition-[height] duration-[var(--dur-enter)] ease-console motion-reduce:transition-none",
        )}
        style={{ height: boxHeight }}
      />
    </div>
  );
}
