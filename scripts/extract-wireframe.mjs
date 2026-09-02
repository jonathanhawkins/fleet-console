#!/usr/bin/env node
/**
 * extract-wireframe.mjs — Fleet Console tooling
 *
 * Offline feature-edge extractor for public/models/chassis-silhouette.glb.
 * Emits public/models/chassis-wireframe.json: a compact, quantized wireframe
 * of the robot so machine space can draw the actual model as a phosphor
 * line drawing WITHOUT shipping three.js (the runtime projector is
 * lib/wireframe — pure math over this JSON).
 *
 * Zero dependencies: parses the glTF 2.0 binary container directly, the
 * same way scripts/verify-chassis-silhouette.mjs does.
 *
 * Run: node scripts/extract-wireframe.mjs
 * Explore: node scripts/extract-wireframe.mjs --histogram [--threshold=22]
 * (prints the per-node dihedral-angle distribution, no write)
 *
 * Pipeline, per named component node (world space, so the JSON needs no
 * scene graph):
 * 1. weld vertices at WELD = 1e-4 m (merges cap-rim duplicates and
 * primitive seams so edge adjacency is real)
 * 2. classify edges:
 * boundary — used by exactly one triangle (open surfaces)
 * crease — used by two triangles whose dihedral angle exceeds
 * CREASE_DEG (feature lines; on this model's smooth
 * parametric bodies the azimuthal tessellation seams
 * sit near 11-19°, so CREASE_DEG is tuned BELOW the
 * nominal ~28° — at 28° only cap rims survive and the
 * limbs vanish entirely; see --histogram)
 * non-manifold (>2 uses) — kept, they are always feature-ish
 * 3. decimate collinear chains: interior vertices of degree 2 whose two
 * segments bend less than COLLINEAR_DEG are removed (straight runs
 * become single segments)
 * 4. average each surviving edge's adjacent-face normals and quantize to
 * int8; reindex to the surviving vertices and quantize positions to
 * int16
 *
 * Output format (v2) — mirrored by lib/wireframe/types.ts:
 * {
 * "v": 2,
 * "bbox": { "min": [x,y,z], "max": [x,y,z] }, // meters, world space
 * "nodes": [
 * {
 * "name": "knee_actuator_L",
 * "vertexCount": n,
 * "positions": [int16 ...], // n*3 values, x y z interleaved
 * "edges": [i0,j0, i1,j1 ...],// vertex-index pairs into positions
 * "normals": [int8 ...] // edges.length/2 * 3 values, xyz
 * }
 * ]
 * }
 * Position quantization (per axis, over the shared model bbox):
 * q = round((p - min) / (max - min) * 32767) // 0 … 32767
 * p̂ = min + (q / 32767) * (max - min)
 * Worst-case roundtrip error = extent / 32767 / 2 ≈ 0.03 mm on the tall
 * axis — far inside the 2 mm contract. Plain JSON int arrays on purpose:
 * gzip eats them, and the asset stays diffable and debuggable.
 *
 * Normal quantization (v2), per component of the unit average normal:
 * q = round(clamp(n, -1, 1) * 127) // -127 … 127
 * n̂ = renormalize(q / 127)
 * The renderer only ever uses these through a dot product against the view
 * direction, so DIRECTION is the whole contract: an int8 grid resolves a
 * unit vector to well under a degree, which is two orders of magnitude
 * finer than the tier thresholds it feeds. What the normals buy is
 * legibility — machine space classifies each edge per frame as back-facing
 * (ghost), front-facing (depth-cued body) or silhouette (contour), which is
 * the only thing that keeps 1 990 equal-weight lines from turning into felt
 * at an oblique yaw. See lib/wireframe/project.ts.
 *
 * Which faces are averaged: a crease edge averages its two, a boundary edge
 * takes its one, a non-manifold edge averages all of them. A decimated
 * chain averages the normals of the edges it replaced. Winding is trusted
 * (glTF 2.0 §3.7.2.1: counter-clockwise is front-facing) and VERIFIED by
 * signed volume — Σ a·(b×c)/6 over each node's welded triangles, which is
 * positive exactly when the winding puts the normals outside. The run
 * reports it per node and fails on a negative one, because an inside-out
 * export would ghost the NEAR limb and light the far one: a wrongness that
 * reads as a taste decision rather than a bug.
 *
 * Budget: raw JSON < 120 KB (the machine chunk is small; this file is
 * fetched lazily). The script fails the run if the budget is exceeded.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IN = join(ROOT, "public", "models", "chassis-silhouette.glb");
const OUT = join(ROOT, "public", "models", "chassis-wireframe.json");

const REQUIRED = [
  "head",
  "torso",
  "arm_L",
  "arm_R",
  "leg_L",
  "leg_R",
  "knee_actuator_L",
  "knee_actuator_R",
];

/* ------------------------------------------------------------- tuning */

const WELD = 1e-4; // m — vertex weld tolerance
/** Dihedral threshold, degrees. Nominal spec is ~28°, but this model is
 * smooth parametric solids: at 28° only cylinder-cap rims survive (arms
 * and legs reduce to a handful of floating rings). 17° admits the
 * azimuthal tessellation seams — longitudinal contour wires down the
 * limbs, the neck, shoulder and pelvis curves — which is what makes the
 * figure read as a robot at 1 px. Tuned visually (rasterized previews at
 * yaw 0/35/90°) against the raw-size budget; see --histogram. */
const DEFAULT_CREASE_DEG = 17;
const COLLINEAR_DEG = 2; // chain decimation: keep bends sharper than this
const BUDGET_RAW = 120 * 1024;

const args = process.argv.slice(2);
const HISTOGRAM = args.includes("--histogram");
const creaseArg = args.find((a) => a.startsWith("--threshold="));
const CREASE_DEG = creaseArg ? Number(creaseArg.split("=")[1]) : DEFAULT_CREASE_DEG;
if (!Number.isFinite(CREASE_DEG) || CREASE_DEG <= 0) {
  console.error(`bad --threshold: ${creaseArg}`);
  process.exit(1);
}

/* ------------------------------------------------------- GLB parsing */
/* Same container walk as scripts/verify-chassis-silhouette.mjs. */

const buf = readFileSync(IN);
if (buf.readUInt32LE(0) !== 0x46546c67) die("not a GLB (bad magic)");
if (buf.readUInt32LE(4) !== 2) die("unsupported glTF version");

let off = 12;
let json = null;
let bin = null;
while (off < buf.byteLength) {
  const chunkLen = buf.readUInt32LE(off);
  const chunkType = buf.readUInt32LE(off + 4);
  const chunk = buf.subarray(off + 8, off + 8 + chunkLen);
  if (chunkType === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
  else if (chunkType === 0x004e4942) bin = chunk;
  off += 8 + chunkLen;
}
if (!json || !bin) die("missing JSON or BIN chunk");

const COMP = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(i) {
  const acc = json.accessors[i];
  const bv = json.bufferViews[acc.bufferView];
  const T = COMP[acc.componentType];
  const n = NCOMP[acc.type];
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const slice = bin.subarray(start, start + acc.count * n * T.BYTES_PER_ELEMENT);
  return new T(slice.buffer, slice.byteOffset, acc.count * n);
}

/* -------------------------------------------- node transforms (TRS) */

const matMul = (a, b) => {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let rw = 0; rw < 4; rw++)
      for (let k = 0; k < 4; k++) r[c * 4 + rw] += a[k * 4 + rw] * b[c * 4 + k];
  return r;
};
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function localMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx,
    y2 = qy + qy,
    z2 = qz + qz;
  const xx = qx * x2,
    xy = qx * y2,
    xz = qx * z2;
  const yy = qy * y2,
    yz = qy * z2,
    zz = qz * z2;
  const wx = qw * x2,
    wy = qw * y2,
    wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function die(msg) {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}

/* ----------------------------------- gather world-space tris per node */
/* A named component owns its mesh plus any descendant meshes. */

const nodeTris = new Map(); // name -> { pos: number[], tris: number[] } (raw, unwelded)

function collect(nodeIdx, parentMat, into) {
  const node = json.nodes[nodeIdx];
  const world = matMul(parentMat, localMatrix(node));
  const target = into ?? (node.name && REQUIRED.includes(node.name) ? node.name : null);
  if (target && node.mesh !== undefined) {
    const acc = nodeTris.get(target) ?? { pos: [], tris: [] };
    for (const prim of json.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4) die(`non-triangle primitive under ${target}`);
      const pos = readAccessor(prim.attributes.POSITION);
      const idx =
        prim.indices !== undefined
          ? readAccessor(prim.indices)
          : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      const base = acc.pos.length / 3;
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i],
          y = pos[i + 1],
          z = pos[i + 2];
        acc.pos.push(
          world[0] * x + world[4] * y + world[8] * z + world[12],
          world[1] * x + world[5] * y + world[9] * z + world[13],
          world[2] * x + world[6] * y + world[10] * z + world[14],
        );
      }
      for (const i of idx) acc.tris.push(base + i);
    }
    nodeTris.set(target, acc);
  }
  for (const child of node.children ?? []) collect(child, world, target);
}

for (const rootIdx of json.scenes[json.scene ?? 0].nodes) collect(rootIdx, ID, null);

for (const name of REQUIRED)
  if (!nodeTris.has(name)) die(`required node "${name}" not found or empty`);

/* --------------------------------------------------- model bbox (all) */
/* The shared quantization frame: every welded vertex of every node. */

const bboxMin = [Infinity, Infinity, Infinity];
const bboxMax = [-Infinity, -Infinity, -Infinity];
for (const { pos } of nodeTris.values())
  for (let i = 0; i < pos.length; i += 3)
    for (let c = 0; c < 3; c++) {
      bboxMin[c] = Math.min(bboxMin[c], pos[i + c]);
      bboxMax[c] = Math.max(bboxMax[c], pos[i + c]);
    }
const extent = bboxMax.map((v, c) => v - bboxMin[c]);

/* ------------------------------------------------- per-node pipeline */

const cosCollinear = Math.cos((COLLINEAR_DEG * Math.PI) / 180);
const creaseRad = (CREASE_DEG * Math.PI) / 180;

function extractNode(name) {
  const { pos, tris } = nodeTris.get(name);

  // 1. weld — snap to a WELD-sized grid, dedupe by cell
  const cell = new Map(); // "x,y,z" -> welded index
  const remap = new Uint32Array(pos.length / 3);
  const vx = [],
    vy = [],
    vz = [];
  for (let i = 0; i < pos.length / 3; i++) {
    const key =
      `${Math.round(pos[i * 3] / WELD)},` +
      `${Math.round(pos[i * 3 + 1] / WELD)},` +
      `${Math.round(pos[i * 3 + 2] / WELD)}`;
    let w = cell.get(key);
    if (w === undefined) {
      w = vx.length;
      cell.set(key, w);
      vx.push(pos[i * 3]);
      vy.push(pos[i * 3 + 1]);
      vz.push(pos[i * 3 + 2]);
    }
    remap[i] = w;
  }

  let nDegenerate = 0;
  let signedVolume = 0; // winding check, accumulated with the face normals

  // 2. edge → adjacent-face-normals map
  const edgeFaces = new Map(); // "i_j" (i<j) -> array of unit normals
  const angles = []; // manifold dihedral angles, for --histogram
  for (let t = 0; t < tris.length; t += 3) {
    const a = remap[tris[t]],
      b = remap[tris[t + 1]],
      c = remap[tris[t + 2]];
    if (a === b || b === c || a === c) continue; // degenerate after weld
    // face normal
    const ux = vx[b] - vx[a],
      uy = vy[b] - vy[a],
      uz = vz[b] - vz[a];
    const wx2 = vx[c] - vx[a],
      wy2 = vy[c] - vy[a],
      wz2 = vz[c] - vz[a];
    let nx = uy * wz2 - uz * wy2,
      ny = uz * wx2 - ux * wz2,
      nz = ux * wy2 - uy * wx2;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12) continue; // zero-area
    // Signed volume of the tetrahedron (origin, a, b, c) — summed over a
    // closed mesh this is +V for outward (CCW) winding, -V for inward.
    signedVolume +=
      (vx[a] * (vy[b] * vz[c] - vz[b] * vy[c]) +
        vy[a] * (vz[b] * vx[c] - vx[b] * vz[c]) +
        vz[a] * (vx[b] * vy[c] - vy[b] * vx[c])) /
      6;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = i < j ? `${i}_${j}` : `${j}_${i}`;
      const list = edgeFaces.get(key);
      if (list) list.push([nx, ny, nz]);
      else edgeFaces.set(key, [[nx, ny, nz]]);
    }
  }

  // classify, and remember each survivor's average adjacent-face normal
  let nBoundary = 0,
    nCrease = 0,
    nNonManifold = 0;
  const selected = new Set(); // "i_j" keys
  const edgeNormal = new Map(); // "i_j" -> [nx, ny, nz], unit
  /** Mean of a face-normal list; null when they cancel (a perfect knife edge). */
  const meanNormal = (normals) => {
    let sx = 0,
      sy = 0,
      sz = 0;
    for (const [nx, ny, nz] of normals) {
      sx += nx;
      sy += ny;
      sz += nz;
    }
    const l = Math.hypot(sx, sy, sz);
    return l < 1e-9 ? null : [sx / l, sy / l, sz / l];
  };
  const keep = (key, normals) => {
    selected.add(key);
    // A perfect knife edge (two faces folded flat back on each other) has no
    // mean direction. Fall back to one of the two real face normals: it is
    // still a true surface direction, which keeps the edge classifiable
    // instead of stranding it forever on the contour threshold.
    let n = meanNormal(normals);
    if (!n) {
      n = normals[0];
      nDegenerate++;
    }
    edgeNormal.set(key, n);
  };
  for (const [key, normals] of edgeFaces) {
    if (normals.length === 1) {
      nBoundary++;
      keep(key, normals);
    } else if (normals.length === 2) {
      const [p, q] = normals;
      const dot = Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
      const ang = Math.acos(dot);
      angles.push(ang);
      if (ang > creaseRad) {
        nCrease++;
        keep(key, normals);
      }
    } else {
      nNonManifold++;
      keep(key, normals);
    }
  }

  // 3. decimate collinear chains (repeat until stable)
  const degree = new Map(); // vertex -> Set of neighbor vertices
  const link = (i, j) => {
    (degree.get(i) ?? degree.set(i, new Set()).get(i)).add(j);
    (degree.get(j) ?? degree.set(j, new Set()).get(j)).add(i);
  };
  const unlink = (i, j) => {
    degree.get(i)?.delete(j);
    degree.get(j)?.delete(i);
  };
  for (const key of selected) {
    const [i, j] = key.split("_").map(Number);
    link(i, j);
  }
  const ekey = (i, j) => (i < j ? `${i}_${j}` : `${j}_${i}`);
  let removed = 0,
    changed = true;
  while (changed) {
    changed = false;
    for (const [v, nbrs] of degree) {
      if (nbrs.size !== 2) continue;
      const [a, b] = [...nbrs];
      if (a === b) continue;
      // collinear? compare directions a→v and v→b
      const d1x = vx[v] - vx[a],
        d1y = vy[v] - vy[a],
        d1z = vz[v] - vz[a];
      const d2x = vx[b] - vx[v],
        d2y = vy[b] - vy[v],
        d2z = vz[b] - vz[v];
      const l1 = Math.hypot(d1x, d1y, d1z),
        l2 = Math.hypot(d2x, d2y, d2z);
      if (l1 < 1e-12 || l2 < 1e-12) continue;
      const dot = (d1x * d2x + d1y * d2y + d1z * d2z) / (l1 * l2);
      if (dot < cosCollinear) continue;
      if (selected.has(ekey(a, b))) continue; // would create a duplicate
      // The merged segment inherits the mean of what it replaced. Both halves
      // are collinear in space and sit on the same surface run, so their
      // normals agree to within the tessellation step — the mean is the same
      // vector either half would have contributed on its own.
      const merged = meanNormal([
        edgeNormal.get(ekey(a, v)) ?? [0, 0, 0],
        edgeNormal.get(ekey(v, b)) ?? [0, 0, 0],
      ]) ?? [0, 1, 0];
      edgeNormal.delete(ekey(a, v));
      edgeNormal.delete(ekey(v, b));
      edgeNormal.set(ekey(a, b), merged);
      selected.delete(ekey(a, v));
      selected.delete(ekey(v, b));
      selected.add(ekey(a, b));
      unlink(a, v);
      unlink(v, b);
      link(a, b);
      removed++;
      changed = true;
    }
  }

  // 4. reindex surviving vertices, quantize to int16 over the model bbox
  const used = new Map(); // welded index -> output index
  const positions = [];
  const quant = (p, c) =>
    extent[c] === 0 ? 0 : Math.round(((p - bboxMin[c]) / extent[c]) * 32767);
  const outIndex = (w) => {
    let o = used.get(w);
    if (o === undefined) {
      o = used.size;
      used.set(w, o);
      positions.push(quant(vx[w], 0), quant(vy[w], 1), quant(vz[w], 2));
    }
    return o;
  };
  const edges = [];
  const normals = [];
  const qn = (n) => Math.max(-127, Math.min(127, Math.round(n * 127)));
  for (const key of selected) {
    const [i, j] = key.split("_").map(Number);
    edges.push(outIndex(i), outIndex(j));
    const n = edgeNormal.get(key) ?? [0, 1, 0];
    normals.push(qn(n[0]), qn(n[1]), qn(n[2]));
  }

  return {
    node: { name, vertexCount: used.size, positions, edges, normals },
    stats: {
      nBoundary,
      nCrease,
      nNonManifold,
      removed,
      angles,
      welded: vx.length,
      nDegenerate,
      signedVolume,
    },
  };
}

/* -------------------------------------------------------- run + report */

console.log(
  `\nchassis-wireframe extraction — crease threshold ${CREASE_DEG}°, weld ${WELD} m\n`,
);

if (HISTOGRAM) {
  // dihedral-angle distribution per node, to pick the threshold
  const BUCKETS = [5, 10, 12, 14, 16, 18, 20, 22, 25, 28, 35, 45, 60, 90, 180];
  console.log(
    `  dihedral histogram (manifold edges, ° buckets: ≤${BUCKETS.join(", ≤")})`,
  );
  for (const name of REQUIRED) {
    const { stats } = extractNode(name);
    const counts = new Array(BUCKETS.length).fill(0);
    for (const a of stats.angles) {
      const deg = (a * 180) / Math.PI;
      counts[BUCKETS.findIndex((b) => deg <= b)]++;
    }
    console.log(
      `    ${name.padEnd(18)} ${counts.map((c) => String(c).padStart(6)).join("")}`,
    );
  }
  process.exit(0);
}

const nodes = [];
let totalEdges = 0,
  totalVerts = 0,
  totalDegenerate = 0;
const inverted = [];
console.log(
  `  ${"node".padEnd(18)} ${"verts".padStart(6)} ${"edges".padStart(6)}   boundary crease nonmani  chain-removed   signed vol`,
);
for (const name of REQUIRED) {
  const { node, stats } = extractNode(name);
  if (node.edges.length === 0)
    die(`node "${name}" produced zero edges — lower the threshold`);
  nodes.push(node);
  const ne = node.edges.length / 2;
  totalEdges += ne;
  totalVerts += node.vertexCount;
  totalDegenerate += stats.nDegenerate;
  if (stats.signedVolume <= 0) inverted.push(name);
  console.log(
    `  ${name.padEnd(18)} ${String(node.vertexCount).padStart(6)} ${String(ne).padStart(6)}   ` +
      `${String(stats.nBoundary).padStart(8)} ${String(stats.nCrease).padStart(6)} ${String(stats.nNonManifold).padStart(7)}  ${String(stats.removed).padStart(13)}` +
      `  ${(stats.signedVolume * 1e3).toFixed(3).padStart(11)} L`,
  );
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;
const out = {
  v: 2,
  bbox: { min: bboxMin.map(round4), max: bboxMax.map(round4) },
  nodes,
};
const text = JSON.stringify(out);
const gz = gzipSync(Buffer.from(text), { level: 9 });

console.log(`\n  total     : ${totalVerts} verts, ${totalEdges} edges`);
console.log(
  `  bbox      : x [${out.bbox.min[0]}, ${out.bbox.max[0]}]  y [${out.bbox.min[1]}, ${out.bbox.max[1]}]  z [${out.bbox.min[2]}, ${out.bbox.max[2]}]`,
);
console.log(
  `  raw       : ${text.length} bytes (${(text.length / 1024).toFixed(1)} KB, budget ${BUDGET_RAW / 1024} KB)`,
);
console.log(`  gzip      : ${gz.length} bytes (${(gz.length / 1024).toFixed(1)} KB)`);
console.log(
  `  normals   : every node outward-wound, ` +
    `${totalDegenerate} cancelled average${totalDegenerate === 1 ? "" : "s"}`,
);

// Winding guard — see the header. Asserted at extraction time because an
// inverted normal set does not crash anything: it just ghosts the near limb
// and lights the far one, which looks like a taste decision until someone
// stares at the demo long enough to realise the robot is inside-out.
if (inverted.length > 0)
  die(
    `negative signed volume on ${inverted.join(", ")} — the GLB is wound ` +
      `inside-out; facing classification would be inverted`,
  );

if (text.length > BUDGET_RAW)
  die(
    `raw JSON ${(text.length / 1024).toFixed(1)} KB exceeds ${BUDGET_RAW / 1024} KB — raise --threshold`,
  );

writeFileSync(OUT, text);
console.log(`\n  wrote ${relative(ROOT, OUT)}\n`);
