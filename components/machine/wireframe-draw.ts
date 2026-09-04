import { projectWireframe, type ProjectedFigure } from "@/lib/wireframe/project";
import { depthScale, LEVEL_ALPHA, LEVELS, levelFor, L_SKIP } from "@/lib/wireframe/tiers";
import { type WireframeData } from "@/lib/wireframe/types";

/**
 * The painter: one canvas frame of the elevation, and the scratch state it
 * paints through.
 *
 * Nothing here is React. `Runtime` is a mutable box the component allocates
 * once per mount and hands back every frame, which is what lets the draw path
 * stay allocation-free once the model's shape has been seen.
 */

/** The subject module. It does not defer to anything, on any tier. */
const ALPHA_SUBJECT = 0.95;

/** Shared stand-in so the two classification sweeps can never disagree. */
const EMPTY = new Float32Array(0);

/** Inset kept clear of the box on every side, CSS px. */
export const MARGIN = 6;

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

export type Palette = { ink: string } & Record<SubjectTone, string>;

export interface Runtime {
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

/**
 * One frame: project, bucket every segment onto the luminance ladder, then one
 * `beginPath`/`stroke` per occupied level, dimmest first — so the flagged
 * module composites over whatever crosses it rather than under. Nothing in
 * here allocates once the model's shape has been seen.
 */
export function draw(
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
