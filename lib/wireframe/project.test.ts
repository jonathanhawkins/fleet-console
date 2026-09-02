// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWireframe } from "./parse";
import {
  projectWireframe,
  type ProjectedFigure,
  type ProjectedSegments,
  type ProjectOptions,
} from "./project";
import { type WireframeData, type WireframeJson } from "./types";

/**
 * Everything here is derived from whatever chassis-wireframe.json is on disk at
 * run time — the model is re-extracted when chassis-silhouette.glb changes, so no
 * vertex/edge counts are hardcoded. The only model-shaped expectations are
 * the two stable ones: yaw-0 x-mirror symmetry of head/torso and the left
 * knee actuator living inside leg_L's x-band, both with a generous tolerance
 * (6% of the projected figure width).
 *
 * The facing/depth half is asserted the same way: as *invariants* of the
 * rotation (a yaw and its opposite negate each other; the range brackets every
 * segment; a closed body faces both ways at once) plus a synthetic model whose
 * normals are exact axes, so "front-facing at yaw 0, back-facing at yaw 180"
 * is pinned to arithmetic rather than to this particular robot.
 */
const ASSET_URL = new URL("../../public/models/chassis-wireframe.json", import.meta.url);
const data = parseWireframe(JSON.parse(readFileSync(ASSET_URL, "utf8")));

const VIEW = { w: 300, h: 460 } as const;
const MARGIN = 12;
const SHAPE_TOLERANCE = 0.06; // of projected figure width — generous on purpose

const opts = (yawRad: number, margin: number = MARGIN): ProjectOptions => ({
  yawRad,
  viewport: { w: VIEW.w, h: VIEW.h },
  margin,
});

function must<T>(value: T | undefined, what = "value"): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}

const node = (name: string) => must(data.byName.get(name), name);
const nodeIndex = (name: string): number => data.nodes.indexOf(node(name));
const segmentsOf = (res: ProjectedSegments, name: string): Float32Array =>
  must(res[nodeIndex(name)], `segments for ${name}`);

/** Screen-space extremes over every endpoint (NaN/Infinity poison the result). */
function bounds(res: ProjectedSegments) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let finite = true;
  for (const seg of res) {
    for (let i = 0; i < seg.length; i += 2) {
      const x = seg[i] ?? Number.NaN;
      const y = seg[i + 1] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) finite = false;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, maxX, minY, maxY, finite };
}

function xRange(seg: Float32Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < seg.length; i += 2) {
    const x = seg[i] ?? Number.NaN;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return { min, max };
}

/** World-space extremes over the vertices actually referenced by edges. */
function drawnWorldExtents(d: WireframeData) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of d.nodes) {
    for (const vi of n.edges) {
      const x = n.positions[vi * 3] ?? Number.NaN;
      const y = n.positions[vi * 3 + 1] ?? Number.NaN;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, maxX, minY, maxY };
}

/**
 * One-sided Hausdorff distance between a node's endpoints and their mirror
 * image about the node's own x midrange: ~0 for an x-symmetric part.
 */
function mirrorMisfit(seg: Float32Array): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < seg.length; i += 2) {
    xs.push(seg[i] ?? Number.NaN);
    ys.push(seg[i + 1] ?? Number.NaN);
  }
  const { min, max } = xRange(seg);
  const mid = (min + max) / 2;
  let worst = 0;
  for (let a = 0; a < xs.length; a += 1) {
    const tx = 2 * mid - (xs[a] ?? Number.NaN);
    const ty = ys[a] ?? Number.NaN;
    let best = Infinity;
    for (let b = 0; b < xs.length; b += 1) {
      const dx = tx - (xs[b] ?? Number.NaN);
      const dy = ty - (ys[b] ?? Number.NaN);
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    if (best > worst) worst = best;
  }
  return Math.sqrt(worst);
}

/** Every segment's facing (or depth), flattened in global-id order. */
function flatten(fig: ProjectedFigure, which: "facing" | "depth"): number[] {
  const out: number[] = [];
  for (const arr of fig[which]) for (const v of arr) out.push(v);
  return out;
}

const frontFig = projectWireframe(data, opts(0));
const front = frontFig.xy;
const frontBounds = bounds(front);
const figureWidth = frontBounds.maxX - frontBounds.minX;

/** A second, tiny model (different node/edge shape) for hot-swap tests. */
const tinyDoc: WireframeJson = {
  v: 2,
  bbox: { min: [-1, 0, -1], max: [1, 2, 1] },
  nodes: [
    {
      name: "probe",
      vertexCount: 3,
      positions: [0, 0, 0, 32767, 32767, 32767, 16384, 16384, 16384],
      edges: [0, 1, 1, 2],
      normals: [0, 0, 127, 127, 0, 0],
    },
  ],
};

/**
 * Three edges with exact axis normals: +z (the robot's front), -z (its back)
 * and +x (its left flank). Positions are irrelevant to facing, so they are
 * whatever keeps the document valid.
 */
const axisDoc: WireframeJson = {
  v: 2,
  bbox: { min: [-1, 0, -1], max: [1, 2, 1] },
  nodes: [
    {
      name: "axes",
      vertexCount: 4,
      positions: [0, 0, 0, 32767, 0, 0, 0, 32767, 0, 0, 0, 32767],
      edges: [0, 1, 1, 2, 2, 3],
      normals: [0, 0, 127, 0, 0, -127, 127, 0, 0],
    },
  ],
};
const axes = parseWireframe(axisDoc);
const facingAt = (yawRad: number): number[] =>
  Array.from(must(projectWireframe(axes, opts(yawRad)).facing[0], "axis facings"));

describe("projectWireframe: output shape", () => {
  it("returns one segment list per node, one [x0,y0,x1,y1] quad per edge", () => {
    expect(front.length).toBe(data.nodes.length);
    for (let i = 0; i < data.nodes.length; i += 1) {
      const n = must(data.nodes[i], `node ${i}`);
      expect(must(front[i], `segments ${i}`).length).toBe(n.edgeCount * 4);
    }
  });

  it("returns one facing and one depth per edge, aligned with the quads", () => {
    for (let i = 0; i < data.nodes.length; i += 1) {
      const n = must(data.nodes[i], `node ${i}`);
      expect(must(frontFig.facing[i], `facing ${i}`).length).toBe(n.edgeCount);
      expect(must(frontFig.depth[i], `depth ${i}`).length).toBe(n.edgeCount);
    }
  });

  it("produces only finite coordinates and a non-degenerate figure", () => {
    expect(frontBounds.finite).toBe(true);
    expect(figureWidth).toBeGreaterThan(0);
    expect(frontBounds.maxY - frontBounds.minY).toBeGreaterThan(0);
  });

  it("throws RangeError when the margin leaves no drawable area", () => {
    expect(() =>
      projectWireframe(data, { yawRad: 0, viewport: { w: 100, h: 200 }, margin: 50 }),
    ).toThrow(RangeError);
    expect(() => projectWireframe(data, opts(0, -1))).toThrow(RangeError);
  });
});

describe("projectWireframe: fit and orientation", () => {
  it("stays inside the margin box at every yaw and margin", () => {
    const yaws = [-2.7, 0, 0.35, Math.PI / 4, 1.2, Math.PI / 2, 2.0, Math.PI, 4.2, 5.9];
    const eps = 1e-3; // float32 storage noise in px
    let scratch: ProjectedFigure | undefined;
    for (const margin of [0, MARGIN, 40]) {
      for (const yaw of yaws) {
        scratch = projectWireframe(data, opts(yaw, margin), scratch);
        const b = bounds(scratch.xy);
        expect(b.finite).toBe(true);
        expect(b.minX).toBeGreaterThanOrEqual(margin - eps);
        expect(b.maxX).toBeLessThanOrEqual(VIEW.w - margin + eps);
        expect(b.minY).toBeGreaterThanOrEqual(margin - eps);
        expect(b.maxY).toBeLessThanOrEqual(VIEW.h - margin + eps);
      }
    }
  });

  it("scales both axes uniformly (aspect preserved) and fills the binding axis", () => {
    const world = drawnWorldExtents(data);
    const scaleX = (frontBounds.maxX - frontBounds.minX) / (world.maxX - world.minX);
    const scaleY = (frontBounds.maxY - frontBounds.minY) / (world.maxY - world.minY);
    expect(scaleX).toBeGreaterThan(0);
    expect(Math.abs(scaleX / scaleY - 1)).toBeLessThan(1e-3);

    const fillX = (frontBounds.maxX - frontBounds.minX) / (VIEW.w - 2 * MARGIN);
    const fillY = (frontBounds.maxY - frontBounds.minY) / (VIEW.h - 2 * MARGIN);
    // The drawn wireframe can sit slightly inside the bbox (decimated smooth
    // caps), so "fills" is asserted generously.
    expect(Math.max(fillX, fillY)).toBeGreaterThan(0.8);
    expect(Math.max(fillX, fillY)).toBeLessThanOrEqual(1 + 1e-6);
  });

  it("maps world +y up to canvas y-down and world +x to screen right at yaw 0", () => {
    let topWorldY = -Infinity;
    let topScreenY = Number.NaN;
    let bottomWorldY = Infinity;
    let bottomScreenY = Number.NaN;
    let rightWorldX = -Infinity;
    let rightScreenX = Number.NaN;
    let leftWorldX = Infinity;
    let leftScreenX = Number.NaN;
    for (let n = 0; n < data.nodes.length; n += 1) {
      const wf = must(data.nodes[n], `node ${n}`);
      const seg = must(front[n], `segments ${n}`);
      for (let e = 0; e < wf.edges.length; e += 1) {
        const vi = wf.edges[e] ?? 0;
        const wx = wf.positions[vi * 3] ?? Number.NaN;
        const wy = wf.positions[vi * 3 + 1] ?? Number.NaN;
        const sx = seg[e * 2] ?? Number.NaN;
        const sy = seg[e * 2 + 1] ?? Number.NaN;
        if (wy > topWorldY) {
          topWorldY = wy;
          topScreenY = sy;
        }
        if (wy < bottomWorldY) {
          bottomWorldY = wy;
          bottomScreenY = sy;
        }
        if (wx > rightWorldX) {
          rightWorldX = wx;
          rightScreenX = sx;
        }
        if (wx < leftWorldX) {
          leftWorldX = wx;
          leftScreenX = sx;
        }
      }
    }
    expect(topScreenY).toBeLessThan(bottomScreenY);
    expect(rightScreenX).toBeGreaterThan(leftScreenX);
  });

  it("keeps vertical placement independent of yaw (turntable, no zoom pulse)", () => {
    const spun = bounds(projectWireframe(data, opts(1.234)).xy);
    expect(spun.minY).toBeCloseTo(frontBounds.minY, 3);
    expect(spun.maxY).toBeCloseTo(frontBounds.maxY, 3);
  });
});

describe("projectWireframe: facing", () => {
  it("classifies exact axis normals at yaw 0, 90 and 180", () => {
    // [+z, -z, +x] — the robot's front, its back, and its left flank.
    const at0 = facingAt(0);
    expect(must(at0[0])).toBeCloseTo(1, 6); // front faces the reader
    expect(must(at0[1])).toBeCloseTo(-1, 6); // back is turned away
    expect(must(at0[2])).toBeCloseTo(0, 6); // flank grazes: the silhouette

    // Half a turn and the front/back swap outright.
    const at180 = facingAt(Math.PI);
    expect(must(at180[0])).toBeCloseTo(-1, 6);
    expect(must(at180[1])).toBeCloseTo(1, 6);
    expect(must(at180[2])).toBeCloseTo(0, 6);

    // A quarter turn puts the flank in front of the reader and the front on
    // the silhouette. Positive yaw swings +z toward +x, so +x swings to -z:
    // the LEFT flank turns away.
    const at90 = facingAt(Math.PI / 2);
    expect(must(at90[0])).toBeCloseTo(0, 6);
    expect(must(at90[1])).toBeCloseTo(0, 6);
    expect(must(at90[2])).toBeCloseTo(-1, 6);
    expect(must(facingAt(-Math.PI / 2)[2])).toBeCloseTo(1, 6);
  });

  it("negates every edge's facing and depth under a half turn", () => {
    // Exact arithmetic, not a model fact: rotating another 180° flips both
    // the view-axis component of the normal and the view-axis position.
    for (const yaw of [0, 0.61, Math.PI / 4, 2.4]) {
      const a = projectWireframe(data, opts(yaw));
      const b = projectWireframe(data, opts(yaw + Math.PI));
      const fa = flatten(a, "facing");
      const fb = flatten(b, "facing");
      const da = flatten(a, "depth");
      const db = flatten(b, "depth");
      expect(fb.length).toBe(fa.length);
      for (let i = 0; i < fa.length; i += 1) {
        expect(must(fb[i])).toBeCloseTo(-must(fa[i]), 5);
        expect(must(db[i])).toBeCloseTo(-must(da[i]), 5);
      }
    }
  });

  it("stays a cosine: |facing| never exceeds 1 at any yaw", () => {
    let scratch: ProjectedFigure | undefined;
    for (let k = 0; k < 24; k += 1) {
      scratch = projectWireframe(data, opts((k * Math.PI) / 12), scratch);
      for (const f of flatten(scratch, "facing")) {
        expect(Math.abs(f)).toBeLessThanOrEqual(1 + 1e-5);
      }
    }
  });

  it("faces a closed body both ways at once — never all front or all back", () => {
    // The robot is eight closed solids, so at every yaw a real share of its
    // feature edges must be turned away. A projector that lost the rotation
    // (or an inside-out model) would put them all on one side of zero.
    for (const yaw of [0, 0.61, Math.PI / 2, 2.4, 4.0]) {
      const facings = flatten(projectWireframe(data, opts(yaw)), "facing");
      const back = facings.filter((f) => f < -0.2).length;
      const fore = facings.filter((f) => f > 0.2).length;
      const graze = facings.length - back - fore;
      expect(back / facings.length).toBeGreaterThan(0.25);
      expect(fore / facings.length).toBeGreaterThan(0.25);
      expect(graze).toBeGreaterThan(0); // there is always a silhouette
    }
  });
});

describe("projectWireframe: depth", () => {
  it("brackets every segment with depthMin/depthMax", () => {
    for (const yaw of [0, 0.9, Math.PI / 2, 3.7]) {
      const fig = projectWireframe(data, opts(yaw));
      const depths = flatten(fig, "depth");
      expect(fig.depthMin).toBeCloseTo(Math.min(...depths), 6);
      expect(fig.depthMax).toBeCloseTo(Math.max(...depths), 6);
      for (const d of depths) {
        expect(d).toBeGreaterThanOrEqual(fig.depthMin);
        expect(d).toBeLessThanOrEqual(fig.depthMax);
      }
    }
  });

  it("puts the near limb in front of the far one at a quarter turn", () => {
    // At yaw 90 the two arms project onto the same screen column, so depth is
    // the ONLY thing separating them — the exact case the tiers exist for.
    // Positive yaw swings +z toward +x, so the "_L" side (+x) goes to -z: away.
    const fig = projectWireframe(data, opts(Math.PI / 2));
    const meanDepth = (name: string): number => {
      const arr = must(fig.depth[nodeIndex(name)], name);
      let sum = 0;
      for (const d of arr) sum += d;
      return sum / arr.length;
    };
    expect(meanDepth("arm_R")).toBeGreaterThan(0);
    expect(meanDepth("arm_L")).toBeLessThan(0);
    expect(meanDepth("arm_R") - meanDepth("arm_L")).toBeGreaterThan(
      (fig.depthMax - fig.depthMin) * 0.5,
    );
    // ...and the torso between them sits inside that gap: the near arm reads
    // in front of it, the far arm behind.
    expect(meanDepth("torso")).toBeLessThan(meanDepth("arm_R"));
    expect(meanDepth("torso")).toBeGreaterThan(meanDepth("arm_L"));
  });

  it("collapses to a single depth when the figure is flat to the eye", () => {
    // A one-segment model has no depth range at all; the projector must say so
    // rather than divide by it.
    const flat = parseWireframe({
      v: 2,
      bbox: { min: [0, 0, 0], max: [1, 1, 0] },
      nodes: [
        {
          name: "flat",
          vertexCount: 2,
          positions: [0, 0, 0, 32767, 32767, 0],
          edges: [0, 1],
          normals: [0, 0, 127],
        },
      ],
    } satisfies WireframeJson);
    const fig = projectWireframe(flat, opts(0));
    expect(fig.depthMax - fig.depthMin).toBeCloseTo(0, 9);
  });
});

describe("projectWireframe: the flat segment index", () => {
  it("counts every segment once, node-major", () => {
    const total = data.nodes.reduce((sum, n) => sum + n.edgeCount, 0);
    expect(frontFig.segmentCount).toBe(total);
    expect(frontFig.nodeOf.length).toBe(total);
    expect(frontFig.localOf.length).toBe(total);

    let g = 0;
    for (let n = 0; n < data.nodes.length; n += 1) {
      const count = must(data.nodes[n], `node ${n}`).edgeCount;
      for (let e = 0; e < count; e += 1, g += 1) {
        expect(frontFig.nodeOf[g]).toBe(n);
        expect(frontFig.localOf[g]).toBe(e);
      }
    }
    expect(g).toBe(total);
  });

  it("is rebuilt when the model shape changes, not when the yaw does", () => {
    const scratch = projectWireframe(data, opts(0));
    const index = scratch.nodeOf;
    projectWireframe(data, opts(1.1), scratch);
    expect(scratch.nodeOf).toBe(index); // same array, untouched by a spin

    const tiny = parseWireframe(tinyDoc);
    projectWireframe(tiny, opts(0), scratch);
    expect(scratch.segmentCount).toBe(must(tiny.nodes[0], "tiny node").edgeCount);
    expect(scratch.nodeOf.length).toBe(scratch.segmentCount);
    for (let g = 0; g < scratch.segmentCount; g += 1) {
      expect(scratch.nodeOf[g]).toBe(0);
      expect(scratch.localOf[g]).toBe(g);
    }
  });
});

describe("projectWireframe: model-shaped invariants (the two allowed)", () => {
  it("head and torso are x-mirror symmetric at yaw 0 (within 6% of width)", () => {
    for (const name of ["head", "torso"]) {
      const misfit = mirrorMisfit(segmentsOf(front, name));
      expect(misfit).toBeLessThan(SHAPE_TOLERANCE * figureWidth);
    }
  });

  it("knee_actuator_L falls inside leg_L's x-band at yaw 0 (within 6% of width)", () => {
    const knee = xRange(segmentsOf(front, "knee_actuator_L"));
    const leg = xRange(segmentsOf(front, "leg_L"));
    const tolerance = SHAPE_TOLERANCE * figureWidth;
    expect(knee.min).toBeGreaterThanOrEqual(leg.min - tolerance);
    expect(knee.max).toBeLessThanOrEqual(leg.max + tolerance);
    // and the bands genuinely overlap (the actuator sits ON the leg)
    expect(knee.min).toBeLessThan(leg.max);
    expect(knee.max).toBeGreaterThan(leg.min);
  });
});

describe("projectWireframe: reusable output buffers", () => {
  it("reuses the same arrays across repeated calls — no growth, values updated", () => {
    const res = projectWireframe(data, opts(0));
    const identities = [...res.xy];
    const facings = [...res.facing];
    const depths = [...res.depth];
    const lengths = res.xy.map((seg) => seg.length);
    const frame0 = Array.from(must(res.xy[0], "segments 0"));
    const facing0 = Array.from(must(res.facing[0], "facing 0"));

    for (let k = 1; k <= 50; k += 1) {
      const again = projectWireframe(data, opts(k * 0.13), res);
      expect(again).toBe(res);
    }
    expect(res.xy.length).toBe(identities.length);
    for (let i = 0; i < res.xy.length; i += 1) {
      expect(res.xy[i]).toBe(identities[i]); // same Float32Array identity
      expect(res.facing[i]).toBe(facings[i]);
      expect(res.depth[i]).toBe(depths[i]);
      expect(must(res.xy[i], `segments ${i}`).length).toBe(lengths[i]); // no growth
    }
    // the last yaw actually landed in the reused buffers…
    expect(Array.from(must(res.xy[0], "segments 0"))).not.toEqual(frame0);
    expect(Array.from(must(res.facing[0], "facing 0"))).not.toEqual(facing0);
    // …and reprojecting yaw 0 through the scratch reproduces frame 0 exactly.
    // Bit-for-bit, which is what pins the reduced-motion canvas assertion:
    // a figure held at one yaw must redraw to the same bytes forever.
    projectWireframe(data, opts(0), res);
    expect(Array.from(must(res.xy[0], "segments 0"))).toEqual(frame0);
    expect(Array.from(must(res.facing[0], "facing 0"))).toEqual(facing0);
  });

  it("allocates fresh arrays when called without a scratch", () => {
    const a = projectWireframe(data, opts(0));
    const b = projectWireframe(data, opts(0));
    expect(b).not.toBe(a);
    expect(must(b.xy[0], "segments 0")).not.toBe(must(a.xy[0], "segments 0"));
    expect(Array.from(must(b.xy[0], "b segments"))).toEqual(
      Array.from(must(a.xy[0], "a segments")),
    );
    expect(Array.from(must(b.facing[0], "b facing"))).toEqual(
      Array.from(must(a.facing[0], "a facing")),
    );
  });

  it("resizes an old scratch safely when the model shape changes (hot swap)", () => {
    const tiny = parseWireframe(tinyDoc);
    const scratch = projectWireframe(data, opts(0));
    const swapped = projectWireframe(tiny, opts(0.4), scratch);
    expect(swapped).toBe(scratch);
    expect(scratch.xy.length).toBe(tiny.nodes.length);
    expect(must(scratch.xy[0], "tiny segments").length).toBe(
      must(tiny.nodes[0], "tiny node").edgeCount * 4,
    );
    expect(must(scratch.facing[0], "tiny facing").length).toBe(
      must(tiny.nodes[0], "tiny node").edgeCount,
    );
    // and back to the full model on the same scratch
    projectWireframe(data, opts(0), scratch);
    expect(scratch.xy.length).toBe(data.nodes.length);
    for (let i = 0; i < data.nodes.length; i += 1) {
      const n = must(data.nodes[i], `node ${i}`);
      expect(must(scratch.xy[i], `segments ${i}`).length).toBe(n.edgeCount * 4);
      expect(must(scratch.facing[i], `facing ${i}`).length).toBe(n.edgeCount);
      expect(must(scratch.depth[i], `depth ${i}`).length).toBe(n.edgeCount);
    }
    expect(scratch.segmentCount).toBe(
      data.nodes.reduce((sum, n) => sum + n.edgeCount, 0),
    );
  });
});
