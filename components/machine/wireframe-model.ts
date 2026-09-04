"use client";

import * as React from "react";
import { parseWireframe } from "@/lib/wireframe/parse";
import { type WireframeData } from "@/lib/wireframe/types";

/**
 * The elevation's model: fetching the extracted edge set once per page, and
 * the pure geometry that turns a wire joint name into a place on the drawing.
 *
 * Split from the component because none of it is one — it is a module-scoped
 * cache, a hook over that cache, and arithmetic that the tests exercise
 * directly without ever mounting a canvas.
 */

/** Where the extracted edge set lives. Fetched lazily; never bundled. */
export const WIREFRAME_URL = "/models/chassis-wireframe.json";

/** Below this the anchor has not really moved; do not touch the leader line. */
export const ANCHOR_EPSILON = 0.15;

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
