/**
 * chassis-wireframe format (v2) — the compact feature-edge extraction of
 * public/models/chassis-silhouette.glb, emitted offline by
 * scripts/extract-wireframe.mjs into public/models/chassis-wireframe.json.
 *
 * This is how machine space draws the actual robot model as a phosphor
 * line drawing without shipping three.js: the JSON is fetched lazily,
 * parsed/dequantized once (parse.ts), and projected to 2D canvas segments
 * every frame by pure math (project.ts).
 *
 * The wire format:
 *
 *   {
 *     "v": 2,
 *     "bbox": { "min": [x, y, z], "max": [x, y, z] },   // meters, world space
 *     "nodes": [
 *       {
 *         "name": "knee_actuator_L",     // one of the 8 component nodes
 *         "vertexCount": n,
 *         "positions": [int16, ...],     // n*3 values, x y z interleaved
 *         "edges": [i0,j0, i1,j1, ...],  // index pairs into positions
 *         "normals": [int8, ...]         // edges.length/2 * 3 values, xyz
 *       }
 *     ]
 *   }
 *
 * Coordinates are world space: robot faces +Z, ground at y=0, "_L" nodes on
 * +X. Positions are quantized per axis over the shared model bbox:
 *
 *   q = round((p - min) / (max - min) * 32767)
 *   p̂ = min + (q / 32767) * (max - min)
 *
 * Worst-case roundtrip error is extent/32767/2 ≈ 0.03 mm on the tall axis —
 * far inside the 2 mm contract the tests pin.
 *
 * ## What v2 added, and why
 *
 * v1 shipped positions and edges, and machine space drew all 1 990 of them
 * at one alpha. That is a readable drawing at yaw 0 and a thicket at yaw 35:
 * every line has the same weight, so the near arm, the far arm and the torso
 * behind both of them arrive as one flat mat of green with no way to tell
 * which way the figure is pointing. The fix is the one machine space is
 * allowed (PRD §5: hierarchy is luminance, never glow, never colour): give
 * each edge a *facing* so the renderer can dim what is turned away.
 *
 * So each edge carries the mean unit normal of the faces it belongs to — two
 * for a crease, one for a boundary, all of them for a non-manifold edge —
 * quantized per component:
 *
 *   q = round(clamp(n, -1, 1) * 127)    // -127 … 127
 *   n̂ = renormalize(q / 127)
 *
 * The renderer only ever takes a dot product with the view direction, so
 * direction is the whole contract and magnitude is discarded on parse. An
 * int8 lattice resolves a unit vector to ~0.5°, two orders of magnitude
 * finer than the tier thresholds it feeds. Cost: ~10 bytes/edge of JSON
 * text, ~6 KB gzipped, on an asset that is fetched once and never bundled.
 *
 * v1 documents are REJECTED rather than upgraded in place. The renderer
 * fetches with `cache: "no-cache"` and falls back to a complete hand-drawn
 * SVG elevation, so a stale client gets a correct drawing rather than a
 * half-tiered one — and there is no silent path where the normals are
 * missing and every edge classifies as silhouette.
 */

/** One component node as it appears in the JSON (quantized). */
export interface WireframeNodeJson {
  name: string;
  vertexCount: number;
  /** vertexCount*3 int16 values, x y z interleaved. */
  positions: number[];
  /** Flat index pairs into positions; length is even, indices < vertexCount. */
  edges: number[];
  /** edges.length/2 * 3 int8 values: the per-edge mean face normal, xyz. */
  normals: number[];
}

/** The whole JSON document (v2). */
export interface WireframeJson {
  v: 2;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  nodes: WireframeNodeJson[];
}

/** One component node after parsing: dequantized, typed, ready to project. */
export interface WireframeNode {
  name: string;
  vertexCount: number;
  /** vertexCount*3 floats, x y z interleaved, meters, world space. */
  positions: Float32Array;
  /** edges.length / 2 — the number of line segments this node draws. */
  edgeCount: number;
  /** Flat index pairs into positions (vertex indices, not float offsets). */
  edges: Uint16Array;
  /** edgeCount*3 floats: unit mean face normal per edge, aligned with edges. */
  normals: Float32Array;
}

/** Parsed wireframe: what parseWireframe returns and project.ts consumes. */
export interface WireframeData {
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /** In file order — projection output aligns with this array by index. */
  nodes: WireframeNode[];
  /** Same nodes keyed by name (e.g. "knee_actuator_L" for the alert tint). */
  byName: ReadonlyMap<string, WireframeNode>;
}
