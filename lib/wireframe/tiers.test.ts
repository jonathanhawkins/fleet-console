// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWireframe } from "./parse";
import { projectWireframe } from "./project";
import {
  ALPHA_BASE,
  ALPHA_CONTOUR,
  CONTOUR_BAND,
  DEPTH_STEPS,
  depthScale,
  L_CONTOUR,
  L_GHOST,
  L_BODY,
  LEVEL_ALPHA,
  LEVELS,
  levelFor,
  LIFT_BOOST,
} from "./tiers";

/**
 * The ladder is a taste feature, so most of it is only judged by eye
 * (`scripts/preview-wireframe.ts`, and the evidence shot in
 * docs/evidence/phase-9). What is pinned here is everything a change could
 * break WITHOUT looking wrong in a still: the classification boundaries, the
 * monotonicity of the alphas, the clamping at both ends of the depth ramp,
 * and — on the real model — that the tiers actually separate near from far.
 */

const ASSET_URL = new URL("../../public/models/chassis-wireframe.json", import.meta.url);
const data = parseWireframe(JSON.parse(readFileSync(ASSET_URL, "utf8")));

function must<T>(value: T | undefined, what = "value"): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}

/** A unit-range ramp: depth 0..1 with dScale to match. */
const UNIT = depthScale(0, 1);

describe("the alpha ladder", () => {
  it("ascends strictly from ghost to the brightest contour", () => {
    expect(LEVEL_ALPHA.length).toBe(LEVELS);
    for (let l = 1; l < LEVELS; l += 1) {
      expect(must(LEVEL_ALPHA[l])).toBeGreaterThan(must(LEVEL_ALPHA[l - 1]));
    }
  });

  it("keeps the whole figure under --ink, and only the contour over --muted", () => {
    // The board's own tiers: --ink-soft is 68% phosphor, --muted 52%. The
    // figure is supporting cast, so nothing may reach --ink (1.0) and only
    // the silhouette is allowed past --muted.
    for (let l = 0; l < LEVELS; l += 1) {
      expect(must(LEVEL_ALPHA[l])).toBeLessThanOrEqual(0.68);
    }
    for (let l = 0; l < L_CONTOUR; l += 1) {
      expect(must(LEVEL_ALPHA[l])).toBeLessThan(0.52);
    }
    // ...and the brightest body band never outshines the dimmest contour, or
    // the tiers would not be tiers.
    expect(must(LEVEL_ALPHA[L_CONTOUR])).toBeGreaterThan(
      must(LEVEL_ALPHA[L_CONTOUR - 1]),
    );
  });

  it("caps the body tier at v1's flat alpha — the ladder redistributes, it does not shout", () => {
    for (let l = L_BODY; l < L_CONTOUR; l += 1) {
      expect(must(LEVEL_ALPHA[l])).toBeLessThanOrEqual(ALPHA_BASE);
    }
    expect(must(LEVEL_ALPHA[LEVELS - 1])).toBeLessThanOrEqual(ALPHA_CONTOUR);
    // The back of the figure is present, not deleted: dim enough to recede,
    // bright enough to still be a line on a #060606 ground.
    expect(must(LEVEL_ALPHA[L_GHOST])).toBeGreaterThan(0.03);
    expect(must(LEVEL_ALPHA[L_GHOST])).toBeLessThan(0.1);
  });
});

describe("levelFor: tier assignment", () => {
  it("sends back-facing edges to the flat ghost level", () => {
    for (const facing of [-1, -0.9, -0.5, -CONTOUR_BAND - 1e-6]) {
      // Depth must not matter: the far side gets no ramp.
      expect(levelFor(facing, 0, 0, UNIT)).toBe(L_GHOST);
      expect(levelFor(facing, 0.5, 0, UNIT)).toBe(L_GHOST);
      expect(levelFor(facing, 1, 0, UNIT)).toBe(L_GHOST);
    }
  });

  it("sends front-facing edges to the body tier and grazing ones to the contour", () => {
    for (const facing of [CONTOUR_BAND + 1e-6, 0.5, 1]) {
      const level = levelFor(facing, 0, 0, UNIT);
      expect(level).toBeGreaterThanOrEqual(L_BODY);
      expect(level).toBeLessThan(L_CONTOUR);
    }
    for (const facing of [-CONTOUR_BAND, -0.1, 0, 0.1, CONTOUR_BAND]) {
      expect(levelFor(facing, 0, 0, UNIT)).toBeGreaterThanOrEqual(L_CONTOUR);
    }
  });

  it("gives the silhouette the overlap band, on both sides of zero", () => {
    // An edge at grazing incidence is a silhouette edge whichever way it
    // leans, so the contour test runs BEFORE the back-facing one. The step
    // either side of the boundary is what pins that ordering.
    expect(levelFor(-CONTOUR_BAND, 0, 0, UNIT)).toBeGreaterThanOrEqual(L_CONTOUR);
    expect(levelFor(-CONTOUR_BAND - 1e-9, 0, 0, UNIT)).toBe(L_GHOST);
  });

  it("ramps each tier over DEPTH_STEPS bands, far to near", () => {
    for (const base of [L_BODY, L_CONTOUR]) {
      const facing = base === L_BODY ? 1 : 0;
      const seen: number[] = [];
      for (let k = 0; k < DEPTH_STEPS; k += 1) {
        const depth = (k + 0.5) / DEPTH_STEPS; // band centre
        const level = levelFor(facing, depth, 0, UNIT);
        expect(level).toBe(base + k);
        seen.push(must(LEVEL_ALPHA[level]));
      }
      // nearer is brighter, monotonically
      for (let k = 1; k < seen.length; k += 1) {
        expect(must(seen[k])).toBeGreaterThan(must(seen[k - 1]));
      }
    }
  });

  it("clamps both ends of the ramp instead of running off the ladder", () => {
    // Exactly at the far end, past it, exactly at the near end, and past it.
    expect(levelFor(1, 0, 0, UNIT)).toBe(L_BODY);
    expect(levelFor(1, -5, 0, UNIT)).toBe(L_BODY);
    expect(levelFor(1, 1, 0, UNIT)).toBe(L_BODY + DEPTH_STEPS - 1);
    expect(levelFor(1, 99, 0, UNIT)).toBe(L_BODY + DEPTH_STEPS - 1);
    expect(levelFor(0, 99, 0, UNIT)).toBe(LEVELS - 1);
  });

  it("collapses to the far band when the figure has no depth range", () => {
    // depthScale returns 0 for a flat figure — nothing is nearer than
    // anything else, so everything sits in band 0 rather than dividing by 0.
    const flat = depthScale(2, 2);
    expect(flat).toBe(0);
    expect(levelFor(1, 2, 2, flat)).toBe(L_BODY);
    expect(Number.isFinite(must(LEVEL_ALPHA[levelFor(1, 2, 2, flat)]))).toBe(true);
  });
});

describe("levelFor: the sweep lift", () => {
  it("raises an edge by exactly one tier width", () => {
    // A ghost reads as body, a body edge reads as contour — the same edge one
    // tier up, which is what "+1 tier for 1.4s" has always meant here.
    expect(levelFor(-1, 0, 0, UNIT, LIFT_BOOST)).toBe(L_GHOST + DEPTH_STEPS);
    expect(levelFor(1, 0.1, 0, UNIT, LIFT_BOOST)).toBe(L_BODY + DEPTH_STEPS);
    expect(LIFT_BOOST).toBe(DEPTH_STEPS);
  });

  it("only ever brightens, and never past the top of the ladder", () => {
    for (const facing of [-1, -0.3, 0, 0.3, 1]) {
      for (const depth of [0, 0.4, 1]) {
        const plain = levelFor(facing, depth, 0, UNIT);
        for (let boost = 0; boost <= LIFT_BOOST; boost += 1) {
          const lifted = levelFor(facing, depth, 0, UNIT, boost);
          expect(lifted).toBeGreaterThanOrEqual(plain);
          expect(lifted).toBeLessThan(LEVELS);
        }
      }
    }
    expect(levelFor(0, 1, 0, UNIT, LIFT_BOOST)).toBe(LEVELS - 1);
  });

  it("is a no-op at boost 0, so a settled frame draws what an unlifted one does", () => {
    for (const facing of [-1, -0.2, 0, 0.2, 1]) {
      expect(levelFor(facing, 0.6, 0, UNIT, 0)).toBe(levelFor(facing, 0.6, 0, UNIT));
    }
  });
});

describe("the tiers on the real model", () => {
  const at = (deg: number) => {
    const fig = projectWireframe(data, {
      yawRad: (deg * Math.PI) / 180,
      viewport: { w: 144, h: 352 },
      margin: 6,
    });
    const dMin = fig.depthMin;
    const dScale = depthScale(fig.depthMin, fig.depthMax);
    const meanAlpha = (name: string): number => {
      const index = data.nodes.indexOf(must(data.byName.get(name), name));
      const face = must(fig.facing[index], name);
      const deep = must(fig.depth[index], name);
      let sum = 0;
      for (let i = 0; i < face.length; i += 1) {
        sum += must(LEVEL_ALPHA[levelFor(must(face[i]), must(deep[i]), dMin, dScale)]);
      }
      return sum / face.length;
    };
    const histogram = new Int32Array(LEVELS);
    for (let n = 0; n < data.nodes.length; n += 1) {
      const face = must(fig.facing[n], `facing ${n}`);
      const deep = must(fig.depth[n], `depth ${n}`);
      for (let i = 0; i < face.length; i += 1) {
        const level = levelFor(must(face[i]), must(deep[i]), dMin, dScale);
        histogram[level] = (histogram[level] ?? 0) + 1;
      }
    }
    return { meanAlpha, histogram };
  };

  it("reads the near arm in front of the torso and the far arm behind it at 90°", () => {
    // The complaint this answers, as arithmetic: at a quarter turn
    // both arms project onto the torso's screen column, and luminance is the
    // only thing left to separate them.
    const { meanAlpha } = at(90);
    expect(meanAlpha("arm_R")).toBeGreaterThan(meanAlpha("torso"));
    expect(meanAlpha("torso")).toBeGreaterThan(meanAlpha("arm_L"));
    // and by a margin a reader can actually see, not a rounding difference
    expect(meanAlpha("arm_R") / meanAlpha("arm_L")).toBeGreaterThan(1.3);
  });

  it("separates the limbs at every oblique yaw, mirrored about the front", () => {
    for (const deg of [35, 90, 135]) {
      const near = at(deg);
      expect(near.meanAlpha("arm_R")).toBeGreaterThan(near.meanAlpha("arm_L"));
      expect(near.meanAlpha("leg_R")).toBeGreaterThan(near.meanAlpha("leg_L"));
      // The opposite yaw must swap them by exactly the same reasoning.
      const far = at(-deg);
      expect(far.meanAlpha("arm_L")).toBeGreaterThan(far.meanAlpha("arm_R"));
    }
  });

  it("keeps all three tiers populated at every yaw", () => {
    // A figure with no ghosts has lost its depth cue; one with no contour has
    // lost its outline. Both are ways for a threshold edit to quietly ruin it.
    for (const deg of [0, 35, 90, 135, 180]) {
      const { histogram } = at(deg);
      const ghost = histogram[L_GHOST] ?? 0;
      let body = 0;
      let contour = 0;
      for (let l = L_BODY; l < L_CONTOUR; l += 1) body += histogram[l] ?? 0;
      for (let l = L_CONTOUR; l < LEVELS; l += 1) contour += histogram[l] ?? 0;
      const total = ghost + body + contour;
      expect(total).toBe(data.nodes.reduce((s, n) => s + n.edgeCount, 0));
      expect(ghost / total).toBeGreaterThan(0.2);
      expect(body / total).toBeGreaterThan(0.2);
      expect(contour / total).toBeGreaterThan(0.05);
      // The outline is an outline, not a third of the drawing.
      expect(contour / total).toBeLessThan(0.35);
    }
  });

  it("draws a quieter figure than v1's flat alpha did, at every yaw", () => {
    // The legibility argument in tiers.ts stands or falls on this: the tiers
    // made the drawing MORE readable while lighting FEWER pixels.
    for (const deg of [0, 35, 90, 135]) {
      const { histogram } = at(deg);
      let lit = 0;
      let count = 0;
      for (let l = 0; l < LEVELS; l += 1) {
        lit += (histogram[l] ?? 0) * must(LEVEL_ALPHA[l]);
        count += histogram[l] ?? 0;
      }
      expect(lit / count).toBeLessThan(ALPHA_BASE);
    }
  });
});
