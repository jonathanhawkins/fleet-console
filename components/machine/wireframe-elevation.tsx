"use client";

import * as React from "react";
import { registerFrame } from "@/components/console";
import { cn } from "@/lib/utils";
import { type DiagChannel } from "@/lib/stores";
import { readToken, TOKEN_FALLBACK } from "@/lib/tokens/fallback";
import { parseWireframe } from "@/lib/wireframe/parse";
import { projectWireframe, type ProjectedFigure } from "@/lib/wireframe/project";
import {
  depthScale,
  LEVEL_ALPHA,
  LEVELS,
  levelFor,
  LIFT_BOOST,
  L_SKIP,
} from "@/lib/wireframe/tiers";
import { type WireframeData } from "@/lib/wireframe/types";

/**
 * The elevation, drawn from the model the robot is actually made of.
 *
 * `unit-silhouette.tsx` draws a *picture* of the machine — accurate, hand-set,
 * and authored by a person who decided where the knee goes. This draws the
 * machine: the same `chassis-silhouette.glb` the component viewer renders, reduced
 * offline to its feature edges (`scripts/extract-wireframe.mjs`), fetched as
 * ~16 KB of gzipped JSON and projected here by arithmetic. 2,404 segments, one
 * canvas, no three.js — machine space never pays the 250 KB the operator's
 * component view pays, because a line drawing does not need a renderer.
 *
 * That distinction is the whole point of the panel. A drawing of the knee is an
 * illustration of the claim; the model's own knee, turning, with its edges in
 * alert red the instant the flag lands, is the claim itself.
 *
 * ## What it is not
 *
 * It is not a hero. The board's job during the sweep belongs to the waveforms
 * and the manifest chips, and a bright spinning figure beside them would be a
 * second thing asking to be watched. So: no glow, no bloom, no fill, one pixel
 * of stroke, and the whole figure held a luminance tier *below* the manifest
 * text it sits next to (PRD §5 — hierarchy in machine space is luminance and
 * nothing else). It turns at 3°/s, which is slow enough that a reader notices
 * it has moved rather than notices it moving, and it stops entirely while the
 * operator's pointer is on it. Until the flag it is supporting cast. After the
 * flag it is the evidence, and it is the only red on the board.
 *
 * ## The turntable is also a control
 *
 * The reader can turn the figure themselves: pointer drag (mouse or touch)
 * scrubs the yaw directly, and with focus the arrow keys step it 15° — one
 * tessellation seam — per press, Home returning it to the front elevation.
 * The auto-turntable yields the whole time a reader is interacting (drag,
 * hover, focus) and resumes from wherever they left the figure, because a
 * drawing that snaps back after being positioned has decided the reader's
 * placement was a detour. Under `prefers-reduced-motion` the auto-turn never
 * runs, but manual rotation still works — the setting is a promise not to
 * animate at the reader, not a promise to ignore their hands.
 *
 * The events only accumulate a pending delta; the frame callback stays the one
 * writer `rt.yaw` has. A drag therefore costs nothing until the next frame,
 * coalesces however many pointermoves the browser delivers into one redraw,
 * and keeps the settled-frame guarantee: once the delta is consumed, frames go
 * back to one float comparison.
 *
 * ## Depth, without a depth buffer
 *
 * The first version drew all 1 990 edges at one alpha, and at an oblique yaw
 * that is not a drawing of a robot — it is felt. Every line weighs the same,
 * so the near arm, the torso and the far arm land on each other with nothing
 * to separate them, and a reader cannot even tell which way the figure is
 * pointing. Reported as exactly that: "hard to read when all the lines are on
 * top of each other… hard to know what direction is what".
 *
 * The fix is the one machine space is allowed to use, and the one it should
 * have used from the start: luminance. Each edge now carries the mean normal
 * of the faces it belongs to (format v2, `scripts/extract-wireframe.mjs`), and
 * `projectWireframe` reports, per edge per frame, how far that normal has
 * turned from the reader (`facing`) and how near the edge is (`depth`). Three
 * tiers fall out of it:
 *
 *   ghost    facing < -0.20 — the far side of every surface. Kept, at a seventh
 *            of base, because this is a see-through instrument and not a
 *            hidden-line drawing; it should read as a figure you can see
 *            through, not a figure with its back deleted.
 *   body     facing >  0.20 — the surface turned toward the reader, its alpha
 *            ramped by depth so a near limb sits in front of a far one.
 *   contour |facing| ≤ 0.20 — the silhouette, where the surface turns away
 *            exactly at the eye. This is the outline of the figure at every
 *            yaw, and it is the brightest thing on the drawing.
 *
 * Which is a lighting model that happens to have no light in it: a cylinder's
 * far seams vanish, its near seams hold, and the two seams at its edge burn —
 * so a limb reads as a tube, and an arm crossing a torso reads as being in
 * front of it. Colour never enters, because the only colour on this board is
 * the one that means the knee is broken.
 *
 * ## Frame discipline
 *
 * One `registerFrame` subscription (CLAUDE.md non-negotiable #3), and inside it
 * nothing allocates: the projector writes into a scratch `ProjectedFigure` held
 * here for the life of the mount, its options object is mutated rather than
 * rebuilt, and the tier buckets are typed arrays sized once per model shape.
 *
 * The tiers are drawn as one `beginPath`/`stroke` per LEVEL of a nine-step
 * alpha ladder (ghost, four depth bands of body, four of contour), dimmest
 * first, which is both the luminance order machine space wants and — within a
 * tier — painter order, far to near. There is no per-segment sort, because
 * quantizing depth into bands makes one unnecessary: every segment inside a
 * band is stroked in the same colour at the same alpha, and `src-over` of
 * identical colour and alpha is order-independent, so the only ordering that
 * can be seen is the ordering BETWEEN bands, which the ladder already is. The
 * bucketing itself is a counting sort — two sweeps of the segment list and a
 * nine-slot histogram, O(n), against O(n log n) for the sort it replaces.
 *
 * A frame in which neither the yaw nor the tint nor the box has changed does no
 * work at all, so a paused or reduced-motion figure costs one float comparison
 * per frame forever. Everything a tier depends on is a function of yaw alone,
 * so a pinned yaw redraws to the same bytes — which is what the reduced-motion
 * e2e assertion checks.
 *
 * Deliberately *not* consulted: `isDescentOccluded()`. That signal says the
 * descent surface is covering the operator page — this canvas lives on that
 * surface, so it is the occluder, never the occluded.
 */

/** Where the extracted edge set lives. Fetched lazily; never bundled. */
export const WIREFRAME_URL = "/models/chassis-wireframe.json";

/** Turntable rate. Slow on purpose — see the header. */
const YAW_RATE_RAD_S = (3 * Math.PI) / 180;

/** Drag scrubbing: ~0.02 rad per CSS px puts a half turn in a palm's width. */
const DRAG_RAD_PER_PX = 0.02;

/** Keyboard step: 15°, one azimuthal tessellation seam per press. */
const KEY_STEP_RAD = Math.PI / 12;

const TWO_PI = Math.PI * 2;

/** Inset kept clear of the box on every side, CSS px. */
const MARGIN = 6;

/** The subject module. It does not defer to anything, on any tier. */
const ALPHA_SUBJECT = 0.95;

/**
 * How the figure is currently drawing the joint the scan is about.
 *
 * The module the diagnostic singled out is always the one thing on this drawing
 * that ignores the depth ladder — but *which colour* it ignores it in is a fact
 * about the diagnosis, not about the drawing. It is `alert` from the flag
 * onward, and `nominal` once the machine's own re-measure has put the channel
 * back inside its envelope. A red limb under a verdict card reading CLEARED was
 * the last surface on this board still reporting a fault nobody has.
 *
 * Two values rather than a `restored` boolean, because the drawing does not
 * need to know what a recalibration is: it is told which token to stroke the
 * subject in, the way every other element in machine space is.
 */
export type SubjectTone = "alert" | "nominal";

/** Sweep-lift window, matched to the waveform deck's reveal. */
const LIFT_MS = 1400;

/**
 * The lift steps back down one ladder level per this many ms — a discrete
 * instrument cue on a diagnostic board rather than a fade, which also means
 * the value settles between steps and those frames do no work at all.
 */
const LIFT_STEP_MS = LIFT_MS / LIFT_BOOST;

/** Shared stand-in so the two classification sweeps can never disagree. */
const EMPTY = new Float32Array(0);

/** Sentinel: this channel was already history when the elevation mounted. */
const SEEDED = 0;

/**
 * Sentinel: a channel just landed and its lift window opens on the next frame.
 *
 * The channel effect cannot stamp a start time itself, because the only clock
 * the decay is ever measured against is the `now` the frame loop hands out —
 * under a browser that is the rAF timestamp, under a driven test loop it is
 * whatever the driver says. An effect-side `performance.now()` is a *second*
 * clock, equal to the first only by coincidence of both being the performance
 * timeline in production; measured against a driven loop the difference is
 * unbounded and the 1.4 s window never closes. So the effect records only that
 * the lift is pending, and the first frame to see it opens the window on its
 * own clock — which also aligns the decay's t=0 with the first frame that
 * actually draws the lift, at most one frame after the channel landed.
 */
const PENDING = -1;

/** Below this the anchor has not really moved; do not touch the leader line. */
const ANCHOR_EPSILON = 0.15;

/** Gap the leader line keeps between the figure's edge and its vertical run. */
const LEADER_CLEARANCE = 5;

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

let resolved: WireframeData | null = null;
let inFlight: Promise<WireframeData> | null = null;

/**
 * Fetch + validate the edge set, once per page.
 *
 * Module-scoped rather than per-mount because the board is reconstructed
 * whenever the session is (a mid-scan reload, a reconnect that replays the
 * emitted prefix): re-parsing 2,062 vertices on every remount to get the same
 * answer would be work with no output. A failure clears the cache so a later
 * mount may try again, and is otherwise silent — the SVG elevation is a
 * complete drawing, not an error state, so there is nothing to report.
 */
export function loadWireframe(): Promise<WireframeData> {
  // "no-cache" = always revalidate, never re-download unchanged bytes: the
  // server answers 304 against the ETag unless the file really changed.
  // The original "force-cache" pinned the FIRST wireframe a browser ever saw
  // forever — after the model was remodeled, the board kept drawing the old
  // robot while the GLB viewer (default fetch semantics) showed the new one.
  // User-hit 2026-08-24. One conditional request per page load is the cost.
  inFlight ??= fetch(WIREFRAME_URL, { cache: "no-cache" })
    .then((res) => {
      if (!res.ok) throw new Error(`chassis-wireframe: HTTP ${res.status}`);
      return res.json();
    })
    .then((json: unknown) => {
      const data = parseWireframe(json);
      resolved = data;
      return data;
    })
    .catch((error: unknown) => {
      inFlight = null;
      throw error;
    });
  return inFlight;
}

/** Drop the cache. Tests only — the app fetches once and keeps it. */
export function resetWireframeCacheForTests(): void {
  resolved = null;
  inFlight = null;
}

/**
 * The parsed model, or null while it is still coming (or if it never does).
 *
 * Seeded synchronously from the module cache so a board that remounts mid-scan
 * comes back with the wireframe already up — no flash of the SVG fallback on
 * the one frame a reader is most likely to be looking at it.
 */
export function useWireframeModel(): WireframeData | null {
  const [model, setModel] = React.useState<WireframeData | null>(() => resolved);

  React.useEffect(() => {
    if (model) return;
    let alive = true;
    loadWireframe().then(
      (data) => {
        if (alive) setModel(data);
      },
      () => {
        // Keep the SVG elevation. See loadWireframe.
      },
    );
    return () => {
      alive = false;
    };
  }, [model]);

  return model;
}

// ---------------------------------------------------------------------------
// Model geometry helpers (pure — tested directly)
// ---------------------------------------------------------------------------

/**
 * Which node of the model a wire joint belongs to.
 *
 * The extraction splits the two knee actuators out as their own nodes because
 * they are what the scan flags; a hip or an ankle has no module of its own, so
 * it resolves to the leg it is part of. Anything the model does not carry
 * resolves to null and simply does not tint.
 */
export function nodeNameForJoint(joint: string | null | undefined): string | null {
  if (!joint) return null;
  if (joint === "knee_L" || joint === "knee_R") {
    return `knee_actuator_${joint.slice(-1)}`;
  }
  if (joint.endsWith("_L")) return "leg_L";
  if (joint.endsWith("_R")) return "leg_R";
  return null;
}

/**
 * Index into `data.nodes` of the node a joint tints, or -1.
 *
 * Resolved once per (model, joint) rather than per frame: the draw wants an
 * integer to compare against, not a map lookup and a string compare 2,404
 * times a frame.
 */
export function nodeIndexForJoint(
  data: WireframeData | null,
  joint: string | null | undefined,
): number {
  if (!data) return -1;
  const name = nodeNameForJoint(joint);
  if (!name) return -1;
  const node = data.byName.get(name);
  return node ? data.nodes.indexOf(node) : -1;
}

/**
 * Centre of the projected bounding box of one node's segments, written into
 * `out`. Returns false for an empty segment list, leaving `out` untouched.
 *
 * This is where the magenta leader line points. The bbox centre rather than the
 * mean of the endpoints, because the endpoints are not evenly distributed
 * around the module — the actuator's ring of edges is dense at its rim — and a
 * centroid would sit visibly off-centre inside its own outline.
 */
export function segmentsBoxCenter(
  seg: Float32Array | undefined,
  out: { x: number; y: number },
): boolean {
  if (!seg || seg.length < 4) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < seg.length; i += 2) {
    const x = seg[i] ?? 0;
    const y = seg[i + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  out.x = (minX + maxX) / 2;
  out.y = (minY + maxY) / 2;
  return true;
}

/**
 * Where on its node a joint's leader line lands.
 *
 * A knee is its own module, so its box centre is the joint. A hip or an ankle
 * shares the leg node with the whole limb, and the middle of a shin is not an
 * ankle: the line lands in the band of the limb where the joint actually is —
 * the top of the leg for a hip, just above the foot for an ankle.
 */
export type AnchorSite = "center" | "top" | "bottom";

export function anchorSiteForJoint(joint: string | null | undefined): AnchorSite {
  if (!joint) return "center";
  if (joint.startsWith("ankle")) return "bottom";
  if (joint.startsWith("hip")) return "top";
  return "center";
}

/**
 * The joint bands as fractions of the node's projected height, measured from
 * the limb's end. A hip is at the very top of its leg; an ankle sits above the
 * foot, so its band starts a tenth of the way up.
 */
const SITE_BAND = {
  top: { near: 0, far: 0.14 },
  bottom: { near: 0.1, far: 0.24 },
} as const;

/**
 * The leader line's anchor for one node's segments, written into `out`:
 * the box centre for a module, or the centre of the joint band for a limb.
 * Falls back to the box centre when the band holds no endpoint.
 */
export function segmentsAnchor(
  seg: Float32Array | undefined,
  out: { x: number; y: number },
  site: AnchorSite,
): boolean {
  if (!segmentsBoxCenter(seg, out) || !seg) return false;
  if (site === "center") return true;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < seg.length; i += 2) {
    const y = seg[i] ?? 0;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const h = maxY - minY;
  if (h <= 0) return true;
  // Canvas y grows downward: "bottom" is the largest y.
  const band = SITE_BAND[site];
  const lo = site === "bottom" ? maxY - band.far * h : minY + band.near * h;
  const hi = site === "bottom" ? maxY - band.near * h : minY + band.far * h;
  let bMinX = Infinity;
  let bMaxX = -Infinity;
  let bMinY = Infinity;
  let bMaxY = -Infinity;
  for (let i = 0; i < seg.length; i += 2) {
    const y = seg[i + 1] ?? 0;
    if (y < lo || y > hi) continue;
    const x = seg[i] ?? 0;
    if (x < bMinX) bMinX = x;
    if (x > bMaxX) bMaxX = x;
    if (y < bMinY) bMinY = y;
    if (y > bMaxY) bMaxY = y;
  }
  if (bMinX === Infinity) return true;
  out.x = (bMinX + bMaxX) / 2;
  out.y = (bMinY + bMaxY) / 2;
  return true;
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export interface WireframeElevationProps {
  /** The parsed model. Callers render the SVG elevation until they have one. */
  data: WireframeData;
  /** Wire name of the flagged joint, e.g. "knee_L". Null before the flag. */
  damagedJoint?: string | null;
  /**
   * Which token the flagged module is drawn in — see {@link SubjectTone}.
   * Defaults to `alert`, which is what a flag means until something answers it.
   */
  subjectTone?: SubjectTone;
  /** Channels as the session holds them; the newest one lifts its node. */
  channels?: DiagChannel[];
  /** No auto-turn: a static front elevation until the reader rotates it. */
  reducedMotion?: boolean;
  /**
   * The flagged module's projected box centre, in CSS px within this canvas,
   * whenever it moves — plus `clearX`, the right edge of the whole figure at
   * this yaw. The board turns the first two into the leader line's anchor and
   * the third into the x it breaks out at, so the leader leaves the drawing
   * instead of being dragged across it.
   */
  onAnchorChange?: (x: number, y: number, clearX: number) => void;
  className?: string;
}

type Palette = { ink: string } & Record<SubjectTone, string>;

interface Runtime {
  ctx: CanvasRenderingContext2D | null;
  w: number;
  h: number;
  dpr: number;
  yaw: number;
  lastNow: number;
  fig: ProjectedFigure | null;
  /** Ladder level per global segment id, or L_SKIP. Sized per model shape. */
  level: Uint8Array;
  /** Segment ids bucketed by level, `(node << 16) | edge`. Same sizing. */
  order: Uint32Array;
  /** Nine-slot histogram and its exclusive prefix sum — the counting sort. */
  counts: Int32Array;
  starts: Int32Array;
  /** Right edge of everything drawn this frame, accumulated during the strokes. */
  maxX: number;
  /** -1 forces the next frame to draw. */
  drawnYaw: number;
  drawnFlag: number;
  /** The tone the subject was last stroked in; a change repaints. */
  drawnTone: SubjectTone | null;
  drawnLift: number;
  drawnBoost: number;
  drawnW: number;
  drawnH: number;
}

export function WireframeElevation({
  data,
  damagedJoint,
  subjectTone = "alert",
  channels,
  reducedMotion = false,
  onAnchorChange,
  className,
}: WireframeElevationProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const runtime = React.useRef<Runtime>({
    ctx: null,
    w: 0,
    h: 0,
    dpr: 1,
    yaw: 0,
    lastNow: 0,
    fig: null,
    level: new Uint8Array(0),
    order: new Uint32Array(0),
    counts: new Int32Array(LEVELS),
    starts: new Int32Array(LEVELS),
    maxX: 0,
    drawnYaw: Number.NaN,
    drawnFlag: -2,
    drawnTone: null,
    drawnLift: -2,
    drawnBoost: -1,
    drawnW: -1,
    drawnH: -1,
  });

  // Mutated in place every frame — see the frame-discipline note in the header.
  const opts = React.useRef({ yawRad: 0, viewport: { w: 0, h: 0 }, margin: MARGIN });
  const anchor = React.useRef({ x: 0, y: 0 });
  const reported = React.useRef({ x: 0, y: 0, set: false });
  // Before the canvas is sampled: the machine palette, where the figure lives.
  const palette = React.useRef<Palette>({
    ink: TOKEN_FALLBACK.machine["--ink"],
    alert: TOKEN_FALLBACK.machine["--alert"],
    nominal: TOKEN_FALLBACK.machine["--nominal"],
  });

  // Everything the frame callback reads, held in refs: it subscribes once, on
  // mount, and must never be torn down and rebuilt because a prop moved.
  const model = React.useRef(data);
  model.current = data;
  const paused = React.useRef(false);
  const reduced = React.useRef(reducedMotion);
  reduced.current = reducedMotion;
  /** User rotation not yet applied — the frame loop is yaw's only writer. */
  const pendingYaw = React.useRef(0);
  /** The pointer scrubbing the turntable, or null. */
  const drag = React.useRef<{ pointerId: number; lastX: number } | null>(null);
  /** aria-valuenow — updated per interaction, never per frame. */
  const [yawDeg, setYawDeg] = React.useState(0);
  const anchorCb = React.useRef(onAnchorChange);
  anchorCb.current = onAnchorChange;

  const flagIndex = React.useMemo(
    () => nodeIndexForJoint(data, damagedJoint),
    [data, damagedJoint],
  );
  const flagRef = React.useRef(flagIndex);
  flagRef.current = flagIndex;
  const siteRef = React.useRef(anchorSiteForJoint(damagedJoint));
  siteRef.current = anchorSiteForJoint(damagedJoint);
  // Read per frame, like the flag itself: the loop holds no props, and a tone
  // that arrives twenty seconds after mount must reach the next frame without
  // tearing the subscription down.
  const toneRef = React.useRef(subjectTone);
  toneRef.current = subjectTone;

  /**
   * Which node the sweep is currently on, and when it landed.
   *
   * Same adoption rule as the waveform deck: channels already present on the
   * first pass are replayed history and get no lift, because the sweep they
   * belong to happened before this panel existed. The lift is dropped entirely
   * once the flag is up — from that moment the figure has one thing to say.
   */
  const lift = React.useRef({ index: -1, at: SEEDED });
  const seen = React.useRef<Set<string> | null>(null);

  React.useEffect(() => {
    if (!channels) return;
    const first = seen.current === null;
    const set = seen.current ?? new Set<string>();
    seen.current = set;
    for (const channel of channels) {
      if (set.has(channel.joint)) continue;
      set.add(channel.joint);
      if (first) continue;
      const index = nodeIndexForJoint(model.current, channel.joint);
      if (index < 0) continue;
      lift.current.index = index;
      lift.current.at = PENDING; // the frame loop stamps its own clock — see PENDING
    }
  }, [channels]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rt = runtime.current;
    rt.ctx = canvas.getContext("2d");

    const style = getComputedStyle(canvas);
    // Both subject tones are sampled here, once, because the frame loop
    // subscribes on mount and must never be rebuilt because a prop moved: the
    // tone is chosen per frame from a palette that already holds both, rather
    // than by re-reading a token the day the outcome lands.
    palette.current = {
      ink: readToken(style, "--ink", "machine"),
      alert: readToken(style, "--alert", "machine"),
      nominal: readToken(style, "--nominal", "machine"),
    };

    const resize = (width: number, height: number) => {
      const dpr = globalThis.devicePixelRatio || 1;
      if (width === rt.w && height === rt.h && dpr === rt.dpr) return;
      rt.w = width;
      rt.h = height;
      rt.dpr = dpr;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      // A 1 CSS-px stroke is `dpr` device px wide. An odd device width lands
      // crisply on a half-pixel centre and blurs on a whole one; an even one is
      // the other way round. Half a device pixel of translation is the whole
      // difference between a line drawing and a smudge at dpr 1.
      const odd = Number.isInteger(dpr) && dpr % 2 === 1;
      rt.ctx?.setTransform(dpr, 0, 0, dpr, odd ? 0.5 : 0, odd ? 0.5 : 0);
      rt.drawnYaw = Number.NaN;
    };

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        resize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(canvas);
    // ResizeObserver's first callback is async; the box is measurable now, and
    // a board that flashes empty for one frame is a board that flickers on
    // every reconnect.
    resize(canvas.clientWidth, canvas.clientHeight);

    const stop = registerFrame((now) => {
      const dt = rt.lastNow === 0 ? 0 : Math.min(now - rt.lastNow, 100);
      rt.lastNow = now;

      const spun = pendingYaw.current;
      if (spun !== 0) {
        pendingYaw.current = 0;
        rt.yaw = (((rt.yaw + spun) % TWO_PI) + TWO_PI) % TWO_PI;
      } else if (!reduced.current && !paused.current && !drag.current) {
        // Reduced motion never auto-turns, but it keeps whatever yaw the
        // reader set by hand: with no interaction that is 0 forever, which is
        // what the byte-stability e2e assertion relies on.
        rt.yaw = (rt.yaw + (dt / 1000) * YAW_RATE_RAD_S) % TWO_PI;
      }

      const flagged = flagRef.current;
      const tone = toneRef.current;
      // The lift is a pre-flag courtesy; after it, the only tint is the module
      // that failed.
      let liftIndex = -1;
      let liftBoost = 0;
      if (flagged < 0 && lift.current.index >= 0 && lift.current.at !== SEEDED) {
        if (lift.current.at === PENDING) lift.current.at = now;
        const elapsed = now - lift.current.at;
        if (elapsed < LIFT_MS) {
          liftIndex = lift.current.index;
          // Integer levels, so a settled value compares equal frame after frame
          // and the lift costs nothing between its four steps.
          liftBoost = LIFT_BOOST - Math.floor(elapsed / LIFT_STEP_MS);
        }
      }

      if (
        rt.yaw === rt.drawnYaw &&
        flagged === rt.drawnFlag &&
        tone === rt.drawnTone &&
        liftIndex === rt.drawnLift &&
        liftBoost === rt.drawnBoost &&
        rt.w === rt.drawnW &&
        rt.h === rt.drawnH
      ) {
        return;
      }
      rt.drawnYaw = rt.yaw;
      rt.drawnFlag = flagged;
      rt.drawnTone = tone;
      rt.drawnLift = liftIndex;
      rt.drawnBoost = liftBoost;
      rt.drawnW = rt.w;
      rt.drawnH = rt.h;

      draw(
        rt,
        model.current,
        palette.current,
        flagged,
        tone,
        liftIndex,
        liftBoost,
        opts.current,
      );

      if (
        flagged >= 0 &&
        rt.fig &&
        segmentsAnchor(rt.fig.xy[flagged], anchor.current, siteRef.current)
      ) {
        const { x, y } = anchor.current;
        const last = reported.current;
        if (
          !last.set ||
          Math.abs(x - last.x) > ANCHOR_EPSILON ||
          Math.abs(y - last.y) > ANCHOR_EPSILON
        ) {
          last.x = x;
          last.y = y;
          last.set = true;
          anchorCb.current?.(x, y, rt.maxX + LEADER_CLEARANCE);
        }
      }
    });

    return () => {
      observer.disconnect();
      stop();
    };
  }, []);

  // The drawing's one sentence, and it follows the stroke. A reader told the
  // module is "marked damaged" beside a conclusion announcing the channel
  // restored is being handed the disagreement the picture no longer has.
  const label = damagedJoint
    ? `Unit elevation from the chassis model, ${damagedJoint.replace("_", " ")} marked ${
        subjectTone === "nominal" ? "restored" : "damaged"
      }`
    : "Unit elevation from the chassis model";

  /**
   * Refresh aria-valuenow from where the turntable will actually be once the
   * frame loop consumes what the interaction just queued. Called per discrete
   * interaction (key press, drag end) — never per frame, so the auto-turn
   * costs no renders.
   */
  const reportYaw = React.useCallback(() => {
    const target = runtime.current.yaw + pendingYaw.current;
    setYawDeg(((Math.round((target * 180) / Math.PI) % 360) + 360) % 360);
  }, []);

  return (
    <div
      data-slot="wireframe-elevation"
      // The figure is a control: a slider over yaw. Discrete interactions win
      // over the ambient turn — see "The turntable is also a control" above.
      role="slider"
      tabIndex={0}
      aria-label="Model turntable"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={359}
      aria-valuenow={yawDeg}
      aria-valuetext={`${yawDeg}° yaw — drag or use arrow keys to rotate`}
      className={cn(
        "cursor-grab touch-none outline-none select-none active:cursor-grabbing",
        "focus-visible:ring-2 focus-visible:ring-ring/70",
        className,
      )}
      // Hover holds the turntable still. Whoever put a pointer on the figure is
      // reading it, and a drawing that keeps turning under a reader is a
      // drawing that has decided its animation matters more than its content.
      // Touch is excluded: a tap would pause it permanently, since a finger
      // never leaves. (A touch DRAG still pauses, via `drag`, and releases.)
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") paused.current = true;
      }}
      onPointerLeave={() => {
        paused.current = false;
      }}
      onPointerCancel={(e) => {
        if (drag.current?.pointerId === e.pointerId) drag.current = null;
        paused.current = false;
      }}
      onFocusCapture={() => {
        paused.current = true;
      }}
      onBlurCapture={() => {
        paused.current = false;
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        drag.current = { pointerId: e.pointerId, lastX: e.clientX };
        // Capture keeps the scrub alive outside the box; jsdom's stub throws
        // on synthetic pointer ids, and losing capture is not losing the drag.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* no capture — the drag still works inside the box */
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || e.pointerId !== d.pointerId) return;
        // Dragging right pulls the near face right: positive yaw. The delta
        // only accumulates here; the frame loop applies it (single writer).
        pendingYaw.current += (e.clientX - d.lastX) * DRAG_RAD_PER_PX;
        d.lastX = e.clientX;
      }}
      onPointerUp={(e) => {
        if (drag.current?.pointerId !== e.pointerId) return;
        drag.current = null;
        reportYaw();
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowUp") {
          pendingYaw.current += KEY_STEP_RAD;
        } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
          pendingYaw.current -= KEY_STEP_RAD;
        } else if (e.key === "Home") {
          // Back to the front elevation, exactly: cancel whatever is queued
          // and retire the yaw the loop has already applied.
          pendingYaw.current = -runtime.current.yaw;
        } else {
          return;
        }
        e.preventDefault();
        reportYaw();
      }}
    >
      <canvas ref={canvasRef} role="img" aria-label={label} className="block size-full" />
    </div>
  );
}

/**
 * One frame: project, bucket every segment onto the luminance ladder, then one
 * `beginPath`/`stroke` per occupied level, dimmest first — so the flagged
 * module composites over whatever crosses it rather than under. Nothing in
 * here allocates once the model's shape has been seen.
 */
function draw(
  rt: Runtime,
  data: WireframeData,
  pal: Palette,
  flagged: number,
  tone: SubjectTone,
  liftIndex: number,
  liftBoost: number,
  opts: { yawRad: number; viewport: { w: number; h: number }; margin: number },
): void {
  const ctx = rt.ctx;
  if (!ctx || rt.w <= 0 || rt.h <= 0) return;
  if (rt.w <= 2 * MARGIN || rt.h <= 2 * MARGIN) return;

  opts.yawRad = rt.yaw;
  opts.viewport.w = rt.w;
  opts.viewport.h = rt.h;
  const fig = projectWireframe(data, opts, rt.fig ?? undefined);
  rt.fig = fig;

  const total = fig.segmentCount;
  if (rt.level.length !== total) {
    rt.level = new Uint8Array(total);
    rt.order = new Uint32Array(total);
  }
  const level = rt.level;
  const order = rt.order;
  const counts = rt.counts;
  const starts = rt.starts;
  counts.fill(0);

  const dMin = fig.depthMin;
  const dScale = depthScale(dMin, fig.depthMax);
  const nodeCount = fig.xy.length;

  // --- sweep 1: classify, and histogram the ladder --------------------------
  // Both sweeps walk the same node-major sequence and derive the global
  // segment id `g` from it, so they must agree on every node's length — hence
  // the shared `?? EMPTY` rather than a `continue` that would desynchronise
  // them if the projector ever handed back a half-built figure.
  let g = 0;
  for (let n = 0; n < nodeCount; n += 1) {
    const face = fig.facing[n] ?? EMPTY;
    const deep = fig.depth[n] ?? EMPTY;
    const count = face.length;
    if (n === flagged) {
      // Drawn last, in alert, at full strength. It never recedes, never
      // ghosts, and never joins a depth band: the one thing on this board
      // that is allowed to ignore which way it is pointing.
      for (let i = 0; i < count; i += 1, g += 1) level[g] = L_SKIP;
      continue;
    }
    const boost = n === liftIndex ? liftBoost : 0;
    for (let i = 0; i < count; i += 1, g += 1) {
      const lv = levelFor(face[i] ?? 0, deep[i] ?? 0, dMin, dScale, boost);
      level[g] = lv;
      counts[lv] = (counts[lv] ?? 0) + 1;
    }
  }

  // --- exclusive prefix sum over nine slots ---------------------------------
  let acc = 0;
  for (let l = 0; l < LEVELS; l += 1) {
    starts[l] = acc;
    acc += counts[l] ?? 0;
  }

  // --- sweep 2: scatter into level order ------------------------------------
  // `starts` is left intact for the draw; the cursor rides in `order` itself
  // via a second local walk of the same node-major sequence that built it.
  g = 0;
  for (let n = 0; n < nodeCount; n += 1) {
    const count = (fig.facing[n] ?? EMPTY).length;
    for (let i = 0; i < count; i += 1, g += 1) {
      const lv = level[g] ?? L_SKIP;
      if (lv === L_SKIP) continue;
      const at = starts[lv] ?? 0;
      starts[lv] = at + 1;
      order[at] = (n << 16) | i;
    }
  }
  // starts[l] now points one past level l's last slot: rewind it to the head.
  for (let l = 0; l < LEVELS; l += 1) starts[l] = (starts[l] ?? 0) - (counts[l] ?? 0);

  // --- draw ------------------------------------------------------------------
  ctx.clearRect(0, 0, rt.w, rt.h);
  ctx.lineWidth = 1;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.strokeStyle = pal.ink;
  let maxX = 0;

  for (let l = 0; l < LEVELS; l += 1) {
    const count = counts[l] ?? 0;
    if (count === 0) continue;
    const from = starts[l] ?? 0;
    const to = from + count;
    ctx.globalAlpha = LEVEL_ALPHA[l] ?? 1;
    ctx.beginPath();
    for (let k = from; k < to; k += 1) {
      const packed = order[k] ?? 0;
      const seg = fig.xy[packed >>> 16];
      if (!seg) continue;
      const o = (packed & 0xffff) * 4;
      const x0 = seg[o] ?? 0;
      const x1 = seg[o + 2] ?? 0;
      if (x0 > maxX) maxX = x0;
      if (x1 > maxX) maxX = x1;
      ctx.moveTo(x0, seg[o + 1] ?? 0);
      ctx.lineTo(x1, seg[o + 3] ?? 0);
    }
    ctx.stroke();
  }

  rt.maxX = maxX;
  if (flagged >= 0) {
    // The subject's own token, chosen by the caller. The module is still drawn
    // last and still ignores the ladder — being *restored* does not make it one
    // of the fourteen things nobody looked at.
    ctx.strokeStyle = pal[tone];
    ctx.globalAlpha = ALPHA_SUBJECT;
    ctx.beginPath();
    path(ctx, fig.xy[flagged], rt);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

/**
 * Append one node's quads to the open path, tracking the figure's right edge
 * as it goes — the leader line needs it, and this loop already has every x in
 * a register.
 */
function path(
  ctx: CanvasRenderingContext2D,
  seg: Float32Array | undefined,
  rt: Runtime,
): void {
  if (!seg) return;
  let max = rt.maxX;
  for (let i = 0; i < seg.length; i += 4) {
    const x0 = seg[i] ?? 0;
    const x1 = seg[i + 2] ?? 0;
    if (x0 > max) max = x0;
    if (x1 > max) max = x1;
    ctx.moveTo(x0, seg[i + 1] ?? 0);
    ctx.lineTo(x1, seg[i + 3] ?? 0);
  }
  rt.maxX = max;
}
