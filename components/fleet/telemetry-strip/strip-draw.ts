import {
  getUnitBuffers,
  getUnitTelemetryVersion,
  TELEMETRY_RING_CAPACITY,
  useFleetStore,
  type TelemetryMetric,
} from "@/lib/stores";
import { type Envelope, type MetricSpec } from "@/components/console";
import { breachRuns, breachRunScratch } from "../telemetry-bands";
import { cursorOffsetFor } from "../telemetry-hover";
import { drawAxes, strokeGuide } from "./strip-axes";
import { drawCursor, writeReadout } from "./strip-cursor";
import { type StripRuntime, snap } from "./strip-runtime";
import {
  BREACH_SAMPLES,
  breachedRecently,
  stripTone,
  type StripTone,
} from "./strip-tone";

/** What one strip is an instrument of. Constant for the strip's life (keyed by joint+metric). */
export interface StripSubject {
  unitId: string;
  joint: string;
  metric: TelemetryMetric;
  env: Envelope;
  spec: MetricSpec;
  /** The other leg's joint, or null for a joint with no opposite number. */
  mirror: string | null;
}

/**
 * The envelope fill: `--line` at 40 % lands ~4 % off the background — a floor
 * and a ceiling the eye reads, far too weak to compete with a 1px trace when
 * eighteen of these are on screen. The breach wash is an eighth of the trace's
 * pigment: found by peripheral vision, confirmed by the trace over it.
 */
const HEALTHY_FILL_ALPHA = 0.4;
const BREACH_FILL_ALPHA = 0.13;
/** A single-sample excursion is 0.5 px wide at rest; this keeps it findable. */
const MIN_BREACH_PX = 2;

/**
 * The comparison trace invents no colour — a second hue would be a second
 * severity scale on a panel where amber and clay already mean something — so
 * it is the trace's own ink at a third strength, dashed. Module constants:
 * `setLineDash` takes an array, and a frame allocates none.
 */
const COMPARE_ALPHA = 0.38;
const COMPARE_DASH: number[] = [3, 3];
const NO_DASH: number[] = [];

/**
 * Two scratch arrays for every strip on the page. Draws are synchronous and
 * non-reentrant inside a frame, so eighteen strips share 9.6 KB instead of
 * holding private buffers; the mirror needs its own because the primary is
 * still being read when the trace is stroked last.
 */
const scratch = new Float64Array(TELEMETRY_RING_CAPACITY);
const mirrorScratch = new Float64Array(TELEMETRY_RING_CAPACITY);

function strokeSeries(
  ctx: CanvasRenderingContext2D,
  state: StripRuntime,
  values: Float64Array,
  n: number,
  floor: number,
): void {
  const { scales } = state;
  if (!scales) return;
  ctx.beginPath();
  for (let i = 0; i < n; i += 1) {
    const x = scales.x(i - (n - 1));
    const y = scales.y(values[i] ?? floor);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/**
 * One frame. Returns without touching the canvas unless the unit's version or
 * the shared cursor moved — at 10 Hz batches and 60 Hz frames, five frames out
 * of six. Layers in strict order of who may be loudest: the envelope as
 * ground, the breach wash, the guide, the opposite joint (dashed, under), the
 * trace, then the axis figures and the cursor on top.
 */
export function drawStrip(state: StripRuntime, subject: StripSubject): void {
  const { ctx, scales, palette } = state;
  if (!ctx || !scales || state.width <= 0) return;
  const { unitId, joint, metric, env, spec, mirror } = subject;

  const version = getUnitTelemetryVersion(unitId);
  const cursor = cursorOffsetFor(unitId);
  if (version === state.drawnVersion && cursor === state.drawnCursor) return;
  state.drawnVersion = version;
  state.drawnCursor = cursor;

  const series = getUnitBuffers(unitId)?.joints.get(joint)?.[metric];
  const plotH = state.plotHeight;
  ctx.clearRect(0, 0, state.width, state.height);

  // The healthy corridor is a fact about the hardware: drawn before any data.
  const guideY = snap(scales.y(env.healthy), state.dpr);
  ctx.globalAlpha = HEALTHY_FILL_ALPHA;
  ctx.fillStyle = palette.guide;
  ctx.fillRect(0, guideY, state.width, plotH - guideY);
  ctx.globalAlpha = 1;

  const status = useFleetStore.getState().units[unitId]?.status;
  const tone = series ? stripTone(breachedRecently(series, env.healthy), status) : "ink";
  const breachTone: StripTone = status === "red" ? "alert" : "warn";

  if (!series || series.length === 0) {
    strokeGuide(ctx, state, guideY);
    if (state.expanded) drawAxes(ctx, state);
    writeReadout(state, undefined, "ink", spec.precision);
    return;
  }

  const n = series.copyInto(scratch);

  // Under the trace, over the ground: the wash says WHEN, the trace says by how much.
  const runs = breachRunScratch();
  const runCount = breachRuns(scratch, n, env.healthy, runs, BREACH_SAMPLES);
  if (runCount > 0) {
    ctx.globalAlpha = BREACH_FILL_ALPHA;
    ctx.fillStyle = palette[breachTone];
    for (let r = 0; r < runCount; r += 1) {
      const from = scales.x((runs[r * 2] ?? 0) - (n - 1));
      const to = scales.x((runs[r * 2 + 1] ?? 0) - (n - 1));
      ctx.fillRect(from, 0, Math.max(MIN_BREACH_PX, to - from), plotH);
    }
    ctx.globalAlpha = 1;
  }

  strokeGuide(ctx, state, guideY);

  // The pair is the same hardware and joint-spec scales it identically, which
  // is the only reason overlaying the two on one y domain says anything.
  let mirrorN = 0;
  if (state.compare && mirror) {
    const other = getUnitBuffers(unitId)?.joints.get(mirror)?.[metric];
    mirrorN = other ? other.copyInto(mirrorScratch) : 0;
  }
  if (mirrorN > 0) {
    ctx.globalAlpha = COMPARE_ALPHA;
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 1;
    ctx.setLineDash(COMPARE_DASH);
    strokeSeries(ctx, state, mirrorScratch, mirrorN, env.floor);
    ctx.setLineDash(NO_DASH);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = palette[tone];
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  strokeSeries(ctx, state, scratch, n, env.floor);

  // Over the trace: a plate can only defend a figure against what is drawn before it.
  if (state.expanded) drawAxes(ctx, state);

  if (cursor === null) {
    writeReadout(state, undefined, "ink", spec.precision);
    return;
  }
  const index = n - 1 + cursor;
  const value = index >= 0 && index < n ? scratch[index] : undefined;
  if (value === undefined) {
    writeReadout(state, undefined, "ink", spec.precision);
    return;
  }
  // Both rings fill from the same batch, so the same offset is the same instant.
  const mirrorIndex = mirrorN - 1 + cursor;
  const against =
    mirrorIndex >= 0 && mirrorIndex < mirrorN ? mirrorScratch[mirrorIndex] : undefined;
  const pointTone: StripTone = value > env.healthy ? breachTone : "ink";
  drawCursor(ctx, state, scales.x(cursor), scales.y(value), pointTone);
  writeReadout(
    state,
    value,
    pointTone,
    spec.precision,
    against === undefined ? undefined : value - against,
  );
}
