import * as z from "zod/mini";
import { type WireframeData, type WireframeJson, type WireframeNode } from "./types";

/**
 * Validation + dequantization for chassis-wireframe.json (format doc: types.ts).
 *
 * `zod/mini` for the same reason as lib/schema: the machine chunk already
 * pays for the mini core, and the functional API tree-shakes to just the
 * validators named here. Shape and range live in the schema; the cross-field
 * invariants (positions length, edge index bounds) are `z.refine` checks so
 * one `parse` rejects every malformed document the renderer could trip on.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
/** Quantized coordinate: int16 on the wire but never negative — q ∈ [0, 32767]
 *  per the format doc (types.ts). Load-bearing: project.ts guarantees in-bounds
 *  output only for positions that dequantize INSIDE the declared bbox. */
const quant16 = z.int().check(z.minimum(0), z.maximum(32767));
/** Quantized normal component: int8, symmetric — q ∈ [-127, 127] (types.ts). */
const quant8 = z.int().check(z.minimum(-127), z.maximum(127));

const nodeSchema = z
  .object({
    name: z.string().check(z.minLength(1)),
    vertexCount: z.int().check(z.minimum(1), z.maximum(65535)),
    positions: z.array(quant16),
    edges: z.array(z.int().check(z.minimum(0))).check(z.minLength(2)),
    normals: z.array(quant8),
  })
  .check(
    z.refine(
      (n) => n.positions.length === n.vertexCount * 3,
      "positions must hold vertexCount*3 values",
    ),
    z.refine((n) => n.edges.length % 2 === 0, "edges must be index PAIRS (even length)"),
    z.refine(
      (n) => n.edges.every((i) => i < n.vertexCount),
      "edge index out of vertex range",
    ),
    z.refine(
      (n) => n.normals.length === (n.edges.length / 2) * 3,
      "normals must hold one xyz triple per EDGE",
    ),
  );

export const wireframeJsonSchema = z
  .object({
    // v1 is rejected, not upgraded — see the format note in types.ts.
    v: z.literal(2),
    bbox: z
      .object({ min: vec3, max: vec3 })
      .check(
        z.refine(
          (b) => b.min.every((m, c) => m <= (b.max[c] ?? Number.NaN)),
          "bbox min must not exceed max",
        ),
      ),
    nodes: z.array(nodeSchema).check(z.minLength(1)),
  })
  .check(
    z.refine(
      (d) => new Set(d.nodes.map((n) => n.name)).size === d.nodes.length,
      "node names must be unique",
    ),
  );

/** Dequantize one axis value: q ∈ [0, 32767] → meters. */
const dequant = (q: number, min: number, extent: number): number =>
  min + (q / 32767) * extent;

/**
 * Validate an unknown JSON document and dequantize it into typed arrays.
 * Throws (ZodError) on any malformed input; the caller's fetch path treats
 * that the same as a network failure and keeps the SVG fallback.
 */
export function parseWireframe(json: unknown): WireframeData {
  const doc: WireframeJson = wireframeJsonSchema.parse(json);
  const { min, max } = doc.bbox;
  const ex = max[0] - min[0];
  const ey = max[1] - min[1];
  const ez = max[2] - min[2];

  const nodes: WireframeNode[] = doc.nodes.map((n) => {
    const positions = new Float32Array(n.vertexCount * 3);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = dequant(n.positions[i] ?? 0, min[0], ex);
      positions[i + 1] = dequant(n.positions[i + 1] ?? 0, min[1], ey);
      positions[i + 2] = dequant(n.positions[i + 2] ?? 0, min[2], ez);
    }
    // Normals are RENORMALIZED, not merely scaled by 1/127: the int8 lattice
    // moves each component by up to 1/254, so a quantized unit vector has a
    // length within about ±0.7 % of 1. project.ts hands the dot product
    // straight to threshold comparisons as if it were a cosine, so it has to
    // be one. A zero triple (never emitted, but cheap to survive) becomes +z.
    const normals = new Float32Array((n.edges.length / 2) * 3);
    for (let i = 0; i < normals.length; i += 3) {
      const x = (n.normals[i] ?? 0) / 127;
      const y = (n.normals[i + 1] ?? 0) / 127;
      const z2 = (n.normals[i + 2] ?? 0) / 127;
      const len = Math.hypot(x, y, z2);
      if (len < 1e-6) {
        normals[i + 2] = 1;
      } else {
        normals[i] = x / len;
        normals[i + 1] = y / len;
        normals[i + 2] = z2 / len;
      }
    }
    return {
      name: n.name,
      vertexCount: n.vertexCount,
      positions,
      edgeCount: n.edges.length / 2,
      edges: Uint16Array.from(n.edges),
      normals,
    };
  });

  return {
    bbox: { min: [...min], max: [...max] },
    nodes,
    byName: new Map(nodes.map((n) => [n.name, n])),
  };
}
