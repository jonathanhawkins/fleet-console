import { TOKEN_FALLBACK, readToken } from "@/lib/tokens/fallback";
import { TONE_BY_INDEX, type ChannelTone } from "@/lib/diagnostics/waveform-math";

/**
 * One channel cell, painted: the factory reference, then the measurement on
 * top of it.
 *
 * The order is the argument. The reference is drawn whole and first, so a live
 * trace that tracks it *disappears into it* — five cells in which there is
 * visibly one line are five joints that are fine, said without a word or a
 * colour. The sixth cell is the one where two lines are visible, and that is
 * the finding before any number is read.
 *
 * Everything here is operator-space: hairline strokes, no glow, no cursor rule,
 * and a palette sampled from the live token layer so the cell is warm greige
 * and clay rather than phosphor. The tone *indices* are the machine's, computed
 * once per channel by `writeSampleTones`, which is why the two surfaces can
 * never disagree about where a trace left tolerance.
 */

export interface CellPalette {
  nominal: string;
  warn: string;
  alert: string;
  ref: string;
  base: string;
}

const FALLBACK: CellPalette = {
  nominal: TOKEN_FALLBACK.operator["--ink"],
  warn: TOKEN_FALLBACK.operator["--warn"],
  alert: TOKEN_FALLBACK.operator["--alert"],
  ref: TOKEN_FALLBACK.operator["--muted"],
  base: TOKEN_FALLBACK.operator["--line"],
};

export function readCellPalette(el: Element): CellPalette {
  const style = getComputedStyle(el);
  return {
    nominal: readToken(style, "--ink", "operator"),
    warn: readToken(style, "--warn", "operator"),
    alert: readToken(style, "--alert", "operator"),
    // A mid-grey, not a hairline: the reference has to be legible under the
    // measurement without competing with it for the eye.
    ref: readToken(style, "--muted", "operator"),
    base: readToken(style, "--line", "operator"),
  };
}

export const FALLBACK_CELL_PALETTE = FALLBACK;

const TONE_KEY: Record<ChannelTone, keyof CellPalette> = {
  nominal: "nominal",
  warn: "warn",
  alert: "alert",
};

/**
 * Vertical inset, in CSS pixels, so a peak at full amplitude does not sit on
 * the cell's own edge. The reference is scaled to the remaining room and the
 * measurement shares that scale — which is the whole point of a shared
 * baseline: a knee running at 1.6× is *taller than its neighbours* because
 * every cell in the column is drawn at one scale, not normalised to itself.
 */
const PAD_Y = 4;

export interface DrawCellOptions {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  palette: CellPalette;
  wave: readonly number[];
  ref: readonly number[];
  /** Per-sample tone indices from `writeSampleTones`; null draws flat ink. */
  tones: Uint8Array | null;
  /** 0…1 — how much of the trace has been swept in. 1 is settled. */
  progress: number;
  /** The scale every cell in the column shares. */
  amplitude: number;
}

export function drawCell({
  ctx,
  width,
  height,
  dpr,
  palette,
  wave,
  ref,
  tones,
  progress,
  amplitude,
}: DrawCellOptions): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0) return;

  const mid = height / 2;
  const room = Math.max(1, mid - PAD_Y);
  const scale = amplitude > 0 ? room / amplitude : room;
  const y = (v: number) => mid - v * scale;
  const x = (i: number, n: number) => (n <= 1 ? 0 : (i / (n - 1)) * width);

  // The datum. Not a grid — one line, because the comparison is against the
  // reference and a ruled cell would invite reading values off it.
  ctx.strokeStyle = palette.base;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(mid) + 0.5);
  ctx.lineTo(width, Math.round(mid) + 0.5);
  ctx.stroke();

  if (ref.length > 1) {
    ctx.strokeStyle = palette.ref;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < ref.length; i += 1) {
      const px = x(i, ref.length);
      const py = y(ref[i] ?? 0);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  if (wave.length <= 1) return;

  // The measurement, in runs of one tone. A gain fault ramps, so its trace
  // leaves nominal, crosses warn and arrives alert along its own length —
  // "this got worse", drawn rather than concluded.
  const shown = Math.max(0, Math.min(wave.length, Math.ceil(wave.length * progress)));
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  let start = 0;
  while (start < shown - 1) {
    const toneIndex = tones?.[start] ?? 0;
    let end = start + 1;
    while (end < shown && (tones?.[end] ?? 0) === toneIndex) end += 1;

    ctx.strokeStyle = palette[TONE_KEY[TONE_BY_INDEX[toneIndex] ?? "nominal"]];
    ctx.beginPath();
    for (let i = start; i <= Math.min(end, shown - 1); i += 1) {
      const px = x(i, wave.length);
      const py = y(wave[i] ?? 0);
      if (i === start) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    // Overlap by one sample so consecutive runs meet without a gap.
    start = end - 1 > start ? end - 1 : end;
  }
}

/**
 * The scale the whole column shares.
 *
 * Taken from the references rather than from the measurements, so a failing
 * channel does not rescale the cells around it: the reference envelope is what
 * "normal amplitude" means, and a trace that exceeds it should visibly exceed
 * it. Padded slightly so a 1.8× fault still has room to be drawn rather than
 * clipped into a flat-topped shape that understates it.
 */
export function columnAmplitude(
  channels: ReadonlyArray<{ wave: readonly number[]; ref: readonly number[] }>,
): number {
  let peak = 0;
  for (const c of channels) {
    for (const v of c.ref) peak = Math.max(peak, Math.abs(v));
    for (const v of c.wave) peak = Math.max(peak, Math.abs(v));
  }
  return peak > 0 ? peak : 1;
}
