// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWireframe } from "./parse";
import { type WireframeJson, type WireframeNodeJson } from "./types";

/**
 * The shipped asset is read from disk AT RUN TIME on purpose: the model is
 * re-extracted whenever chassis-silhouette.glb changes, so every expectation here
 * is derived from the loaded document (names/format contract), never from
 * hardcoded vertex or edge counts.
 */
const ASSET_URL = new URL("../../public/models/chassis-wireframe.json", import.meta.url);
const raw = JSON.parse(readFileSync(ASSET_URL, "utf8")) as WireframeJson;

/** The eight component nodes the extractor guarantees (its REQUIRED list). */
const COMPONENT_NODES = [
  "head",
  "torso",
  "arm_L",
  "arm_R",
  "leg_L",
  "leg_R",
  "knee_actuator_L",
  "knee_actuator_R",
] as const;

const clone = (): WireframeJson => structuredClone(raw);

function must<T>(value: T | undefined, what = "value"): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}

const firstNode = (doc: WireframeJson): WireframeNodeJson => must(doc.nodes[0], "node 0");

describe("parseWireframe: rejects malformed documents", () => {
  it("accepts the shipped asset", () => {
    expect(() => parseWireframe(raw)).not.toThrow();
  });

  it("rejects non-object roots", () => {
    expect(() => parseWireframe(null)).toThrow();
    expect(() => parseWireframe(undefined)).toThrow();
    expect(() => parseWireframe([])).toThrow();
    expect(() => parseWireframe("{}")).toThrow();
  });

  it("rejects a wrong format version — including v1, which is not upgraded", () => {
    const doc = clone();
    (doc as { v: number }).v = 3;
    expect(() => parseWireframe(doc)).toThrow();

    // A v1 document is a REAL possibility, not a hypothetical: it is what a
    // client with a stale copy of the asset holds. It must be refused rather
    // than limped along, because a v1 node has no normals at all and every
    // edge would silently classify onto one tier — a flat drawing that looks
    // deliberate. The fetch is `cache: "no-cache"` and the caller falls back
    // to the hand-drawn SVG, so refusing costs a correct drawing, not a hole.
    const v1 = clone();
    (v1 as { v: number }).v = 1;
    for (const node of v1.nodes) delete (node as Partial<WireframeNodeJson>).normals;
    expect(() => parseWireframe(v1)).toThrow();

    // ...and v1's shape carrying a v2 version marker is refused too.
    const noNormals = clone();
    delete (firstNode(noNormals) as Partial<WireframeNodeJson>).normals;
    expect(() => parseWireframe(noNormals)).toThrow();
  });

  it("rejects a missing or empty nodes array", () => {
    const doc = clone();
    (doc as Partial<WireframeJson>).nodes = undefined;
    expect(() => parseWireframe(doc)).toThrow();
    const empty = clone();
    empty.nodes = [];
    expect(() => parseWireframe(empty)).toThrow();
  });

  it("rejects a truncated positions array", () => {
    const doc = clone();
    firstNode(doc).positions.pop();
    expect(() => parseWireframe(doc)).toThrow(/positions must hold/);
  });

  it("rejects an odd-length (truncated) edges array", () => {
    const doc = clone();
    firstNode(doc).edges.pop();
    expect(() => parseWireframe(doc)).toThrow(/index PAIRS/);
  });

  it("rejects an edge index out of vertex range", () => {
    const doc = clone();
    const node = firstNode(doc);
    node.edges[0] = node.vertexCount; // first invalid index
    expect(() => parseWireframe(doc)).toThrow(/edge index out of vertex range/);
    const neg = clone();
    firstNode(neg).edges[0] = -1;
    expect(() => parseWireframe(neg)).toThrow();
  });

  it("rejects quantized positions outside [0, 32767]", () => {
    const below = clone();
    firstNode(below).positions[0] = -1;
    expect(() => parseWireframe(below)).toThrow();
    const above = clone();
    firstNode(above).positions[0] = 32768;
    expect(() => parseWireframe(above)).toThrow();
    const fractional = clone();
    firstNode(fractional).positions[0] = 12.5;
    expect(() => parseWireframe(fractional)).toThrow();
  });

  it("rejects a normals array that is not one xyz triple per edge", () => {
    const short = clone();
    firstNode(short).normals.length -= 3; // one edge left without a normal
    expect(() => parseWireframe(short)).toThrow(/one xyz triple per EDGE/);

    const long = clone();
    firstNode(long).normals.push(0, 0, 127);
    expect(() => parseWireframe(long)).toThrow(/one xyz triple per EDGE/);
  });

  it("rejects quantized normals outside [-127, 127]", () => {
    const below = clone();
    firstNode(below).normals[0] = -128;
    expect(() => parseWireframe(below)).toThrow();
    const above = clone();
    firstNode(above).normals[0] = 128;
    expect(() => parseWireframe(above)).toThrow();
    const fractional = clone();
    firstNode(fractional).normals[0] = 0.5;
    expect(() => parseWireframe(fractional)).toThrow();
  });

  it("rejects a bbox whose min exceeds max", () => {
    const doc = clone();
    doc.bbox.min[1] = doc.bbox.max[1] + 1;
    expect(() => parseWireframe(doc)).toThrow(/bbox min/);
  });

  it("rejects duplicate node names", () => {
    const doc = clone();
    if (doc.nodes.length < 2) throw new Error("fixture needs >= 2 nodes");
    must(doc.nodes[1], "node 1").name = firstNode(doc).name;
    expect(() => parseWireframe(doc)).toThrow(/unique/);
  });

  it("rejects a vertexCount that disagrees with positions", () => {
    const doc = clone();
    firstNode(doc).vertexCount += 1;
    expect(() => parseWireframe(doc)).toThrow(/positions must hold/);
  });
});

describe("parseWireframe: shipped-asset invariants (model-agnostic)", () => {
  const data = parseWireframe(raw);

  it("contains the eight component nodes, each drawable (> 0 edges)", () => {
    expect(data.nodes.length).toBeGreaterThanOrEqual(COMPONENT_NODES.length);
    for (const name of COMPONENT_NODES) {
      const node = must(data.byName.get(name), name);
      expect(node.edgeCount).toBeGreaterThan(0);
      expect(node.vertexCount).toBeGreaterThan(0);
    }
  });

  it("keeps nodes/byName aligned with consistent array sizes", () => {
    expect(data.byName.size).toBe(data.nodes.length);
    for (const node of data.nodes) {
      expect(data.byName.get(node.name)).toBe(node);
      expect(node.positions.length).toBe(node.vertexCount * 3);
      expect(node.edges.length).toBe(node.edgeCount * 2);
      for (const index of node.edges) expect(index).toBeLessThan(node.vertexCount);
    }
  });

  it("dequantizes every coordinate inside the declared bbox", () => {
    const { min, max } = data.bbox;
    const eps = 1e-5; // float32 storage noise, far below mm scale
    for (const node of data.nodes) {
      for (let i = 0; i < node.positions.length; i += 3) {
        for (let c = 0; c < 3; c += 1) {
          const p = node.positions[i + c] ?? Number.NaN;
          expect(p).toBeGreaterThanOrEqual((min[c] ?? Number.NaN) - eps);
          expect(p).toBeLessThanOrEqual((max[c] ?? Number.NaN) + eps);
        }
      }
    }
  });
});

describe("parseWireframe: dequantization roundtrip", () => {
  const data = parseWireframe(raw);

  it("keeps worst-case quantization error under 2 mm on every axis", () => {
    for (let c = 0; c < 3; c += 1) {
      const extent = (data.bbox.max[c] ?? 0) - (data.bbox.min[c] ?? 0);
      expect(extent).toBeGreaterThan(0);
      expect(extent / 32767 / 2).toBeLessThan(0.002);
    }
  });

  it("re-quantizing every parsed position reproduces the raw int exactly", () => {
    const { min, max } = data.bbox;
    for (let n = 0; n < data.nodes.length; n += 1) {
      const parsed = must(data.nodes[n], `parsed node ${n}`);
      const source = must(raw.nodes[n], `raw node ${n}`);
      expect(parsed.name).toBe(source.name);
      for (let i = 0; i < parsed.positions.length; i += 1) {
        const c = i % 3;
        const extent = (max[c] ?? 0) - (min[c] ?? 0);
        const p = parsed.positions[i] ?? Number.NaN;
        const q = Math.round(((p - (min[c] ?? 0)) / extent) * 32767);
        expect(q).toBe(source.positions[i]);
      }
    }
  });

  it("hands back unit normals, one per edge, for every node", () => {
    for (const node of data.nodes) {
      expect(node.normals.length).toBe(node.edgeCount * 3);
      for (let e = 0; e < node.edgeCount; e += 1) {
        const len = Math.hypot(
          must(node.normals[e * 3]),
          must(node.normals[e * 3 + 1]),
          must(node.normals[e * 3 + 2]),
        );
        // project.ts treats dot(normal, view) as a cosine and compares it to
        // tier thresholds; that is only true of a unit vector.
        expect(len).toBeCloseTo(1, 5);
      }
    }
  });

  it("keeps the int8 normal roundtrip inside half a degree of direction", () => {
    // The contract is DIRECTION, not the stored ints (parse renormalizes, so
    // re-quantizing is not the identity). Asserted against the raw document:
    // the parsed normal must point where the stored triple points.
    let worstDeg = 0;
    for (let n = 0; n < data.nodes.length; n += 1) {
      const parsed = must(data.nodes[n], `node ${n}`);
      const source = must(raw.nodes[n], `raw node ${n}`).normals;
      for (let e = 0; e < parsed.edgeCount; e += 1) {
        const rx = must(source[e * 3]) / 127;
        const ry = must(source[e * 3 + 1]) / 127;
        const rz = must(source[e * 3 + 2]) / 127;
        const rl = Math.hypot(rx, ry, rz);
        const dot =
          (must(parsed.normals[e * 3]) * rx +
            must(parsed.normals[e * 3 + 1]) * ry +
            must(parsed.normals[e * 3 + 2]) * rz) /
          rl;
        expect(dot).toBeCloseTo(1, 6); // same direction, length normalized away
      }
    }

    // And the quantization step itself, measured over the sphere: the worst
    // direction error an int8 lattice can introduce, using the documented
    // formula from types.ts. This is the number the format doc claims.
    for (let i = 0; i < 4000; i += 1) {
      // deterministic quasi-random directions — no seeded RNG needed
      const a = (i * 2.399963229728653) % (Math.PI * 2);
      const c = (i / 2000) * 2 - 1;
      const s = Math.sqrt(Math.max(0, 1 - c * c));
      const v = [s * Math.cos(a), s * Math.sin(a), c] as const;
      const q = v.map((x) => Math.max(-127, Math.min(127, Math.round(x * 127))));
      const ql = Math.hypot(must(q[0]), must(q[1]), must(q[2]));
      if (ql === 0) continue;
      const dot = (must(q[0]) * v[0] + must(q[1]) * v[1] + must(q[2]) * v[2]) / ql;
      worstDeg = Math.max(worstDeg, (Math.acos(Math.min(1, dot)) * 180) / Math.PI);
    }
    expect(worstDeg).toBeLessThan(0.5);
  });

  it("dequantizes q=0 / q=32767 / midpoints to the documented values", () => {
    const doc: WireframeJson = {
      v: 2,
      bbox: { min: [-1, 0, 2], max: [1, 2, 6] },
      nodes: [
        {
          name: "probe",
          vertexCount: 3,
          positions: [0, 0, 0, 32767, 32767, 32767, 16384, 16384, 16384],
          edges: [0, 1, 1, 2],
          normals: [0, 0, 127, 0, 0, -127],
        },
      ],
    };
    const parsed = parseWireframe(doc);
    const probe = must(parsed.byName.get("probe"), "probe");
    const got = Array.from(probe.positions);
    const mid = 16384 / 32767;
    const want = [-1, 0, 2, 1, 2, 6, -1 + mid * 2, mid * 2, 2 + mid * 4];
    for (let i = 0; i < want.length; i += 1) {
      expect(got[i]).toBeCloseTo(must(want[i]), 5);
    }
    // ...and the two edges' normals come back as exact unit axes.
    expect(Array.from(probe.normals)).toEqual([0, 0, 1, 0, 0, -1]);
  });

  it("renormalizes an off-unit quantized triple instead of trusting /127", () => {
    // round(1/sqrt(3) * 127) = 73 on each axis; 73/127 each is 0.9950 long,
    // which would read as a cosine of 0.995 at grazing incidence and shift a
    // tier boundary. parse must hand back a true unit vector.
    const doc: WireframeJson = {
      v: 2,
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      nodes: [
        {
          name: "probe",
          vertexCount: 2,
          positions: [0, 0, 0, 32767, 32767, 32767],
          edges: [0, 1],
          normals: [73, 73, 73],
        },
      ],
    };
    const probe = must(parseWireframe(doc).byName.get("probe"), "probe");
    const third = 1 / Math.sqrt(3);
    for (let c = 0; c < 3; c += 1) {
      expect(must(probe.normals[c])).toBeCloseTo(third, 5);
    }
    expect(Math.hypot(...Array.from(probe.normals))).toBeCloseTo(1, 6);
  });
});
