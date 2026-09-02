"use client";

import * as React from "react";
import {
  getUnitBuffers,
  selectUnitTelemetryVersion,
  TELEMETRY_RING_CAPACITY,
  useFleetStore,
  type RingBuffer,
  type TelemetryMetric,
} from "@/lib/stores";
import { readToken, TOKEN_FALLBACK } from "@/lib/tokens/fallback";
import { cn } from "@/lib/utils";
import { isDescentOccluded } from "./descent-occlusion";
import { registerFrame } from "./frame-loop";
import {
  envelope,
  jointLabel,
  METRIC_SPEC,
  stripScales,
  type Envelope,
  type MetricSpec,
  type StripScales,
} from "./joint-spec";
import { mirrorJoint } from "./part-selection";
import { useNow } from "./relative-time";
import { SectionLabel } from "./section-label";
import { breachRuns, breachRunScratch, timeAxis, valueAxis } from "./telemetry-bands";
import { cursorOffsetFor } from "./telemetry-hover";

/**
 * One measure of one joint, as an instrument.
 *
 * Everything about this component is arranged so that a 10 Hz telemetry batch
 * costs React nothing (PRD §7). The host renders **once**, on mount. After
 * that:
 *
 * - samples are read straight out of the store's ring buffers, which are not
 * reactive state, into one module-level scratch array that is reused by
 * every strip on the page — zero allocation per frame;
 * - drawing happens in the shared rAF loop (frame-loop.ts), which checks the
 * unit's version counter *and* the shared cursor and returns without
 * touching the canvas when neither moved. At 10 Hz batches and 60 Hz frames
 * that is five frames out of six skipped, per strip, whenever nobody is
 * pointing at the grid;
 * - the only text that moves — the live numeral — is a separate child on the
 * app's one-second ticker, because an operator cannot read a number that
 * changes ten times a second and React should not be asked to write one;
 * - the cursor readout beside it is written with `textContent` from the frame
 * callback, never rendered, because a pointer moves faster than telemetry
 * arrives and eighteen subtrees must not re-render at pointer rate.
 *
 * The visual language is an instrument, not a dashboard. Three layers of ink,
 * in strict order of who is allowed to be loudest: the envelope underneath as a
 * pale ground, the regions where the measure actually left that envelope washed
 * in the unit's severity, and on top of both the 1px trace. No gridlines, no
 * gradients, no axes — until the strip is expanded, which is the one state
 * where an operator has asked for numbers and gets them.
 *
 * The expansion carries one more thing: a **compare** toggle that
 * overlays the opposite leg's trace, dashed and at a third strength, with the
 * difference between the two printed at the cursor. Asymmetry between a pair is
 * the first thing anyone looks for in a walking machine, and it is the one
 * reading the grid could show but not *measure*. The overlay adds no colour, no
 * scale and no allocation — a second module scratch, read through the same
 * `copyInto` the primary trace uses.
 */

/** Roughly a fifth of the visible window: enough vertical to read a shape. */
export const TELEMETRY_STRIP_HEIGHT = 56;

/**
 * Three times the resting height, which is what it takes for the expansion to
 * be a different *kind* of object rather than a bigger version of the same one.
 * Below about 140 px the axis figures crowd the trace and the reader gets a
 * strip with clutter on it; past about 200 px a single measure starts claiming
 * the page from the seventeen it is supposed to be compared against.
 */
export const TELEMETRY_STRIP_EXPANDED_HEIGHT = 168;

/** Room under the plot for the time axis, expanded only. */
const TIME_AXIS_HEIGHT = 18;

/**
 * How far back a breach counts, in samples (3 s at 10 Hz).
 *
 * Torque leaves its envelope on the peaks of a gait cycle rather than
 * continuously, so a strip tinted from the newest sample alone would flicker
 * between ink and amber several times a second — which reads as a rendering
 * bug and hides the actual event. Holding the tint for three seconds turns an
 * intermittent excursion into the statement it actually is: this measure has
 * been out of band recently.
 */
const BREACH_SAMPLES = 30;

/**
 * The guide is drawn in `--line` at one CSS pixel — the same weight and the
 * same token as every other hairline in the console, so the ceiling reads as
 * part of the page's rule work rather than as a chart feature. Sub-pixel
 * alternatives were tried and are worse: a half-pixel line on a retina display
 * is a rumour, and a datum a reader has to hunt for is not a datum.
 */
const GUIDE_TOKEN = "--line";

/**
 * The envelope fill, and why it is this faint.
 *
 * `--line` is the console's hairline colour; at 40 % over the page it lands
 * about four percent off the background — present enough that the eye reads the
 * box as having a floor and a ceiling, far too weak to compete with a 1px
 * trace. Eighteen of these are on screen at once, which is the constraint that
 * sets the number: anything strong enough to be obvious in one cell is a tonal
 * wash across the whole panel.
 */
const HEALTHY_FILL_ALPHA = 0.4;

/**
 * The breach wash. Amber and clay are saturated pigments next to a warm white,
 * so this is an eighth of what the trace gets — the region is meant to be found
 * by peripheral vision and then confirmed by reading the trace over it, not to
 * be the loudest thing in the cell.
 */
const BREACH_FILL_ALPHA = 0.13;

/** A single-sample excursion is 0.5 px wide at rest; this keeps it findable. */
const MIN_BREACH_PX = 2;

/**
 * One scratch array for every strip on the page. Draws are synchronous and
 * non-reentrant inside a single frame callback, so the eighteen strips of a
 * unit page can share 4.8 KB instead of holding 86 KB of private buffers.
 */
const scratch = new Float64Array(TELEMETRY_RING_CAPACITY);

/**
 * The second scratch, for the opposite joint's trace.
 *
 * It has to be a second array rather than a reuse of the one above, and the
 * reason is the draw order: the primary series is copied out first and is still
 * being read when the trace is stroked at the end, so the mirror cannot borrow
 * the same 4.8 KB in between. Two arrays, still module-level, still shared by
 * every strip on the page — the allocation budget per frame stays zero, which
 * is the only number that matters.
 */
const mirrorScratch = new Float64Array(TELEMETRY_RING_CAPACITY);

/**
 * The comparison trace, and why it invents no colour.
 *
 * A second hue would be a second severity scale — the exact thing stripTone()
 * below refuses to do — and on a panel where amber and clay already mean
 * something specific, a blue or a green line would be read as a third state
 * rather than as the same measure on the other leg. So the overlay is the ink
 * the trace is already drawn in, at a little over a third strength and dashed.
 * The dash is what survives a screenshot, a projector and a colour-blind
 * reader; the alpha is what keeps the primary trace unambiguously on top.
 */
const COMPARE_ALPHA = 0.38;
/** Module constants: `setLineDash` takes an array, and a frame allocates none. */
const COMPARE_DASH: number[] = [3, 3];
const NO_DASH: number[] = [];

export type StripTone = "ink" | "warn" | "alert";

/** True when any of the last `samples` readings exceeded the healthy ceiling. */
export function breachedRecently(
  series: RingBuffer,
  healthy: number,
  samples = BREACH_SAMPLES,
): boolean {
  const from = Math.max(0, series.length - samples);
  for (let i = series.length - 1; i >= from; i -= 1) {
    if (series.at(i) > healthy) return true;
  }
  return false;
}

/**
 * A measure out of band is coloured by how bad the *unit* is, not by how far
 * out the measure is: the operator has already been told the severity by the
 * alert, and a strip inventing a second severity scale would be a second
 * opinion nobody asked for. In band, everything is ink.
 */
export function stripTone(breached: boolean, status: string | undefined): StripTone {
  if (!breached) return "ink";
  return status === "red" ? "alert" : "warn";
}

const TONE_CLASS: Record<StripTone, string> = {
  ink: "text-ink",
  warn: "text-warn-ink",
  alert: "text-alert-ink",
};

/**
 * The readout's frame, in both of its states (D1).
 *
 * Carrying the transition in a constant both branches share is what makes the
 * arrival a *step* rather than a swap: the em-dash and the first reading are
 * the same `<span>` — React patches its class and its children, it does not
 * replace the element — so the numeral lands in the muted no-data tone and
 * inks up over `--dur-micro`, one acknowledgement per box per session.
 *
 * It cannot become per-sample motion. A new value does not change this
 * colour, so the one-second ticker moves the digits underneath a transition
 * that never fires; and the digits themselves are never interpolated, which is
 * the line fluid-audit judgment call 3 draws and this beat stays behind. The
 * only other thing that can move it is the tone leaving the envelope, which
 * `breachedRecently` already holds for three seconds precisely so it is a
 * statement and not a flicker — a statement worth easing into.
 */
const READOUT =
  "tnum text-small transition-colors duration-[var(--dur-micro)] ease-console";

interface StripPalette extends Record<StripTone, string> {
  guide: string;
  /**
   * The cursor rule.
   *
   * `--muted` rather than `--line-strong`, for two reasons that point the same
   * way. It has to be found in eighteen boxes at once, and a hairline the eye
   * has to hunt for cannot do the one job the cursor has — saying that all
   * eighteen readings are the same instant. And `--muted` is a flat hex in both
   * spaces while `--line-strong` is a `color-mix()`, which a canvas has to
   * re-parse as a colour string; an unparseable `strokeStyle` is *silently
   * ignored* by the 2D context, so the failure mode there is a cursor drawn in
   * whatever colour was last set rather than an error anybody would see. This
   * is the console's rule-and-divider token (globals.css names non-text UI
   * graphics as exactly where it may be spent), which is what this is.
   */
  cursor: string;
  /** `--ink-soft`: axis figures. `--muted` fails AA below 24px (globals.css). */
  axis: string;
  /** `--bg`: the plate under an axis figure so a trace cannot swallow it. */
  plate: string;
  /** Resolved font shorthand for canvas text, e.g. `11px "Geist Sans", …`. */
  axisFont: string;
}

/** Before the element is sampled: the operator palette, where the strips live. */
const FALLBACK_PALETTE: StripPalette = {
  ink: TOKEN_FALLBACK.operator["--ink"],
  warn: TOKEN_FALLBACK.operator["--warn"],
  alert: TOKEN_FALLBACK.operator["--alert"],
  guide: TOKEN_FALLBACK.operator[GUIDE_TOKEN],
  cursor: TOKEN_FALLBACK.operator["--muted"],
  axis: TOKEN_FALLBACK.operator["--ink-soft"],
  plate: TOKEN_FALLBACK.operator["--bg"],
  axisFont: "11px sans-serif",
};

/**
 * Canvas cannot read CSS variables, so the token layer is sampled off the
 * element itself — which means the strip picks up whichever space it renders
 * inside without a prop, exactly like every DOM component in this library.
 * Sampled on mount and on resize only; `getComputedStyle` forces style
 * resolution and has no business in a frame callback.
 */
function readPalette(el: Element): StripPalette {
  const style = getComputedStyle(el);
  // The axis figure is the same size as every other label in the console
  // (--fs-label), taken from the token layer rather than hardcoded so machine
  // space's tighter 10px lands automatically.
  const size = style.getPropertyValue("--fs-label").trim() || "0.6875rem";
  const px = size.endsWith("rem")
    ? Number.parseFloat(size) * 16
    : Number.parseFloat(size);
  const family = style.fontFamily || "sans-serif";
  return {
    ink: readToken(style, "--ink", "operator"),
    warn: readToken(style, "--warn", "operator"),
    alert: readToken(style, "--alert", "operator"),
    guide: readToken(style, GUIDE_TOKEN, "operator"),
    cursor: readToken(style, "--muted", "operator"),
    axis: readToken(style, "--ink-soft", "operator"),
    plate: readToken(style, "--bg", "operator"),
    axisFont: `${Number.isFinite(px) ? Math.round(px) : 11}px ${family}`,
  };
}

interface StripRuntime {
  ctx: CanvasRenderingContext2D | null;
  scales: StripScales | null;
  width: number;
  height: number;
  /** Plot height: the whole box at rest, minus the time axis when expanded. */
  plotHeight: number;
  dpr: number;
  /** Last version drawn; -1 forces the next frame to redraw (resize, remount). */
  drawnVersion: number;
  /** Last cursor offset drawn, so a pointer move dirties the canvas exactly once. */
  drawnCursor: number | null;
  expanded: boolean;
  /** The opposite joint's trace is overlaid. Expanded strips only. */
  compare: boolean;
  palette: StripPalette;
  /** Axis figures, laid out at resize; empty while resting. */
  axes: AxisMark[];
  /** The imperative readout: written from the frame callback, never rendered. */
  readout: HTMLElement | null;
  /** The Δ slot inside it — `:empty` hides itself, so it costs nothing when off. */
  delta: HTMLElement | null;
  /** Last string written, so an unchanged reading costs no DOM write at all. */
  wroteValue: string;
  wroteTone: string;
  wroteDelta: string;
  draw: () => void;
}

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
    // The initial-render value, kept: the layout effect below only reacts to
    // *changes*, so a strip that mounts already expanded has to start correct.
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

  /**
   * The other leg's version of this measure, or null for a joint with no
   * opposite number. Constant for the life of a strip — a strip is keyed by
   * joint and metric — so the frame callback can close over it.
   */
  const mirror = mirrorJoint(joint);

  /**
   * Comparison is offered only in the expanded state, where there are axes to
   * read two traces against and 168 px to keep them apart. A strip that
   * collapses keeps the flag: an operator who drops out of the expansion to
   * glance at the joint above and comes back should find their comparison
   * where they left it, not have to ask for it twice.
   */
  const [comparing, setComparing] = React.useState(false);
  const showCompare = expanded && mirror !== null;
  const overlay = showCompare && comparing;

  // Mount-only: the effect must not re-run, because re-running it would churn
  // the shared loop. Everything it closes over is either a ref or a value that
  // cannot change for the life of a strip (a strip is keyed by joint+metric).
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const state = runtime.current;
    state.ctx = canvas.getContext("2d");
    state.readout = readoutRef.current;
    state.delta = deltaRef.current;

    const draw = () => {
      const { ctx, scales, palette } = state;
      if (!ctx || !scales || state.width <= 0) return;

      // The two cheap checks that make eighteen canvases free: a property read
      // on a plain object and a comparison against a module variable. No
      // subscription, no render, no draw.
      const version = selectUnitTelemetryVersion(unitId)(useFleetStore.getState());
      const cursor = cursorOffsetFor(unitId);
      if (version === state.drawnVersion && cursor === state.drawnCursor) return;
      state.drawnVersion = version;
      state.drawnCursor = cursor;

      const series = getUnitBuffers(unitId)?.joints.get(joint)?.[metric];
      const plotH = state.plotHeight;
      ctx.clearRect(0, 0, state.width, state.height);

      // -- the envelope, as ground ---------------------------------------
      // Drawn before anything else and with no data dependency at all: the
      // healthy corridor is a fact about the hardware, so it is there on a
      // strip that has never received a sample.
      const guideY = snap(scales.y(env.healthy), state.dpr);
      ctx.globalAlpha = HEALTHY_FILL_ALPHA;
      ctx.fillStyle = palette.guide;
      ctx.fillRect(0, guideY, state.width, plotH - guideY);
      ctx.globalAlpha = 1;

      const status = useFleetStore.getState().units[unitId]?.status;
      const tone = series
        ? stripTone(breachedRecently(series, env.healthy), status)
        : "ink";

      /** The tone a sample outside the envelope is allowed to be. */
      const breachTone: StripTone = status === "red" ? "alert" : "warn";

      if (!series || series.length === 0) {
        strokeGuide(ctx, state, guideY);
        if (state.expanded) drawAxes(ctx, state);
        writeReadout(state, undefined, "ink", spec.precision);
        return;
      }

      const n = series.copyInto(scratch);

      // -- where it actually left the envelope ---------------------------
      // Under the trace, over the ground: the wash says *when*, the trace says
      // by how much, and the order of the two is the order an operator reads
      // them in.
      const runs = breachRunScratch();
      const runCount = breachRuns(scratch, n, env.healthy, runs, BREACH_SAMPLES);
      if (runCount > 0) {
        ctx.globalAlpha = BREACH_FILL_ALPHA;
        ctx.fillStyle = palette[breachTone];
        for (let r = 0; r < runCount; r += 1) {
          const from = scales.x((runs[r * 2] ?? 0) - (n - 1));
          const to = scales.x((runs[r * 2 + 1] ?? 0) - (n - 1));
          ctx.fillRect(from, 0, Math.max(MIN_BREACH_PX, to - from), plotH);
        }
        ctx.globalAlpha = 1;
      }

      strokeGuide(ctx, state, guideY);

      // -- the opposite joint, when asked for -----------------------------
      // Under the primary trace and dashed, so the two can never be confused
      // for one another. It needs no scale of its own: a pair is the same
      // hardware and joint-spec.ts scales them identically on purpose, which
      // is the entire reason overlaying them says anything — two traces in one
      // box drawn against two different y domains would be a picture of
      // nothing. Read through the same `copyInto` contract as the primary, into
      // the second module scratch.
      let mirrorN = 0;
      if (state.compare && mirror) {
        const other = getUnitBuffers(unitId)?.joints.get(mirror)?.[metric];
        mirrorN = other ? other.copyInto(mirrorScratch) : 0;
      }
      if (mirrorN > 0) {
        ctx.globalAlpha = COMPARE_ALPHA;
        ctx.strokeStyle = palette.ink;
        ctx.lineWidth = 1;
        ctx.setLineDash(COMPARE_DASH);
        ctx.beginPath();
        for (let i = 0; i < mirrorN; i += 1) {
          const x = scales.x(i - (mirrorN - 1));
          const y = scales.y(mirrorScratch[i] ?? env.floor);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash(NO_DASH);
        ctx.globalAlpha = 1;
      }

      // -- the trace ------------------------------------------------------
      ctx.strokeStyle = palette[tone];
      ctx.lineWidth = 1;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let i = 0; i < n; i += 1) {
        const x = scales.x(i - (n - 1));
        const y = scales.y(scratch[i] ?? env.floor);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // -- the figures ----------------------------------------------------
      // Over the trace, not under it. The plate behind each figure is what
      // keeps it readable, and a plate can only defend against what is drawn
      // before it — an axis label with a trace ruled through the middle is not
      // an axis label. At 86 % the trace still ghosts through, which is the
      // right compromise: the number wins and the shape is not lost.
      if (state.expanded) drawAxes(ctx, state);

      // -- the cursor -----------------------------------------------------
      if (cursor === null) {
        writeReadout(state, undefined, "ink", spec.precision);
        return;
      }
      const index = n - 1 + cursor;
      const value = index >= 0 && index < n ? scratch[index] : undefined;
      if (value === undefined) {
        writeReadout(state, undefined, "ink", spec.precision);
        return;
      }
      // The comparison's payoff, and the only number it produces: how far apart
      // the two legs are *at the instant under the cursor*. A reader can see
      // that two traces diverge; what they cannot do is measure the gap off a
      // 168 px box, and "the left knee is 6.4 °C hotter than the right" is the
      // sentence the whole overlay exists to let them say. Addressed by offset
      // from newest, like everything else in the hover system — the two rings
      // fill from the same batch, so the same offset is the same instant.
      const mirrorIndex = mirrorN - 1 + cursor;
      const against =
        mirrorIndex >= 0 && mirrorIndex < mirrorN
          ? mirrorScratch[mirrorIndex]
          : undefined;
      const cx = snap(scales.x(cursor), state.dpr);
      ctx.strokeStyle = palette.cursor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, plotH);
      ctx.stroke();

      // The dot is what makes the cursor a reading rather than a ruler: it
      // lands on the sample the numeral above is printing, so the eye can
      // check the figure against the shape without leaving the cell.
      const cy = scales.y(value);
      const over = value > env.healthy;
      ctx.fillStyle = palette.plate;
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = palette[over ? breachTone : "ink"];
      ctx.beginPath();
      ctx.arc(cx, cy, 1.75, 0, Math.PI * 2);
      ctx.fill();

      writeReadout(
        state,
        value,
        over ? breachTone : "ink",
        spec.precision,
        against === undefined ? undefined : value - against,
      );
    };
    state.draw = draw;

    /**
     * Sizing is taken from the ResizeObserver's own contentRect rather than
     * from the element's layout box, so measuring never forces a synchronous
     * reflow inside the frame callback.
     *
     * It redraws *synchronously*, and that is not an optimisation. Resize
     * observers run after layout and before paint, while rAF ran before both:
     * a resize that only invalidated `drawnVersion` would hand the compositor a
     * canvas the browser had just cleared, and the strip would flash empty for
     * one frame. Harmless once on a window resize; a 180 ms hole in every
     * instrument when the expansion animates its height.
     */
    const resize = (width: number, height: number) => {
      const dpr = globalThis.devicePixelRatio || 1;
      if (width === state.width && height === state.height && dpr === state.dpr) return;
      state.width = width;
      state.height = height;
      state.dpr = dpr;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      // Draw in CSS pixels; the backing store is device pixels.
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
      // Under an opaque descent surface every pixel this strip could paint is
      // invisible — and worse than free, because the canvas sits inside the
      // `[data-descent]` filter subtree, so each hidden mutation re-rasterizes
      // a filter-flattened surface (NPA-01). Skip *before* the version compare
      // and stay registered: `drawnVersion` goes stale while the ring buffers
      // advance, so the first frame after the ascent begins fails the compare
      // below and repaints the whole caught-up trace at once.
      if (isDescentOccluded()) return;
      draw();
    });

    return () => {
      observer.disconnect();
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expansion changes what is drawn, not just how big it is, and the height
  // transition means the ResizeObserver may not fire for several frames. Push
  // the flag down and repaint now so the axes arrive with the first pixel of
  // the growth rather than at the end of it.
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

  // The overlay is a flag the frame callback reads, pushed down the same way
  // the expansion is: one render on the click that toggles it, then a forced
  // repaint so the second trace arrives with the press rather than with the
  // next telemetry batch a tenth of a second later.
  React.useLayoutEffect(() => {
    const state = runtime.current;
    if (state.compare === overlay) return;
    state.compare = overlay;
    state.drawnVersion = -1;
    state.draw();
  }, [overlay]);

  const readout = (
    <span className="relative inline-flex items-baseline">
      {/* In flow, and kept in flow while the cursor is up: it reserves the
          width so the label row cannot twitch as the two readings swap. */}
      <span className="group-data-[scrubbing]/grid:opacity-0">
        <StripValue unitId={unitId} joint={joint} metric={metric} />
      </span>
      {/* Out of flow on purpose. This element's text is rewritten from the
          frame callback while a pointer is down; in flow, each write would
          reflow the label row eighteen times a frame. */}
      <span
        ref={readoutRef}
        aria-hidden
        data-slot="strip-cursor-readout"
        data-tone="ink"
        className={cn(
          READOUT,
          // `whitespace-nowrap` is load-bearing, not defensive. This box is
          // absolutely positioned with only `right` set, so its shrink-to-fit
          // width is capped by the containing block — which is sized by the
          // live numeral beside it. Without nowrap the Δ is exactly the extra
          // width that overflows that cap, and "38.5 °C Δ" wraps, dropping
          // "+3.4" onto a second line inside a row that has no second line.
          "absolute top-0 right-0 whitespace-nowrap",
          "opacity-0 group-data-[scrubbing]/grid:opacity-100",
          "text-ink data-[tone=alert]:text-alert-ink data-[tone=warn]:text-warn-ink",
        )}
      >
        <span data-slot="strip-cursor-value">—</span>
        <span className="ml-1 text-ink-soft">{spec.unit}</span>
        {/* Always mounted so the frame callback holds a stable ref, and
            `empty:hidden` so an un-compared strip pays nothing for it: an
            empty inline element with a left margin would still shift the
            readout eight pixels. Written with textContent, like its sibling. */}
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
      {/* The label row is one control at rest and two once the strip is
          expanded, so it is a row rather than a single button — a compare
          toggle nested inside the expand button would be a button inside a
          button, which is invalid and which no browser gives two hit targets
          to. The expand control keeps the whole remaining width; the toggle
          takes only what its two words need. */}
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
      {/* aria-hidden: the trace has no summary a screen reader could use, and
          the numeral above it is the same information as text.
          touch-action: the browser decides a vertical drag is the page's
          before the first pointermove is delivered (fluid-audit §3), so a
          horizontal scrub and a scroll never have to argue.
          The height transition is the expansion: the box grows and the trace
          re-scales into it every frame, so it reads as the same instrument
          getting bigger rather than a second one appearing. CSS carries it, so
          a second click mid-flight re-targets from wherever it has reached —
          and reduced motion gets the destination with no travel. */}
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

/** The resting state's axis list: one shared empty array, never reallocated. */
const EMPTY_AXES: AxisMark[] = [];

/** Plot box: the whole canvas at rest, minus the time axis when expanded. */
function plotHeightFor(height: number, expanded: boolean): number {
  return expanded ? Math.max(1, height - TIME_AXIS_HEIGHT) : height;
}

/**
 * Snapped so a hairline lands on whole device rows: an unsnapped 1px line is
 * antialiased across two rows and reads as a smudge.
 */
function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

function strokeGuide(
  ctx: CanvasRenderingContext2D,
  state: StripRuntime,
  y: number,
): void {
  ctx.strokeStyle = state.palette.guide;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(state.width, y);
  ctx.stroke();
}

/**
 * The numbers, and only in the expanded state.
 *
 * A resting strip has no axis because at 56 px an axis is louder than the data
 * and an operator scanning eighteen of them is reading *shapes*. Expanding one
 * is the moment they stop scanning and start measuring, so that is the moment
 * the figures appear — the envelope's own three values down the left, the sixty
 * second window along the bottom, and the word for what the guide line is.
 *
 * Drawn inside the plot rather than in a gutter so that the x mapping is
 * identical expanded and collapsed: the shared cursor addresses samples, and a
 * strip that inset its plot by a left margin would put its cursor a margin's
 * width away from the seventeen it is supposed to agree with. Each figure sits
 * on a plate of `--bg` so a trace passing behind it cannot eat it.
 */
interface AxisMark {
  text: string;
  x: number;
  y: number;
  align: CanvasTextAlign;
  /** The `--bg` plate behind the figure; zero width means no plate. */
  plateX: number;
  plateW: number;
}

/** Height of the plate behind an axis figure. */
const PLATE_H = 14;
const PLATE_ALPHA = 0.86;

/**
 * The axis is laid out once, when the box or the envelope changes — never in a
 * frame.
 *
 * Both halves of that matter. `valueAxis`/`timeAxis` build small arrays of
 * strings, and `measureText` returns a fresh `TextMetrics` per call; doing
 * either inside `draw` would put six allocations per frame on the one strip
 * that redraws at pointer rate, which is the whole thing the canvas layer
 * exists to avoid. The layout is also pure geometry — it depends on the scales
 * and the font, and both are settled by the time the observer has sized the
 * canvas.
 */
function planAxes(
  ctx: CanvasRenderingContext2D,
  state: StripRuntime,
  env: Envelope,
  spec: MetricSpec,
): AxisMark[] {
  const { scales, palette, width, plotHeight } = state;
  if (!scales || width <= 0) return [];
  ctx.font = palette.axisFont;
  const marks: AxisMark[] = [];

  for (const label of valueAxis(env, spec)) {
    const y = Math.min(plotHeight - 7, Math.max(7, scales.y(label.value)));
    const w = ctx.measureText(label.text).width;
    marks.push({ text: label.text, x: 5, y, align: "left", plateX: 2, plateW: w + 6 });
    if (!label.reference) continue;
    // The one caption on the canvas. It names the line an operator is checking
    // against, at the end of that line, so it cannot be read as belonging to
    // anything else.
    const caption = "healthy";
    const cw = ctx.measureText(caption).width;
    marks.push({
      text: caption,
      x: width - 5,
      y,
      align: "right",
      plateX: width - cw - 8,
      plateW: cw + 6,
    });
  }

  const y = plotHeight + TIME_AXIS_HEIGHT / 2;
  for (const label of timeAxis(TELEMETRY_RING_CAPACITY)) {
    marks.push({
      text: label.text,
      x:
        label.anchor === "start"
          ? 1
          : label.anchor === "end"
            ? width - 1
            : scales.x(label.offset),
      y,
      align:
        label.anchor === "start" ? "left" : label.anchor === "end" ? "right" : "center",
      plateX: 0,
      plateW: 0,
    });
  }
  return marks;
}

function drawAxes(ctx: CanvasRenderingContext2D, state: StripRuntime): void {
  ctx.font = state.palette.axisFont;
  ctx.textBaseline = "middle";
  for (const mark of state.axes) {
    if (mark.plateW > 0) {
      ctx.globalAlpha = PLATE_ALPHA;
      ctx.fillStyle = state.palette.plate;
      ctx.fillRect(mark.plateX, mark.y - PLATE_H / 2, mark.plateW, PLATE_H);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = state.palette.axis;
    ctx.textAlign = mark.align;
    ctx.fillText(mark.text, mark.x, mark.y);
  }
  ctx.textAlign = "left";
}

/**
 * The cursor readout, written straight into the DOM.
 *
 * Three guards, all load-bearing at pointer rate: the string is only built when
 * the sample under the cursor changed, the tone attribute is only touched when
 * it flips, and the Δ slot is only touched when the difference moves. A pointer
 * crossing a 330 px column passes over roughly one sample every half pixel, so
 * most moves write nothing at all.
 */
function writeReadout(
  state: StripRuntime,
  value: number | undefined,
  tone: StripTone,
  precision: number,
  delta?: number,
): void {
  const el = state.readout;
  if (!el) return;
  const text = value === undefined ? "—" : value.toFixed(precision);
  if (text !== state.wroteValue) {
    const slot = el.firstElementChild;
    if (slot) slot.textContent = text;
    state.wroteValue = text;
  }
  if (tone !== state.wroteTone) {
    el.dataset.tone = tone;
    state.wroteTone = tone;
  }
  // Empty string when there is nothing to compare against — the slot carries
  // `empty:hidden`, so a strip that is not comparing has no Δ element in the
  // layout at all and the readout keeps exactly the width it always had.
  const diff = delta === undefined ? "" : formatDelta(delta, precision);
  if (diff !== state.wroteDelta) {
    if (state.delta) state.delta.textContent = diff;
    state.wroteDelta = diff;
  }
}

/**
 * "Δ +1.8" — always signed, and with the typographic minus the rest of the
 * console prints (joint-grid's cursor age, the axis figures). A delta with no
 * sign on it is not a delta, it is a second reading.
 */
function formatDelta(delta: number, precision: number): string {
  // −0.0 is a real output of toFixed on a tiny negative, and "Δ −0.0" reads as
  // a fault in the instrument rather than as two legs doing the same thing.
  const rounded = Math.abs(delta) < 0.5 / 10 ** precision ? 0 : delta;
  const sign = rounded < 0 ? "−" : "+";
  return `Δ ${sign}${Math.abs(rounded).toFixed(precision)}`;
}

/**
 * "Compare right" — the second control on an expanded strip.
 *
 * It exists only in the expansion, and that is the whole design of it. At 56 px
 * an operator is scanning shapes across eighteen boxes and the left/right
 * comparison is already available to them as a glance down a column of the grid
 * (JOINT_GRID_ORDER puts pairs above one another for exactly this). Expanding a
 * strip is the moment they stop scanning and start measuring one thing, and it
 * is the only moment when overlaying a second trace answers a question rather
 * than adding a line.
 *
 * A toggle button with `aria-pressed` rather than a checkbox: this turns a
 * layer of a drawing on and off, which is what a pressed button means, and it
 * keeps the control operable with a keyboard at no cost. The accessible name
 * says which joint, because "Compare right" is only unambiguous next to the
 * cell heading a screen reader has already moved past.
 */
function CompareToggle({
  mirror,
  comparing,
  onToggle,
}: {
  mirror: string;
  comparing: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={comparing}
      aria-label={`Overlay ${jointLabel(mirror).toLowerCase()} on this trace for comparison`}
      data-slot="strip-compare"
      className={cn(
        "-mr-1.5 shrink-0 rounded-md px-1.5 text-label whitespace-nowrap uppercase",
        "transition-colors duration-[var(--dur-press)] ease-console",
        "text-ink-muted hover:bg-surface hover:text-ink-soft",
        "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
        // Pressed reads as a held-down chip rather than as a colour: the trace
        // it turns on is already ink, and a coloured control over a monochrome
        // overlay would promise a legend that does not exist.
        "aria-pressed:bg-surface aria-pressed:text-ink",
        // A 11px label is a 14px hit target; a thumb needs 44.
        "[@media(pointer:coarse)]:flex [@media(pointer:coarse)]:min-h-11",
        "[@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:px-2.5",
      )}
    >
      Compare {mirror.endsWith("_R") ? "right" : "left"}
    </button>
  );
}

/**
 * The expand affordance: a caret that is invisible until the row is pointed at
 * or focused, and always present on a touch screen where there is no hover to
 * reveal it. Rotating rather than swapping glyphs, so the control keeps its
 * identity across the state change.
 */
function ExpandCaret({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 8"
      className={cn(
        "size-2 shrink-0 text-ink-muted",
        "opacity-0 transition-[opacity,transform] duration-[var(--dur-micro)] ease-console",
        "group-hover/strip:opacity-100 group-focus-visible/strip:opacity-100",
        "[@media(pointer:coarse)]:opacity-100",
        expanded && "rotate-180 opacity-100",
      )}
    >
      <path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/**
 * The live numeral, on the app's one-second clock.
 *
 * Reads the ring buffer non-reactively — the same trick the fleet rail uses
 * for "last contact": the value is a coarse fact, the clock decides when to
 * re-read it, and the ten batches that arrive between two ticks cost nothing.
 * Rendering this from the telemetry version instead would put a text node on
 * the hot path and re-render the strip's whole subtree ten times a second to
 * move one decimal place.
 */
function StripValue({
  unitId,
  joint,
  metric,
}: {
  unitId: string;
  joint: string;
  metric: TelemetryMetric;
}) {
  const now = useNow();
  const spec = METRIC_SPEC[metric];
  const env = envelope(joint, metric);
  const series = getUnitBuffers(unitId)?.joints.get(joint)?.[metric];
  const value = now === 0 ? undefined : series?.last();

  if (value === undefined || !series) {
    return (
      <span className={cn(READOUT, "text-ink-muted")}>
        <span aria-hidden>—</span>
        <span className="sr-only">No reading yet</span>
      </span>
    );
  }

  const status = useFleetStore.getState().units[unitId]?.status;
  const tone = stripTone(breachedRecently(series, env.healthy), status);

  return (
    <span className={cn(READOUT, TONE_CLASS[tone])}>
      {value.toFixed(spec.precision)}
      <span className="ml-1 text-ink-soft">{spec.unit}</span>
    </span>
  );
}
