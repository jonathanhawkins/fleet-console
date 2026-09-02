import { TELEMETRY_RING_CAPACITY } from "@/lib/stores";
import { type Envelope, type MetricSpec } from "@/components/console";
import { timeAxis, valueAxis } from "../telemetry-bands";
import { type AxisMark, type StripRuntime } from "./strip-runtime";

/** Room under the plot for the time axis, expanded only. */
export const TIME_AXIS_HEIGHT = 18;

/** Height of the plate behind an axis figure, and how opaque it is. */
const PLATE_H = 14;
const PLATE_ALPHA = 0.86;

/** The resting state's axis list: one shared empty array, never reallocated. */
export const EMPTY_AXES: AxisMark[] = [];

/** Plot box: the whole canvas at rest, minus the time axis when expanded. */
export function plotHeightFor(height: number, expanded: boolean): number {
  return expanded ? Math.max(1, height - TIME_AXIS_HEIGHT) : height;
}

export function strokeGuide(
  ctx: CanvasRenderingContext2D,
  state: StripRuntime,
  y: number,
): void {
  ctx.strokeStyle = state.palette.guide;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(state.width, y);
  ctx.stroke();
}

/**
 * The figures, expanded only, laid out once when the box or the envelope
 * changes — never in a frame: `valueAxis`/`timeAxis` build arrays and
 * `measureText` allocates. Drawn inside the plot rather than in a gutter so the
 * x mapping is identical expanded and collapsed and the shared cursor lands on
 * the same sample in all eighteen strips; each figure sits on a `--bg` plate.
 */
export function planAxes(
  ctx: CanvasRenderingContext2D,
  state: StripRuntime,
  env: Envelope,
  spec: MetricSpec,
): AxisMark[] {
  const { scales, palette, width, plotHeight } = state;
  if (!scales || width <= 0) return [];
  ctx.font = palette.axisFont;
  const marks: AxisMark[] = [];

  for (const label of valueAxis(env, spec)) {
    const y = Math.min(plotHeight - 7, Math.max(7, scales.y(label.value)));
    const w = ctx.measureText(label.text).width;
    marks.push({ text: label.text, x: 5, y, align: "left", plateX: 2, plateW: w + 6 });
    if (!label.reference) continue;
    // The one caption on the canvas: it names the line at the end of that line.
    const caption = "healthy";
    const cw = ctx.measureText(caption).width;
    marks.push({
      text: caption,
      x: width - 5,
      y,
      align: "right",
      plateX: width - cw - 8,
      plateW: cw + 6,
    });
  }

  const y = plotHeight + TIME_AXIS_HEIGHT / 2;
  for (const label of timeAxis(TELEMETRY_RING_CAPACITY)) {
    marks.push({
      text: label.text,
      x:
        label.anchor === "start"
          ? 1
          : label.anchor === "end"
            ? width - 1
            : scales.x(label.offset),
      y,
      align:
        label.anchor === "start" ? "left" : label.anchor === "end" ? "right" : "center",
      plateX: 0,
      plateW: 0,
    });
  }
  return marks;
}

export function drawAxes(ctx: CanvasRenderingContext2D, state: StripRuntime): void {
  ctx.font = state.palette.axisFont;
  ctx.textBaseline = "middle";
  for (const mark of state.axes) {
    if (mark.plateW > 0) {
      ctx.globalAlpha = PLATE_ALPHA;
      ctx.fillStyle = state.palette.plate;
      ctx.fillRect(mark.plateX, mark.y - PLATE_H / 2, mark.plateW, PLATE_H);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = state.palette.axis;
    ctx.textAlign = mark.align;
    ctx.fillText(mark.text, mark.x, mark.y);
  }
  ctx.textAlign = "left";
}
