import { type StripRuntime, snap } from "./strip-runtime";
import { type StripTone } from "./strip-tone";

// The shared cursor, from the strip's side. The grid owns the pointer
// (joint-grid.tsx) and writes one offset into telemetry-hover.ts; the strip
// reads it in the frame callback it already runs. A pointer moves faster than
// telemetry arrives, so nothing in here touches React.

/** The rule across the plot and the dot on the sample the numeral is printing. */
export function drawCursor(
  ctx: CanvasRenderingContext2D,
  state: StripRuntime,
  x: number,
  y: number,
  tone: StripTone,
): void {
  const { palette } = state;
  const cx = snap(x, state.dpr);
  ctx.strokeStyle = palette.cursor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, state.plotHeight);
  ctx.stroke();

  ctx.fillStyle = palette.plate;
  ctx.beginPath();
  ctx.arc(cx, y, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = palette[tone];
  ctx.beginPath();
  ctx.arc(cx, y, 1.75, 0, Math.PI * 2);
  ctx.fill();
}

// Three guards, all load-bearing at pointer rate: the string, the tone
// attribute and the Δ slot are each written only when they changed.
export function writeReadout(
  state: StripRuntime,
  value: number | undefined,
  tone: StripTone,
  precision: number,
  delta?: number,
): void {
  const el = state.readout;
  if (!el) return;
  const text = value === undefined ? "—" : value.toFixed(precision);
  if (text !== state.wroteValue) {
    const slot = el.firstElementChild;
    if (slot) slot.textContent = text;
    state.wroteValue = text;
  }
  if (tone !== state.wroteTone) {
    el.dataset.tone = tone;
    state.wroteTone = tone;
  }
  // Empty when there is nothing to compare against: the slot is `empty:hidden`.
  const diff = delta === undefined ? "" : formatDelta(delta, precision);
  if (diff !== state.wroteDelta) {
    if (state.delta) state.delta.textContent = diff;
    state.wroteDelta = diff;
  }
}

/** "Δ +1.8" — always signed, typographic minus; a delta with no sign is a second reading. */
function formatDelta(delta: number, precision: number): string {
  // −0.0 is a real output of toFixed on a tiny negative and reads as a fault.
  const rounded = Math.abs(delta) < 0.5 / 10 ** precision ? 0 : delta;
  const sign = rounded < 0 ? "−" : "+";
  return `Δ ${sign}${Math.abs(rounded).toFixed(precision)}`;
}
