/**
 * preview-wireframe.ts — offline contact sheet for the wireframe's luminance
 * ladder. Tuning instrument, not part of the build.
 *
 *   pnpm tsx scripts/preview-wireframe.ts [out.png] [--yaws=0,35,90,135]
 *                                         [--flag] [--flat] [--w=260] [--h=560]
 *
 * `--flat` draws every edge at ALPHA_BASE — format v1's single-alpha figure,
 * kept as a rendering mode so the before/after is one command apart and the
 * argument for the ladder can be looked at rather than described.
 *
 * The tiers in `lib/wireframe/tiers.ts` are a taste feature: the thresholds
 * and alphas are defensible in prose but only settle by eye, and the question
 * they answer ("at 90°, can you tell which arm is in front?") is one you have
 * to LOOK at. Doing that through the app means a dev server, a descent, and a
 * turntable you have to catch at the right angle. This renders the same
 * ladder, the same projector and the same model straight to a PNG at any set
 * of yaws in about a second.
 *
 * It imports `parse`, `project` and `tiers` rather than reimplementing them,
 * so what you are looking at is what the board draws — the only thing modelled
 * separately here is the rasterizer, which is Xiaolin Wu's anti-aliased line
 * (canvas's own 1 px stroke to within a hair) over a `--void` ground.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { parseWireframe } from "../lib/wireframe/parse";
import { projectWireframe } from "../lib/wireframe/project";
import {
  ALPHA_BASE,
  DEPTH_STEPS,
  depthScale,
  LEVEL_ALPHA,
  levelFor,
} from "../lib/wireframe/tiers";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ palette */
/* app/globals.css: --void #060606, --phosphor #3bff6f, --alert-red #ff3b30. */
const VOID = [0x06, 0x06, 0x06] as const;
const INK = [0x3b, 0xff, 0x6f] as const;
const ALERT = [0xff, 0x3b, 0x30] as const;
const ALPHA_ALERT = 0.95; // mirrors wireframe-elevation.tsx
const LABEL = [0x3b, 0xff, 0x6f] as const;

/* --------------------------------------------------------------------- args */

const args = process.argv.slice(2);
const flagOn = args.includes("--flag");
const flatOn = args.includes("--flat"); // draw v1: one alpha for every edge
const opt = (name: string, fallback: string): string =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const outPath =
  args.find((a) => !a.startsWith("--")) ?? join(ROOT, "wireframe-tiers.png");
const yaws = opt("yaws", "0,35,90,135").split(",").map(Number);
const CELL_W = Number(opt("w", "260"));
const CELL_H = Number(opt("h", "560"));
const MARGIN = 6; // matches the component
const GUTTER = 1;
const LABEL_H = 12;

/* ---------------------------------------------------------------- raster ops */

const W = CELL_W * yaws.length + GUTTER * (yaws.length - 1);
const H = CELL_H + LABEL_H;
const rgb = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i += 1) {
  rgb[i * 3] = VOID[0];
  rgb[i * 3 + 1] = VOID[1];
  rgb[i * 3 + 2] = VOID[2];
}

/** Source-over one pixel. */
function blend(x: number, y: number, c: readonly number[], a: number): void {
  if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  const p = (y * W + x) * 3;
  const k = a > 1 ? 1 : a;
  for (let ch = 0; ch < 3; ch += 1) {
    rgb[p + ch] = Math.round((rgb[p + ch] ?? 0) * (1 - k) + (c[ch] ?? 0) * k);
  }
}

/** Xiaolin Wu anti-aliased line, one pixel wide. */
function line(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: readonly number[],
  a: number,
): void {
  const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
  let [ax, ay, bx, by] = steep ? [y0, x0, y1, x1] : [x0, y0, x1, y1];
  if (ax > bx) [ax, ay, bx, by] = [bx, by, ax, ay];
  const dx = bx - ax;
  const gradient = dx === 0 ? 1 : (by - ay) / dx;
  const put = (u: number, v: number, w: number) =>
    steep
      ? blend(Math.round(v), Math.round(u), c, a * w)
      : blend(Math.round(u), Math.round(v), c, a * w);
  let inter = ay + gradient * (Math.round(ax) - ax);
  for (let x = Math.round(ax); x <= Math.round(bx); x += 1) {
    const f = inter - Math.floor(inter);
    put(x, Math.floor(inter), 1 - f);
    put(x, Math.floor(inter) + 1, f);
    inter += gradient;
  }
}

/* ---------------------------------------------------------- a 3x5 pixel font */
/* Just enough to stamp the yaw under each cell. */
const GLYPHS: Record<string, string> = {
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "111001111100111",
  "3": "111001111001111",
  "4": "101101111001001",
  "5": "111100111001111",
  "6": "111100111101111",
  "7": "111001001001001",
  "8": "111101111101111",
  "9": "111101111001111",
  "°": "111101111000000",
  " ": "000000000000000",
};
function stamp(text: string, x: number, y: number): void {
  let cx = x;
  for (const ch of text) {
    const bits = GLYPHS[ch] ?? GLYPHS[" "] ?? "";
    for (let i = 0; i < 15; i += 1) {
      if (bits[i] === "1") blend(cx + (i % 3), y + Math.floor(i / 3), LABEL, 0.7);
    }
    cx += 4;
  }
}

/* --------------------------------------------------------------- the drawing */

const data = parseWireframe(
  JSON.parse(readFileSync(join(ROOT, "public/models/chassis-wireframe.json"), "utf8")),
);
const flagged = flagOn
  ? data.nodes.indexOf(data.byName.get("knee_actuator_L") ?? data.nodes[0]!)
  : -1;

const tallies: Array<Map<number, number>> = yaws.map(() => new Map());
for (let cell = 0; cell < yaws.length; cell += 1) {
  const tally = tallies[cell] ?? new Map<number, number>();
  const originX = cell * (CELL_W + GUTTER);
  const fig = projectWireframe(data, {
    yawRad: ((yaws[cell] ?? 0) * Math.PI) / 180,
    viewport: { w: CELL_W, h: CELL_H },
    margin: MARGIN,
  });
  const dMin = fig.depthMin;
  const dScale = depthScale(dMin, fig.depthMax);

  for (let n = 0; n < fig.xy.length; n += 1) {
    const xy = fig.xy[n];
    const face = fig.facing[n];
    const deep = fig.depth[n];
    if (!xy || !face || !deep) continue;
    for (let i = 0; i < face.length; i += 1) {
      const isFlag = n === flagged;
      const level = isFlag ? -1 : levelFor(face[i] ?? 0, deep[i] ?? 0, dMin, dScale);
      tally.set(level, (tally.get(level) ?? 0) + 1);
      line(
        originX + (xy[i * 4] ?? 0),
        xy[i * 4 + 1] ?? 0,
        originX + (xy[i * 4 + 2] ?? 0),
        xy[i * 4 + 3] ?? 0,
        isFlag ? ALERT : INK,
        isFlag ? ALPHA_ALERT : flatOn ? ALPHA_BASE : (LEVEL_ALPHA[level] ?? 1),
      );
    }
  }
  stamp(`${Math.round(yaws[cell] ?? 0)}°`, originX + 4, CELL_H + 3);
}

/* --------------------------------------------------------------- PNG encoder */

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(out.length - 4, crc32(Buffer.from(out.subarray(4, out.length - 4))));
  return out;
}

const raw = new Uint8Array(H * (W * 3 + 1));
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0; // filter: none
  raw.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1);
}
const ihdr = new Uint8Array(13);
const iv = new DataView(ihdr.buffer);
iv.setUint32(0, W);
iv.setUint32(4, H);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour
writeFileSync(
  outPath,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(chunk("IHDR", ihdr)),
    Buffer.from(chunk("IDAT", deflateSync(Buffer.from(raw), { level: 9 }))),
    Buffer.from(chunk("IEND", new Uint8Array(0))),
  ]),
);

const levelName = (level: number): string =>
  level < 0
    ? "flagged"
    : level === 0
      ? "ghost"
      : level < 1 + DEPTH_STEPS
        ? `body ${level - 1}`
        : `contour ${level - 1 - DEPTH_STEPS}`;

console.log(`\n  ${outPath}  —  ${W}x${H}, yaws ${yaws.join("/")}°`);
for (let cell = 0; cell < yaws.length; cell += 1) {
  const tally = tallies[cell] ?? new Map<number, number>();
  const total = [...tally.values()].reduce((a, b) => a + b, 0);
  const tier = (lo: number, hi: number) =>
    [...tally.entries()]
      .filter(([l]) => l >= lo && l <= hi)
      .reduce((a, [, c]) => a + c, 0);
  console.log(
    `\n  yaw ${String(Math.round(yaws[cell] ?? 0)).padStart(3)}°  ${total} segments  ` +
      `— ghost ${tier(0, 0)} · body ${tier(1, DEPTH_STEPS)} · contour ${tier(1 + DEPTH_STEPS, 2 * DEPTH_STEPS)}`,
  );
  for (const level of [...tally.keys()].sort((a, b) => a - b)) {
    const count = tally.get(level) ?? 0;
    console.log(
      `    ${levelName(level).padEnd(10)} α ${(LEVEL_ALPHA[level] ?? ALPHA_ALERT).toFixed(3)}  ` +
        `${String(count).padStart(5)}  ${"█".repeat(Math.round((count / total) * 50))}`,
    );
  }
}
console.log();
