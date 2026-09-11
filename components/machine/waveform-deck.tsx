"use client";

import * as React from "react";
import { JOINTS, registerFrame } from "@/components/console";
import { type DiagChannel } from "@/lib/stores";
import { readToken, TOKEN_FALLBACK } from "@/lib/tokens/fallback";
import { machineJoint, pad2 } from "./scan-copy";
import { useDiagSession } from "./scan-state";
import {
  TONE_BY_INDEX,
  writeSampleTones,
  type ChannelTone,
} from "@/lib/diagnostics/waveform-math";

/**
 * Six channels, live against their factory reference.
 *
 * The picture is the eva brainwave panel (eva-brainwave-waveforms.png) turned
 * ninety degrees: there, traces run top-to-bottom past a horizontal red cursor
 * with rotated orange channel labels beside them; here they run left-to-right
 * past a vertical one, because six stacked strips is what a right-hand column
 * wants and because time reading left-to-right is the one convention worth
 * keeping from the operator world.
 *
 * ## Canvas architecture: six canvases, one frame callback
 *
 * The alternative — one big canvas for all six — was rejected for two reasons.
 * The layout: strips need rotated labels, ordinals and rules around them, and
 * a single canvas would mean reimplementing that layout in pixel arithmetic and
 * re-deriving it on every resize, when CSS grid already does it. And the
 * redraw: one surface means one `clearRect` over the whole column whenever any
 * channel moves, so the five settled strips repaint sixty times a second to
 * keep the one sweeping strip company.
 *
 * What is emphatically *not* six is the scheduler. There is a single
 * `registerFrame` subscription here (components/console/frame-loop.ts) that
 * walks an array of six runtimes, and it skips any strip whose sweep has
 * settled by comparing two numbers. Once all six are in, the callback does six
 * comparisons and returns — no clears, no strokes — while the eighteen
 * sparklines on the operator page underneath keep drawing from the same loop.
 *
 * ## What is data and what is presentation
 *
 * A channel arrives as one event carrying 120 samples; the sweep that reveals
 * it over ~1.4 s is presentation, and the PRD asks for exactly that. The
 * distinction is kept honest at the edges: nothing is interpolated *into* the
 * data, the reveal only decides how much of it is on screen yet, and channels
 * that were already in the session when this deck mounted (a page refreshed
 * mid-scan, replaying the prefix) render settled rather than re-performing a
 * sweep that already happened.
 *
 * ## Colour is measurement
 *
 * The live trace is drawn in runs coloured by the *local* RMS deviation of the
 * samples under them (waveform-math.ts), against the same two thresholds the
 * simulator's own test suite asserts. On five channels that is phosphor from
 * end to end. On the left knee, whose fault ramps from 1.35x to 1.8x gain
 * across the window, the trace leaves in phosphor, crosses into amber, and
 * arrives in alert red — so the strip shows the failure developing instead of
 * announcing a conclusion in a flat colour. Nothing here decides that the knee
 * is broken; it draws what it measured, and the measurement happens to say so.
 */

/** How long one channel takes to reveal. Presentation, not data. */
const REVEAL_MS = 1400;

/**
 * The floor for one strip lives in CSS, as `--wave-strip-h` on `.wave-deck`
 * (app/globals.css): 58px on a board, 46px on a phone. Strips flex to share
 * whatever height the column has above that floor, so a tall display gets tall
 * traces — the reference's proportion, and the one that makes a gain
 * divergence obvious — and a short one still gets six readable bands rather
 * than a scrollbar. It is a property rather than an inline style here because
 * a number written from JS wins over every media query that might want it.
 */
/** Half a stroke plus room for a 1.8x-gain excursion to stay inside the box. */
const PAD_Y = 3;

/** Luminance tiers (PRD §5: hierarchy comes from luminance). */
const ALPHA_SWEEPING = 1;
const ALPHA_NEWEST = 0.78;
const ALPHA_SETTLED = 0.52;
/**
 * The reference has to be *readable*, not merely present: on the failing
 * channel the whole diagnosis is the gap between the two traces, and a
 * reference the eye has to hunt for turns that gap into a single red squiggle
 * with nothing to be wrong against. Half opacity on the soft phosphor tier
 * leaves it clearly subordinate to the live trace and clearly there.
 */
const ALPHA_REF = 0.5;

/** Sentinel arrival time meaning "this was already history when we mounted". */
const SEEDED = 0;

interface StripPalette extends Record<ChannelTone, string> {
  ref: string;
  grid: string;
  cursor: string;
}

/** Before the element is sampled: the machine palette, where the deck lives. */
const FALLBACK: StripPalette = {
  nominal: TOKEN_FALLBACK.machine["--ink"],
  warn: TOKEN_FALLBACK.machine["--warn"],
  alert: TOKEN_FALLBACK.machine["--alert"],
  ref: TOKEN_FALLBACK.machine["--ink-soft"],
  grid: TOKEN_FALLBACK.machine["--line"],
  cursor: TOKEN_FALLBACK.machine["--alert"],
};

function readPalette(el: Element): StripPalette {
  const style = getComputedStyle(el);
  return {
    nominal: readToken(style, "--ink", "machine"),
    warn: readToken(style, "--warn", "machine"),
    alert: readToken(style, "--alert", "machine"),
    ref: readToken(style, "--ink-soft", "machine"),
    grid: readToken(style, "--line", "machine"),
    cursor: readToken(style, "--alert", "machine"),
  };
}

interface StripRuntime {
  joint: string;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  width: number;
  height: number;
  dpr: number;
  channel: DiagChannel | null;
  /** Per-sample tone index; sized and filled once, when the channel lands. */
  tones: Uint8Array | null;
  /** performance.now() at arrival, or SEEDED for a replayed channel. */
  arrivedAt: number;
  /** -1 forces the next frame to draw (resize, new channel, state change). */
  drawnProgress: number;
  drawnAlpha: number;
  drawnWidth: number;
}

function makeRuntime(joint: string): StripRuntime {
  return {
    joint,
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    dpr: 1,
    channel: null,
    tones: null,
    arrivedAt: SEEDED,
    drawnProgress: -1,
    drawnAlpha: -1,
    drawnWidth: -1,
  };
}

export interface WaveformDeckProps {
  /** Locks its strip to full alert intensity for the rest of the session. */
  flaggedJoint?: string | null;
  /**
   * Bring each arriving channel into view (phone flow only — see
   * `useStackedScan`). On a board every strip is already on screen and this
   * would be six no-ops a scan.
   */
  revealArrivals?: boolean;
  /** Jump rather than glide. */
  reducedMotion?: boolean;
}

export function WaveformDeck({
  flaggedJoint,
  revealArrivals = false,
  reducedMotion = false,
}: WaveformDeckProps) {
  const session = useDiagSession();
  const channels = session?.channels;
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const stripEls = React.useRef<Array<HTMLDivElement | null>>(JOINTS.map(() => null));
  const runtimes = React.useRef<StripRuntime[]>(JOINTS.map(makeRuntime));
  const palette = React.useRef<StripPalette>(FALLBACK);
  const flagged = React.useRef<string | null>(null);
  flagged.current = flaggedJoint ?? null;

  /**
   * Follow the sweep down the deck — until the operator takes the scroll.
   *
   * Six channels land over a few seconds and, on a phone, the last of them can
   * be below the fold. A deck that lets its live strip arrive off screen is a
   * deck that has stopped being the reason you are looking at it. So each
   * arrival is scrolled the *minimum* distance to be visible (`block:
   * "nearest"` is a no-op when it already is), and the whole behaviour stops
   * the first time the operator scrolls for themselves: someone reading the
   * manifest while channel five lands has said, unambiguously, where they want
   * to be, and yanking them back to the traces would be the panel arguing with
   * them. It never turns itself back on — the same rule the walk log follows
   * for its tail, and for the same reason.
   */
  const following = React.useRef(true);
  const selfScrollUntil = React.useRef(0);

  /**
   * Adopt newly-arrived channels into the runtimes.
   *
   * The tone buffer is computed here — once per channel, on arrival — rather
   * than in the draw. It is the only allocation in this component's steady
   * state, it is six of them per scan, and doing it per frame instead would be
   * 120 RMS windows times six strips times sixty frames a second to produce
   * the identical answer every time.
   */
  React.useEffect(() => {
    if (!channels) return;
    const first = runtimes.current.every((r) => r.channel === null);
    let arrived = -1;
    for (const channel of channels) {
      const index = runtimes.current.findIndex((r) => r.joint === channel.joint);
      const rt = runtimes.current[index];
      if (!rt || rt.channel) continue;
      rt.channel = channel;
      rt.tones = new Uint8Array(channel.wave.length);
      writeSampleTones(channel.wave, channel.ref, rt.tones);
      // Everything present on the deck's first pass is replayed history, not a
      // channel arriving: it renders settled instead of performing a sweep the
      // operator already missed.
      rt.arrivedAt = first ? SEEDED : performance.now();
      rt.drawnProgress = -1;
      arrived = index;
    }

    // Replayed history is not an arrival, so a page reloaded mid-scan does not
    // scroll six times on mount.
    if (first || arrived < 0 || !revealArrivals || !following.current) return;
    const strip = stripEls.current[arrived];
    if (!strip) return;
    // Smooth scrolling emits its own scroll events for several frames; this
    // window is how they are told apart from the operator's.
    selfScrollUntil.current = performance.now() + 900;
    strip.scrollIntoView({
      block: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [channels, revealArrivals, reducedMotion]);

  /** Any scroll the deck did not cause hands the column over for good. */
  React.useEffect(() => {
    if (!revealArrivals) return;
    const onScroll = () => {
      if (performance.now() < selfScrollUntil.current) return;
      following.current = false;
    };
    // Capture, because the scrolling element is an ancestor (`.scan-grid`) and
    // scroll does not bubble.
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [revealArrivals]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    palette.current = readPalette(container);

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const rt = runtimes.current.find((r) => r.canvas === entry.target);
        if (!rt || !rt.canvas) continue;
        const { width, height } = entry.contentRect;
        const dpr = globalThis.devicePixelRatio || 1;
        if (width === rt.width && height === rt.height && dpr === rt.dpr) continue;
        rt.width = width;
        rt.height = height;
        rt.dpr = dpr;
        rt.canvas.width = Math.max(1, Math.round(width * dpr));
        rt.canvas.height = Math.max(1, Math.round(height * dpr));
        rt.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
        rt.drawnProgress = -1;
      }
    });
    for (const rt of runtimes.current) {
      if (rt.canvas) observer.observe(rt.canvas);
    }

    const stop = registerFrame((now) => {
      const pal = palette.current;
      // Which strip is still sweeping, and which was the last to arrive: two
      // cheap passes so the alpha tiers are decided once per frame, not per
      // strip, and never by asking the store.
      let newest: StripRuntime | null = null;
      for (const rt of runtimes.current) {
        if (rt.channel && (!newest || rt.arrivedAt > newest.arrivedAt)) newest = rt;
      }

      for (const rt of runtimes.current) {
        if (!rt.ctx || rt.width <= 0) continue;

        const progress = sweepProgress(rt, now);
        const alpha = intensity(rt, progress, newest, flagged.current);

        // The comparison that makes a settled board free: three numbers.
        if (
          progress === rt.drawnProgress &&
          alpha === rt.drawnAlpha &&
          rt.width === rt.drawnWidth
        ) {
          continue;
        }
        rt.drawnProgress = progress;
        rt.drawnAlpha = alpha;
        rt.drawnWidth = rt.width;
        drawStrip(rt, pal, progress, alpha);
      }
    });

    return () => {
      observer.disconnect();
      stop();
    };
  }, []);

  return (
    <div ref={containerRef} className="wave-deck">
      {JOINTS.map((joint, i) => (
        <div
          key={joint}
          data-joint={joint}
          ref={(el) => {
            stripEls.current[i] = el;
          }}
          className="wave-strip"
        >
          <div className="wave-strip__gutter">
            {/* Rotated, reading bottom-to-top, in amber — the brainwave ref's
                one direct quotation. */}
            <span className="wave-strip__name">{machineJoint(joint)}</span>
            <span className="wave-strip__ord tnum">{pad2(i + 1)}</span>
          </div>
          {/* The canvas is absolutely positioned inside this box rather than
              sized with height:100%. A canvas carries an intrinsic 300x150
              aspect ratio, and when a percentage height fails to resolve it
              silently falls back to that ratio — which here meant a 539px-wide
              strip drawing itself 269px tall inside a 58px row, six traces
              piled through each other. inset-0 against a definite box cannot
              do that, and takes the canvas out of flow so its intrinsic size
              can never influence layout again. */}
          <div className="relative overflow-hidden">
            <canvas
              aria-hidden
              ref={(el) => {
                const rt = runtimes.current[i];
                if (!rt) return;
                rt.canvas = el;
                rt.ctx = el?.getContext("2d") ?? null;
              }}
              className="absolute inset-0 block size-full"
            />
          </div>
        </div>
      ))}
      {/* The traces carry no text a screen reader could use; the log beside
          them prints every channel and its measured deviation, so that is the
          accessible copy of this panel rather than a summary invented here. */}
      <p className="sr-only">
        Six channel traces. Each channel&apos;s measurement is listed in the subsystem
        walk log.
      </p>
    </div>
  );
}

/** 0 → 1 across REVEAL_MS; seeded (replayed) channels start settled. */
function sweepProgress(rt: StripRuntime, now: number): number {
  if (!rt.channel) return -1;
  if (rt.arrivedAt === SEEDED) return 1;
  const p = (now - rt.arrivedAt) / REVEAL_MS;
  // Quantised to whole device-ish steps so a settled strip's progress compares
  // equal frame after frame instead of drifting in the last decimal.
  return p >= 1 ? 1 : Math.max(0, Math.round(p * 1000) / 1000);
}

function intensity(
  rt: StripRuntime,
  progress: number,
  newest: StripRuntime | null,
  flaggedJoint: string | null,
): number {
  if (!rt.channel) return 0;
  // A flagged channel does not dim. It is the reason the operator is here.
  if (flaggedJoint && rt.joint === flaggedJoint) return ALPHA_SWEEPING;
  if (progress < 1) return ALPHA_SWEEPING;
  return rt === newest ? ALPHA_NEWEST : ALPHA_SETTLED;
}

/**
 * One strip. Zero allocation: every value here is a number on the stack, the
 * sample arrays belong to the store, and the tone buffer belongs to the
 * runtime.
 */
function drawStrip(
  rt: StripRuntime,
  pal: StripPalette,
  progress: number,
  alpha: number,
): void {
  const ctx = rt.ctx;
  if (!ctx) return;
  const w = rt.width;
  const h = rt.height;

  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";
  ctx.globalAlpha = 1;

  // -- ruler ---------------------------------------------------------------
  // The brainwave ref's fine tick column, kept to the left edge and to the
  // amplitude axis: five ticks and a centre line, in grid, so the traces have
  // a datum without the box acquiring a chart's furniture.
  const mid = snap(h / 2, rt.dpr);
  ctx.strokeStyle = pal.grid;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  for (let t = 0; t <= 4; t += 1) {
    const y = snap(PAD_Y + (t / 4) * (h - 2 * PAD_Y), rt.dpr);
    ctx.moveTo(0, y);
    ctx.lineTo(t % 2 === 0 ? 5 : 3, y);
  }
  ctx.stroke();

  const channel = rt.channel;
  const tones = rt.tones;
  if (!channel || !tones || progress < 0) return;

  const wave = channel.wave;
  const ref = channel.ref;
  const n = Math.min(wave.length, ref.length);
  if (n < 2) return;

  const amp = h / 2 - PAD_Y;
  const stepX = w / (n - 1);
  const yOf = (v: number) => mid - v * amp;

  // -- reference ------------------------------------------------------------
  // Drawn whole and dim the instant the channel lands: this is the factory
  // calibration table, known before the robot moved. Having it already on
  // screen is what makes the live trace's divergence legible as it happens
  // rather than only in hindsight.
  ctx.globalAlpha = ALPHA_REF;
  ctx.strokeStyle = pal.ref;
  ctx.beginPath();
  for (let i = 0; i < n; i += 1) {
    const x = i * stepX;
    const y = yOf(ref[i] ?? 0);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // -- live trace, in runs of one tone --------------------------------------
  const head = progress * (n - 1);
  const last = Math.floor(head);
  ctx.globalAlpha = alpha;

  for (let tone = 0; tone < TONE_BY_INDEX.length; tone += 1) {
    ctx.strokeStyle = pal[TONE_BY_INDEX[tone] ?? "nominal"];
    ctx.beginPath();
    let open = false;
    for (let i = 1; i <= last; i += 1) {
      if (tones[i] !== tone) {
        open = false;
        continue;
      }
      if (!open) {
        ctx.moveTo((i - 1) * stepX, yOf(wave[i - 1] ?? 0));
        open = true;
      }
      ctx.lineTo(i * stepX, yOf(wave[i] ?? 0));
    }
    ctx.stroke();
  }

  if (progress >= 1) {
    ctx.globalAlpha = 1;
    return;
  }

  // -- the sweep head -------------------------------------------------------
  // The partial segment between the last whole sample and the cursor, so the
  // trace grows continuously instead of one sample-width at a time.
  const frac = head - last;
  const nextIdx = Math.min(last + 1, n - 1);
  const headX = (last + frac) * stepX;
  const headY = yOf(
    (wave[last] ?? 0) + ((wave[nextIdx] ?? 0) - (wave[last] ?? 0)) * frac,
  );
  if (last >= 0 && frac > 0) {
    ctx.strokeStyle = pal[TONE_BY_INDEX[tones[last] ?? 0] ?? "nominal"];
    ctx.beginPath();
    ctx.moveTo(last * stepX, yOf(wave[last] ?? 0));
    ctx.lineTo(headX, headY);
    ctx.stroke();
  }

  // The cursor: the brainwave ref's red rule, riding the head of the sweep.
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = pal.cursor;
  const cx = snap(headX, rt.dpr);
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, h);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Land a hairline on whole device rows; a half-pixel line is a smudge. */
const snap = (v: number, dpr: number) => Math.round(v * dpr) / dpr;

export { REVEAL_MS };

/** The panel header's meta: how many channels are in, and what is drawn. */
export function waveformDeckMeta(count: number): string {
  return `${pad2(count)}/${pad2(JOINTS.length)} · LIVE vs REF`;
}
