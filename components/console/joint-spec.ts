import { scaleLinear, type ScaleLinear } from "d3-scale";

/**
 * What the console knows about a leg before any telemetry arrives: the six
 * joints, what to call them in operator space, and the operating envelope each
 * measure is expected to stay inside.
 *
 * The envelope is the console's own spec sheet, not something read off the
 * wire. That is the point: a strip that autoscaled to its data would draw the
 * same confident wiggle whether a knee was resting or cooking, because the
 * shape would be normalised and the *level* — the only thing that matters
 * here — would be thrown away. Fixed domains mean a flat trace low in the box
 * genuinely means "quiet", and the guide line is a fact about the hardware
 * rather than a fact about the last sixty seconds.
 *
 * Deliberately not imported from `sim/`: the simulator is a stand-in for a
 * fleet, and a console that could only be scaled by reading its own simulator
 * would be a console that could not be pointed at a real robot.
 */

/** Wire order: pairs, left before right. */
export const JOINTS = [
  "hip_L",
  "hip_R",
  "knee_L",
  "knee_R",
  "ankle_L",
  "ankle_R",
] as const;
export type Joint = (typeof JOINTS)[number];

/**
 * Reading order for the grid: one leg, then the other.
 *
 * At three columns this makes each row a leg and each *column* a pair — hips
 * above hips, knees above knees — so "is the left knee doing something the
 * right one isn't" is a glance up or down a column rather than a diagonal hunt
 * across a row break, which is where wire order puts the knees. Asymmetry
 * between a pair is the first thing anyone looks for in a walking machine.
 */
export const JOINT_GRID_ORDER = [
  "hip_L",
  "knee_L",
  "ankle_L",
  "hip_R",
  "knee_R",
  "ankle_R",
] as const satisfies readonly Joint[];

/**
 * Operator space says "Left knee", never "knee_L" — the wire's vocabulary is
 * for the machine-space boards in Phase 3, where terse identifiers are the
 * voice. Unknown joints fall back to their wire name rather than to nothing.
 */
const JOINT_LABELS: Record<Joint, string> = {
  hip_L: "Left hip",
  hip_R: "Right hip",
  knee_L: "Left knee",
  knee_R: "Right knee",
  ankle_L: "Left ankle",
  ankle_R: "Right ankle",
};

export function jointLabel(joint: string): string {
  return JOINT_LABELS[joint as Joint] ?? joint;
}

/** Three measures per joint, in the order they read: heat, effort, draw. */
export const METRICS = ["tempC", "torqueNm", "currentA"] as const;
/**
 * The measure vocabulary, owned here rather than imported from the stores: the
 * spec sheet is what the console knows *before* any telemetry arrives, so it
 * cannot depend on the layer that receives it. The telemetry channel's own
 * `TelemetryMetric` is the same three strings, and the two unions are
 * mutually assignable by structure.
 */
export type Metric = (typeof METRICS)[number];

export interface MetricSpec {
  /** Sentence case in source; SectionLabel uppercases it. */
  label: string;
  /** Rendered directly after the figure, one space out. */
  unit: string;
  /** Decimal places for the live numeral. */
  precision: number;
}

export const METRIC_SPEC: Record<Metric, MetricSpec> = {
  tempC: { label: "Temp", unit: "°C", precision: 1 },
  torqueNm: { label: "Torque", unit: "N·m", precision: 1 },
  currentA: { label: "Current", unit: "A", precision: 2 },
};

/**
 * Hips carry the most load, ankles the least, so their envelopes differ by
 * joint class rather than per joint — the left and right of a pair are the
 * same hardware and must be scaled identically or the panel invites false
 * comparisons.
 */
type JointClass = "hip" | "knee" | "ankle";

function jointClass(joint: string): JointClass {
  if (joint.startsWith("hip")) return "hip";
  if (joint.startsWith("ankle")) return "ankle";
  return "knee";
}

export interface Envelope {
  /** Bottom of the drawn box. */
  floor: number;
  /** The value a healthy joint stays under — where the guide line sits. */
  healthy: number;
  /** Top of the drawn box; headroom above `healthy` so a fault has somewhere to go. */
  top: number;
}

/**
 * Torque and current sit their guide at ~75 % of the box in every class, so
 * the eighteen strips share one datum line across the panel. Temperature is
 * the exception on purpose: a knee that fails runs *far* over its limit, and
 * clipping the one trace that tells the story to keep a tidy line height would
 * be an ops console lying about a number. It gets the headroom instead.
 */
const ENVELOPES: Record<JointClass, Record<Metric, Envelope>> = {
  hip: {
    tempC: { floor: 26, healthy: 44, top: 60 },
    torqueNm: { floor: 0, healthy: 23, top: 31 },
    currentA: { floor: 0, healthy: 3, top: 4 },
  },
  knee: {
    tempC: { floor: 26, healthy: 44, top: 60 },
    torqueNm: { floor: 0, healthy: 18, top: 24 },
    currentA: { floor: 0, healthy: 2.4, top: 3.2 },
  },
  ankle: {
    tempC: { floor: 26, healthy: 44, top: 60 },
    torqueNm: { floor: 0, healthy: 11.5, top: 15.5 },
    currentA: { floor: 0, healthy: 1.7, top: 2.3 },
  },
};

export function envelope(joint: string, metric: Metric): Envelope {
  return ENVELOPES[jointClass(joint)][metric];
}

/**
 * The two scales a strip draws with.
 *
 * x is indexed from the *newest* sample, not the oldest: the domain runs
 * −(capacity−1)…0 and the newest sample lands on the right edge. A ring that
 * has only filled a few seconds therefore draws a short trace anchored where
 * the eye already is, and grows leftward into the window — rather than a stub
 * squeezed against the left edge that looks like a broken chart, or a
 * full-width trace that silently restates four seconds of history as sixty.
 *
 * d3-scale for the scales and nothing else (PRD §3): no axes, no ticks, no
 * selections. Rebuilt on resize only.
 */
export interface StripScales {
  x: ScaleLinear<number, number>;
  y: ScaleLinear<number, number>;
}

export function stripScales(
  capacity: number,
  width: number,
  height: number,
  env: Envelope,
  /** Half the trace's stroke, so a value pinned at floor or top is not clipped. */
  padY = 1,
): StripScales {
  return {
    x: scaleLinear()
      .domain([-(capacity - 1), 0])
      .range([0, width]),
    y: scaleLinear()
      .domain([env.floor, env.top])
      .range([height - padY, padY]),
  };
}
