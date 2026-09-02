import { readToken, TOKEN_FALLBACK } from "@/lib/tokens/fallback";
import { type StripScales } from "@/components/console";
import { type StripTone } from "./strip-tone";

/** The guide is `--line` at 1 CSS px: the console's hairline, so the ceiling reads as rule work. */
export const GUIDE_TOKEN = "--line";

export interface StripPalette extends Record<StripTone, string> {
  guide: string;
  /** `--muted`: findable in eighteen boxes, and a flat hex in both spaces (canvas cannot parse `color-mix()`). */
  cursor: string;
  /** `--ink-soft`: axis figures (`--muted` fails AA below 24px). */
  axis: string;
  /** `--bg`: the plate under an axis figure so a trace cannot swallow it. */
  plate: string;
  /** Resolved font shorthand for canvas text, e.g. `11px "Geist Sans", …`. */
  axisFont: string;
}

/** Before the element is sampled: the operator palette, where the strips live. */
export const FALLBACK_PALETTE: StripPalette = {
  ink: TOKEN_FALLBACK.operator["--ink"],
  warn: TOKEN_FALLBACK.operator["--warn"],
  alert: TOKEN_FALLBACK.operator["--alert"],
  guide: TOKEN_FALLBACK.operator[GUIDE_TOKEN],
  cursor: TOKEN_FALLBACK.operator["--muted"],
  axis: TOKEN_FALLBACK.operator["--ink-soft"],
  plate: TOKEN_FALLBACK.operator["--bg"],
  axisFont: "11px sans-serif",
};

// Canvas cannot read CSS variables, so the token layer is sampled off the
// element itself — mount and resize only, never in a frame callback.
export function readPalette(el: Element): StripPalette {
  const style = getComputedStyle(el);
  const size = style.getPropertyValue("--fs-label").trim() || "0.6875rem";
  const px = size.endsWith("rem")
    ? Number.parseFloat(size) * 16
    : Number.parseFloat(size);
  const family = style.fontFamily || "sans-serif";
  return {
    ink: readToken(style, "--ink", "operator"),
    warn: readToken(style, "--warn", "operator"),
    alert: readToken(style, "--alert", "operator"),
    guide: readToken(style, GUIDE_TOKEN, "operator"),
    cursor: readToken(style, "--muted", "operator"),
    axis: readToken(style, "--ink-soft", "operator"),
    plate: readToken(style, "--bg", "operator"),
    axisFont: `${Number.isFinite(px) ? Math.round(px) : 11}px ${family}`,
  };
}

export interface AxisMark {
  text: string;
  x: number;
  y: number;
  align: CanvasTextAlign;
  /** The `--bg` plate behind the figure; zero width means no plate. */
  plateX: number;
  plateW: number;
}

/** One strip's mutable state, owned by the host and read by every draw helper. */
export interface StripRuntime {
  ctx: CanvasRenderingContext2D | null;
  scales: StripScales | null;
  width: number;
  height: number;
  /** Plot height: the whole box at rest, minus the time axis when expanded. */
  plotHeight: number;
  dpr: number;
  /** Last version drawn; -1 forces the next frame to redraw (resize, remount). */
  drawnVersion: number;
  /** Last cursor offset drawn, so a pointer move dirties the canvas exactly once. */
  drawnCursor: number | null;
  expanded: boolean;
  /** The opposite joint's trace is overlaid. Expanded strips only. */
  compare: boolean;
  palette: StripPalette;
  /** Axis figures, laid out at resize; empty while resting. */
  axes: AxisMark[];
  /** The imperative readout and its Δ slot: written from the frame callback, never rendered. */
  readout: HTMLElement | null;
  delta: HTMLElement | null;
  /** Last strings written, so an unchanged reading costs no DOM write at all. */
  wroteValue: string;
  wroteTone: string;
  wroteDelta: string;
  draw: () => void;
}

/** Snapped to whole device rows: an unsnapped 1px line antialiases into a smudge. */
export function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}
