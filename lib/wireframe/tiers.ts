/**
 * The luminance ladder the model's wireframe is drawn on.
 *
 * `project.ts` says where every edge is and which way it points; this says how
 * bright it should therefore be. It is a drawing decision, not projection
 * math, but it is a *pure* one — thresholds, an alpha table and a classifier —
 * so it lives here rather than inside the canvas component, for three reasons:
 * the tier assignment can be unit-tested without a 2D context, the offline
 * preview (`scripts/preview-wireframe.ts`) rasterizes the exact ladder the
 * board renders rather than a copy of it that will drift, and the numbers a
 * person is going to argue about are all in one screen of one file.
 *
 * ## Why there is a ladder at all
 *
 * v1 drew all 1 990 feature edges at one alpha. At yaw 0 that is a clean line
 * drawing; at yaw 35 it is felt. Every line weighs the same, so the near arm,
 * the torso and the far arm arrive on top of each other with nothing to tell
 * them apart, and the figure loses even its facing direction. Machine space is
 * not allowed to answer that with glow, bloom or colour (PRD §5 — hierarchy
 * here is luminance and nothing else), so it answers it with luminance:
 *
 *   ghost     facing < -CONTOUR_BAND   the far side of every surface, held at
 *                                      a seventh of base. Not removed: this is
 *                                      a see-through instrument, and a figure
 *                                      with its back deleted reads as a cutout
 *                                      rather than as a machine.
 *   body      facing >  CONTOUR_BAND   the side turned toward the reader,
 *                                      ramped by depth so a near limb sits in
 *                                      front of a far one.
 *   contour  |facing| ≤ CONTOUR_BAND   the silhouette, where the surface turns
 *                                      away exactly at the eye — the outline
 *                                      of the figure at every yaw, and the
 *                                      brightest thing in the drawing.
 *
 * A lighting model with no light in it. A limb's far seams fall away, its near
 * seams hold, and its two grazing seams burn, so a cylinder reads as a tube
 * and an arm crossing a torso reads as being in front of it.
 *
 * ## The budget
 *
 * The figure is supporting cast and must stay a tier under the manifest text
 * beside it (`--ink-soft` is 68 % phosphor, `--muted` 52 %). The ladder does
 * not raise that budget, it redistributes it: the body tier ramps DOWN from
 * v1's flat 0.42, the back of the figure drops to a seventh of it, and only
 * the few hundred edges on the silhouette are allowed above `--muted`, topping
 * out AT `--ink-soft` and never past it.
 *
 * Measured over all 1 990 edges (`scripts/preview-wireframe.ts`), mean alpha
 * per edge is 0.25 at yaw 0 and 0.28 at yaw 90, against v1's flat 0.42. The
 * drawing got quieter and more legible at the same time, which is the whole
 * argument for doing this with luminance rather than with weight or colour.
 */

/**
 * Tier boundary, as `|facing|`: an edge whose normal is within this much of
 * perpendicular to the eye is on the silhouette.
 *
 * 0.20 is ±11.5° of grazing. Tuned by eye at yaw 0/35/90/135 from a starting
 * 0.15: narrower and the outline breaks into dashes down the limbs, where the
 * tessellation leaves a seam only every ~15° of azimuth and a tight band can
 * fall between two of them; wider and the contour stops being an outline and
 * becomes a third of the figure.
 *
 * It is the ghost boundary too — silhouette wins the overlap, because an edge
 * at grazing incidence is a silhouette edge whichever side it leans.
 */
export const CONTOUR_BAND = 0.2;

/**
 * Depth bands per ramped tier. Four is the fewest that reads as a gradient
 * rather than as banding on a 1 px stroke, and it holds the whole ladder to
 * nine `stroke()` calls a frame.
 */
export const DEPTH_STEPS = 4;

/** Body tier at its nearest band — v1's flat alpha, now the ceiling not the norm. */
export const ALPHA_BASE = 0.42;
/** Back-facing, flat. Present, and unmistakably behind. */
export const ALPHA_GHOST_OF_BASE = 0.14;
/** How dark the FAR end of each ramp goes, as a fraction of its tier. */
export const BODY_DEPTH_FLOOR = 0.45;
export const CONTOUR_DEPTH_FLOOR = 0.55;
/**
 * The silhouette. Deliberately above `--muted` at its near end — it is the only
 * part of the figure that is, and it is what makes the drawing legible at a
 * glance — while staying under `--ink`, the manifest's own tier.
 */
export const ALPHA_CONTOUR = 0.72;

/** Ghost is one flat level; body and contour are ramped over DEPTH_STEPS. */
export const LEVELS = 1 + 2 * DEPTH_STEPS;
export const L_GHOST = 0;
export const L_BODY = 1;
export const L_CONTOUR = 1 + DEPTH_STEPS;
/** Not on the ladder at all: the flagged module draws itself, in alert. */
export const L_SKIP = 255;

/**
 * One tier width, so a lifted edge lands exactly where the same edge one tier
 * up would be: a ghost reads as body, a body edge reads as contour.
 */
export const LIFT_BOOST = DEPTH_STEPS;

/**
 * Alpha per level, ascending, built once. Rounded to 3 dp so a settled frame
 * compares equal and the recorded passes in tests are exact rather than
 * float-fuzzy (canvas quantizes to 1/255 anyway).
 */
export const LEVEL_ALPHA: Float64Array = (() => {
  const ladder = new Float64Array(LEVELS);
  const at = (v: number) => Math.round(v * 1000) / 1000;
  ladder[L_GHOST] = at(ALPHA_BASE * ALPHA_GHOST_OF_BASE);
  for (let k = 0; k < DEPTH_STEPS; k += 1) {
    // Band CENTRE, so the nearest band is not pinned at exactly 1.0 of its
    // tier and the farthest is not pinned at exactly the floor.
    const t = (k + 0.5) / DEPTH_STEPS;
    ladder[L_BODY + k] = at(ALPHA_BASE * (BODY_DEPTH_FLOOR + (1 - BODY_DEPTH_FLOOR) * t));
    ladder[L_CONTOUR + k] = at(
      ALPHA_CONTOUR * (CONTOUR_DEPTH_FLOOR + (1 - CONTOUR_DEPTH_FLOOR) * t),
    );
  }
  return ladder;
})();

/**
 * Depth → band multiplier for one frame, from the figure's own depth range.
 *
 * The range is the WHOLE figure's, not the visible subset's, so an edge's
 * brightness reports where it actually is in the model rather than its rank
 * among whatever happens to face the reader this frame. That keeps the cue
 * honest as the turntable moves, and it keeps a pinned yaw byte-identical.
 * A flat figure (zero range) collapses to band 0, which is correct: nothing
 * is nearer than anything else.
 */
export function depthScale(depthMin: number, depthMax: number): number {
  const span = depthMax - depthMin;
  return span > 0 ? DEPTH_STEPS / span : 0;
}

/**
 * Which ladder level one segment belongs on.
 *
 * `dScale` comes from `depthScale`; `boost` lifts the result by that many
 * levels (the sweeping joint's +1 tier), clamped to the top of the ladder.
 */
export function levelFor(
  facing: number,
  depth: number,
  depthMin: number,
  dScale: number,
  boost: number = 0,
): number {
  let level: number;
  if (facing <= CONTOUR_BAND && facing >= -CONTOUR_BAND) {
    level = L_CONTOUR;
  } else if (facing < 0) {
    level = L_GHOST; // flat: the far side gets no depth ramp
  } else {
    level = L_BODY;
  }
  if (level !== L_GHOST) {
    const t = (depth - depthMin) * dScale;
    level += t < DEPTH_STEPS - 1 ? (t > 0 ? t | 0 : 0) : DEPTH_STEPS - 1;
  }
  if (boost > 0) level = level + boost < LEVELS ? level + boost : LEVELS - 1;
  return level;
}
