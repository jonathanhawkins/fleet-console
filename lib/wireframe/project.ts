import { type WireframeData } from "./types";

/**
 * Orthographic front projection of a parsed chassis-wireframe (format: types.ts)
 * into 2D canvas segments — the per-frame half of drawing the robot model in
 * machine space without three.js. Pure math, no DOM, no deps.
 *
 * Projection contract
 * -------------------
 * - Yaw rotates the model about the vertical (+Y) axis through the bbox
 *   center — a turntable, not a rotation about the world origin — so the
 *   figure stays centered while it spins. Positive yaw is right-handed about
 *   +Y: the robot's front (+Z) swings toward +screen-x.
 * - After rotation, z is dropped from the drawing but KEPT as `depth`:
 *   screen x from rotated x, screen y from world y, y-DOWN canvas coordinates
 *   (world up = screen up). The viewer sits at +z, so a LARGER depth is
 *   nearer the reader.
 * - Fit: one uniform scale (aspect preserved) chosen so the bbox's swept
 *   cylinder — horizontal radius hypot(hx, hz) about the turntable axis,
 *   full bbox height — fits the viewport inside `margin` on every side.
 *   Because the swept bound is yaw-invariant, the scale never changes as the
 *   model spins (no zoom pulsing on the shared frame loop) and every
 *   in-bbox vertex projects inside the margin box at EVERY yaw (within
 *   float32 rounding).
 *
 * Facing and depth: what they are for
 * -----------------------------------
 * An orthographic line drawing of a solid has no depth information at all —
 * every edge is one pixel of the same green, so at an oblique yaw the near
 * arm, the far arm and the torso between them arrive as one mat and the
 * reader cannot tell which way the figure is pointing. Machine space is not
 * allowed to fix that with glow or colour (PRD §5: hierarchy is luminance),
 * so it fixes it with *classification*, and this file computes the two
 * numbers the classification needs:
 *
 *   facing = dot(yaw-rotated edge normal, view +z)
 *            +1 straight at the reader, 0 at the silhouette, -1 turned away
 *   depth  = mean yaw-rotated z of the two endpoints, in metres
 *            larger = nearer; `depthMin`/`depthMax` bound the frame
 *
 * The renderer turns those into luminance tiers (back-facing edges recede,
 * front-facing edges brighten with nearness, the silhouette is brightest).
 * Deliberately NOT done here: choosing thresholds or alphas. Those are a
 * drawing decision and live with the drawing, in
 * components/machine/wireframe-elevation.tsx.
 *
 * Note both are computed from the SAME rotation as the screen coordinates, so
 * a fixed yaw produces bit-identical output frame after frame — which is what
 * lets the reduced-motion e2e assertion compare two canvas reads for byte
 * equality a second apart.
 *
 * Scratch discipline (same pattern as lib/stores/ringBuffer.copyInto)
 * -------------------------------------------------------------------
 * This runs every frame on the shared rAF loop, so the output must not be
 * reallocated per call: the drawing surface allocates ONE ProjectedFigure by
 * calling once without `out`, then passes it back every frame. While the data
 * keeps its shape, repeated calls allocate nothing and return the same arrays
 * (same identities). If the shape changes — e.g. a re-extracted
 * chassis-wireframe.json is hot-swapped in with different node/edge counts — only
 * the stale arrays are replaced; passing an old scratch with new data is
 * always safe.
 *
 * Output layout
 * -------------
 * Three parallel per-node lists, each aligned with `data.nodes` by index, plus
 * a flat index that walks every segment in the figure at once:
 *
 *   xy[n]      nodes[n].edgeCount quads [x0, y0, x1, y1, ...]  (4 floats/seg)
 *   facing[n]  nodes[n].edgeCount scalars                      (1 float/seg)
 *   depth[n]   nodes[n].edgeCount scalars                      (1 float/seg)
 *
 * Parallel arrays rather than one interleaved stride because the renderer's
 * hot loop reads facing and depth for EVERY segment but the coordinates only
 * for the ones it is about to stroke; splitting them keeps the classification
 * sweep over two tight scalar arrays instead of striding past four floats it
 * does not want yet.
 *
 * `nodeOf` / `localOf` are the flat index: for a global segment id
 * g ∈ [0, segmentCount), `nodeOf[g]` is its node and `localOf[g]` its index
 * within that node, so its coordinates start at `xy[nodeOf[g]][localOf[g]*4]`
 * and its facing is `facing[nodeOf[g]][localOf[g]]`. Global ids are assigned
 * node-major in `data.nodes` order. They exist so the renderer can bucket the
 * whole figure by luminance in one sweep — depth ordering is global, and a
 * far edge of the near leg must sort behind a near edge of the far one. They
 * depend only on the model's SHAPE, so they are rebuilt on a hot swap and
 * never per frame.
 *
 * Look up tint targets (e.g. "knee_actuator_L") via data.byName /
 * data.nodes indexOf once, not per frame.
 */

export interface ProjectOptions {
  /** Turntable angle in radians; positive swings the robot's front toward +x. */
  yawRad: number;
  /** Destination canvas size in px. */
  viewport: { w: number; h: number };
  /** Inset in px kept clear on every side of the viewport. */
  margin: number;
}

/** Per-node segment coordinate lists, aligned with WireframeData.nodes. */
export type ProjectedSegments = Float32Array[];

/** One projected frame. See the output-layout note above. */
export interface ProjectedFigure {
  /** Per node: edgeCount quads [x0, y0, x1, y1, ...], canvas px, y-down. */
  xy: ProjectedSegments;
  /** Per node: edgeCount facings, dot(rotated normal, view +z) ∈ [-1, 1]. */
  facing: Float32Array[];
  /** Per node: edgeCount depths, mean rotated z in metres; larger = nearer. */
  depth: Float32Array[];
  /** Total segments across every node — the length of nodeOf and localOf. */
  segmentCount: number;
  /** Global segment id → index into `xy`/`facing`/`depth`. */
  nodeOf: Uint16Array;
  /** Global segment id → its segment index inside its own node. */
  localOf: Uint32Array;
  /** Smallest `depth` in the frame (0 when the figure has no segments). */
  depthMin: number;
  /** Largest `depth` in the frame (0 when the figure has no segments). */
  depthMax: number;
}

/** Rebuild the flat index. Shape-only, so this runs on a hot swap, not a frame. */
function reindex(fig: ProjectedFigure, data: WireframeData): void {
  let total = 0;
  for (const node of data.nodes) total += node.edgeCount;
  if (fig.nodeOf.length !== total) {
    fig.nodeOf = new Uint16Array(total);
    fig.localOf = new Uint32Array(total);
  }
  let g = 0;
  for (let n = 0; n < data.nodes.length; n += 1) {
    const count = data.nodes[n]?.edgeCount ?? 0;
    for (let e = 0; e < count; e += 1) {
      fig.nodeOf[g] = n;
      fig.localOf[g] = e;
      g += 1;
    }
  }
  fig.segmentCount = total;
}

/**
 * Project every node's edges into y-down canvas segments, with the facing and
 * depth of each.
 *
 * Pass the previous return value as `out` to reuse its buffers (see the
 * scratch-discipline note above); the same object is mutated and returned.
 * Throws RangeError when the viewport minus margins has no positive area.
 */
export function projectWireframe(
  data: WireframeData,
  opts: ProjectOptions,
  out?: ProjectedFigure,
): ProjectedFigure {
  const { w, h } = opts.viewport;
  const margin = opts.margin;
  const innerW = w - 2 * margin;
  const innerH = h - 2 * margin;
  if (!(margin >= 0) || !(innerW > 0) || !(innerH > 0)) {
    throw new RangeError(
      `projectWireframe: viewport ${w}x${h} with margin ${margin} leaves no drawable area`,
    );
  }

  const { min, max } = data.bbox;
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const sweptR = Math.hypot((max[0] - min[0]) / 2, (max[2] - min[2]) / 2);
  const ey = max[1] - min[1];

  // Uniform yaw-invariant fit (see header). Degenerate axes (extent 0) put
  // no constraint on the scale; a fully degenerate bbox collapses to center.
  const sx = sweptR > 0 ? innerW / (2 * sweptR) : Infinity;
  const sy = ey > 0 ? innerH / ey : Infinity;
  let s = Math.min(sx, sy);
  if (!Number.isFinite(s)) s = 0;

  const cos = Math.cos(opts.yawRad);
  const sin = Math.sin(opts.yawRad);
  const midX = w / 2;
  const midY = h / 2;

  const nodes = data.nodes;
  const fig: ProjectedFigure = out ?? {
    xy: [],
    facing: [],
    depth: [],
    segmentCount: -1,
    nodeOf: new Uint16Array(0),
    localOf: new Uint32Array(0),
    depthMin: 0,
    depthMax: 0,
  };
  let depthMin = Infinity;
  let depthMax = -Infinity;
  let shapeChanged = fig.segmentCount < 0;

  if (fig.xy.length !== nodes.length) {
    fig.xy.length = nodes.length;
    fig.facing.length = nodes.length;
    fig.depth.length = nodes.length;
    shapeChanged = true; // a SHRINK leaves every survivor the right size
  }

  for (let n = 0; n < nodes.length; n += 1) {
    const node = nodes[n];
    if (!node) continue; // unreachable: n < nodes.length
    const count = node.edgeCount;
    let seg = fig.xy[n];
    let face = fig.facing[n];
    let deep = fig.depth[n];
    if (!seg || seg.length !== count * 4 || !face || !deep) {
      seg = new Float32Array(count * 4);
      face = new Float32Array(count);
      deep = new Float32Array(count);
      fig.xy[n] = seg;
      fig.facing[n] = face;
      fig.depth[n] = deep;
      shapeChanged = true;
    }
    const pos = node.positions;
    const edges = node.edges;
    const norms = node.normals;
    let o = 0;
    for (let e = 0; e < count; e += 1) {
      const i3 = (edges[e * 2] ?? 0) * 3;
      const j3 = (edges[e * 2 + 1] ?? 0) * 3;
      const dxi = (pos[i3] ?? 0) - cx;
      const dzi = (pos[i3 + 2] ?? 0) - cz;
      const dxj = (pos[j3] ?? 0) - cx;
      const dzj = (pos[j3 + 2] ?? 0) - cz;
      seg[o] = midX + (dxi * cos + dzi * sin) * s;
      seg[o + 1] = midY - ((pos[i3 + 1] ?? 0) - cy) * s;
      seg[o + 2] = midX + (dxj * cos + dzj * sin) * s;
      seg[o + 3] = midY - ((pos[j3 + 1] ?? 0) - cy) * s;
      o += 4;
      // Right-handed yaw about +Y: x' = x·cos + z·sin, z' = z·cos - x·sin.
      // The screen x above is the first half of that; this is the second,
      // applied to the edge midpoint (depth) and to its unit normal (facing).
      const zi = dzi * cos - dxi * sin;
      const zj = dzj * cos - dxj * sin;
      deep[e] = (zi + zj) / 2;
      // Read the value BACK out of the Float32Array before bounding it. The
      // mean was computed in float64 and storing it rounds, so a min tracked
      // from the unrounded number can sit a few ULPs above the number the
      // renderer will actually read — which would push that one segment's
      // depth ramp slightly negative. Bounding the stored value makes
      // "depthMin/depthMax bracket every depth" exactly true.
      const d = deep[e] ?? 0;
      if (d < depthMin) depthMin = d;
      if (d > depthMax) depthMax = d;
      const n3 = e * 3;
      face[e] = (norms[n3 + 2] ?? 0) * cos - (norms[n3] ?? 0) * sin;
    }
  }

  if (shapeChanged) reindex(fig, data);
  fig.depthMin = depthMin === Infinity ? 0 : depthMin;
  fig.depthMax = depthMax === -Infinity ? 0 : depthMax;

  return fig;
}
