#!/usr/bin/env node
/**
 * verify-chassis-silhouette.mjs — Fleet Console tooling
 *
 * Zero-dependency GLB checker for public/models/chassis-silhouette.glb.
 * Parses the glTF 2.0 binary container directly (no three.js needed) and
 * asserts the contract:
 *
 * - file size < 500 KB
 * - total triangles < 15,000
 * - all 8 component nodes present by exact name:
 * head, torso, arm_L, arm_R, leg_L, leg_R,
 * knee_actuator_L, knee_actuator_R
 * - world bounding box height ~1.6-1.7 m
 *
 * Also prints per-node triangle/vertex counts and runs a winding sanity
 * check (signed volume of every closed primitive must be positive, i.e.
 * CCW front faces pointing outward).
 *
 * Run: node scripts/verify-chassis-silhouette.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "public", "models", "chassis-silhouette.glb");

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

/* ------------------------------------------------------- GLB parsing */

const buf = readFileSync(FILE);
if (buf.readUInt32LE(0) !== 0x46546c67) fail("not a GLB (bad magic)");
if (buf.readUInt32LE(4) !== 2) fail("unsupported glTF version");
if (buf.readUInt32LE(8) !== buf.byteLength) fail("GLB length field mismatch");

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
if (!json || !bin) fail("missing JSON or BIN chunk");

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

const xform = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

/* ----------------------------------------------------------- checks */

let failures = 0;
function fail(msg) {
  console.error(`FAIL  ${msg}`);
  failures++;
  if (!json) process.exit(1); // structural failure: cannot continue
}
const pass = (msg) => console.log(`ok    ${msg}`);

// walk scene graph
const stats = new Map(); // name -> {tris, verts}
const gMin = [Infinity, Infinity, Infinity];
const gMax = [-Infinity, -Infinity, -Infinity];
let totalTris = 0;
let badWinding = 0;

function visit(nodeIdx, parentMat) {
  const node = json.nodes[nodeIdx];
  const world = matMul(parentMat, localMatrix(node));
  let tris = 0,
    verts = 0;
  if (node.mesh !== undefined) {
    for (const prim of json.meshes[node.mesh].primitives) {
      const posAcc = json.accessors[prim.attributes.POSITION];
      const idx = prim.indices !== undefined ? readAccessor(prim.indices) : null;
      const nTris = (idx ? idx.length : posAcc.count) / 3;
      tris += nTris;
      verts += posAcc.count;
      // world bbox from accessor min/max corners
      for (let cx = 0; cx < 2; cx++)
        for (let cy = 0; cy < 2; cy++)
          for (let cz = 0; cz < 2; cz++) {
            const p = xform(world, [
              (cx ? posAcc.max : posAcc.min)[0],
              (cy ? posAcc.max : posAcc.min)[1],
              (cz ? posAcc.max : posAcc.min)[2],
            ]);
            for (let c = 0; c < 3; c++) {
              gMin[c] = Math.min(gMin[c], p[c]);
              gMax[c] = Math.max(gMax[c], p[c]);
            }
          }
      // winding sanity: signed volume of the (closed) primitive, local space
      if (idx) {
        const pos = readAccessor(prim.attributes.POSITION);
        let vol6 = 0;
        for (let i = 0; i < idx.length; i += 3) {
          const a = idx[i] * 3,
            b = idx[i + 1] * 3,
            c = idx[i + 2] * 3;
          vol6 +=
            pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
            pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
            pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
        }
        if (vol6 <= 0) badWinding++;
      }
    }
    totalTris += tris;
    if (node.name) {
      const prev = stats.get(node.name) ?? { tris: 0, verts: 0 };
      stats.set(node.name, { tris: prev.tris + tris, verts: prev.verts + verts });
    }
  }
  for (const child of node.children ?? []) visit(child, world);
}

for (const rootIdx of json.scenes[json.scene ?? 0].nodes) visit(rootIdx, ID);

/* ----------------------------------------------------------- report */

console.log(`\nchassis-silhouette.glb — verification\n`);
console.log(`  per-node triangles:`);
for (const [name, s] of stats)
  console.log(
    `    ${name.padEnd(18)} ${String(s.tris).padStart(6)} tris  ${String(s.verts).padStart(6)} verts`,
  );

const kb = buf.byteLength / 1024;
const height = gMax[1] - gMin[1];
console.log(`\n  file size : ${buf.byteLength} bytes (${kb.toFixed(1)} KB)`);
console.log(`  triangles : ${totalTris}`);
console.log(
  `  bbox      : x [${gMin[0].toFixed(3)}, ${gMax[0].toFixed(3)}]  y [${gMin[1].toFixed(3)}, ${gMax[1].toFixed(3)}]  z [${gMin[2].toFixed(3)}, ${gMax[2].toFixed(3)}]`,
);
console.log(`  height    : ${height.toFixed(3)} m\n`);

if (buf.byteLength < 500_000) pass(`file size ${kb.toFixed(1)} KB < 500 KB`);
else fail(`file size ${kb.toFixed(1)} KB >= 500 KB`);
if (totalTris < 15_000) pass(`total triangles ${totalTris} < 15000`);
else fail(`total triangles ${totalTris} >= 15000`);
for (const name of REQUIRED) {
  if (stats.has(name) && stats.get(name).tris > 0)
    pass(`node "${name}" present with geometry`);
  else fail(`node "${name}" missing or empty`);
}
if (height >= 1.6 && height <= 1.7)
  pass(`height ${height.toFixed(3)} m within 1.6-1.7 m`);
else fail(`height ${height.toFixed(3)} m outside 1.6-1.7 m`);
if (badWinding === 0) pass(`winding: all primitives have positive signed volume`);
else fail(`winding: ${badWinding} primitive(s) with non-positive signed volume`);

const extras = [...stats.keys()].filter((n) => !REQUIRED.includes(n));
if (extras.length) console.log(`note  extra mesh-bearing nodes: ${extras.join(", ")}`);

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll checks passed.`);
