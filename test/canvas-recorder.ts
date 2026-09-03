import { vi } from "vitest";

/**
 * A recording `CanvasRenderingContext2D` for tests that assert on what a
 * canvas-driven component drew rather than on any DOM it left behind.
 *
 * Every draw call is captured — strokes, fills, line widths, dash arrays, and
 * the points a path moved or drew through — so a test can read back the
 * picture a frame painted without a real canvas under jsdom.
 */

export interface FakeRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  alpha: number;
}

export interface FakeCtx {
  calls: {
    clearRect: number;
    beginPath: number;
    moveTo: number;
    lineTo: number;
    arc: number;
  };
  strokes: string[];
  widths: number[];
  points: Array<[number, number]>;
  rects: FakeRect[];
  texts: Array<{ text: string; x: number; y: number }>;
  /** Every `setLineDash` argument, by reference — a zero-alloc claim needs it. */
  dashes: number[][];
  setLineDash: (segments: number[]) => void;
  setTransform: ReturnType<typeof vi.fn>;
  reset: () => void;
  clearRect: () => void;
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  arc: (x: number, y: number, r: number) => void;
  fill: () => void;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  fillText: (text: string, x: number, y: number) => void;
  measureText: (text: string) => { width: number };
  stroke: () => void;
  strokeStyle: string;
  fillStyle: string;
  globalAlpha: number;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  font: string;
  textAlign: string;
  textBaseline: string;
}

export function makeCtx(): FakeCtx {
  const calls = { clearRect: 0, beginPath: 0, moveTo: 0, lineTo: 0, arc: 0 };
  const strokes: string[] = [];
  const widths: number[] = [];
  const points: Array<[number, number]> = [];
  const rects: FakeRect[] = [];
  const texts: Array<{ text: string; x: number; y: number }> = [];
  const dashes: number[][] = [];
  let fillStyle = "";
  let globalAlpha = 1;
  // One literal, no spreads: object spread copies accessors *by value*, which
  // would silently turn `strokeStyle` back into a plain field and record
  // nothing.
  return {
    calls,
    strokes,
    widths,
    points,
    rects,
    texts,
    dashes,
    // Kept by reference, not copied: "a frame allocates no dash array" is only
    // checkable if the recorder can be asked whether it saw the same object.
    setLineDash: (segments: number[]) => {
      dashes.push(segments);
    },
    setTransform: vi.fn(),
    reset() {
      calls.clearRect = 0;
      calls.beginPath = 0;
      calls.moveTo = 0;
      calls.lineTo = 0;
      calls.arc = 0;
      strokes.length = 0;
      widths.length = 0;
      points.length = 0;
      rects.length = 0;
      texts.length = 0;
      dashes.length = 0;
    },
    clearRect: () => (calls.clearRect += 1),
    beginPath: () => (calls.beginPath += 1),
    moveTo: (x: number, y: number) => {
      calls.moveTo += 1;
      points.push([x, y]);
    },
    lineTo: (x: number, y: number) => {
      calls.lineTo += 1;
      points.push([x, y]);
    },
    arc: (x: number, y: number) => {
      calls.arc += 1;
      points.push([x, y]);
    },
    fill: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h, fill: fillStyle, alpha: globalAlpha });
    },
    fillText: (text: string, x: number, y: number) => {
      texts.push({ text, x, y });
    },
    measureText: (text: string) => ({ width: text.length * 6 }),
    stroke: () => {},
    set strokeStyle(v: string) {
      strokes.push(v);
    },
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: string) {
      fillStyle = v;
    },
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(v: number) {
      globalAlpha = v;
    },
    set lineWidth(v: number) {
      widths.push(v);
    },
    set lineJoin(_v: string) {},
    set lineCap(_v: string) {},
    set font(_v: string) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
  };
}
