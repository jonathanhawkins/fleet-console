import { type UnitStatus } from "@/lib/schema";
import { type StatusChipStatus } from "./status-chip";

/**
 * What the console knows about the chassis before any pixel of it is
 * drawn: eight named components, what an operator calls each one, and which of
 * them a given diagnosis implicates.
 *
 * All of it is pure. The 3D viewer that consumes this module lives behind a
 * `next/dynamic` boundary and drags three.js in with it (PRD §7); the rules
 * about *which part lights up and why* have nothing to do with WebGL and must
 * stay testable, reusable by the 2D fallback elevation, and out of the lazy
 * chunk. So: names, mappings and one small state machine here — meshes,
 * materials and cameras there.
 *
 * The eight ids are the node names inside public/models/chassis-silhouette.glb
 * (see scripts/verify-chassis-silhouette.mjs, which asserts they exist). `_L` is
 * the robot's anatomical left, which on a front view is the viewer's right —
 * the same pedantry the machine-space elevation insists on, and for the same
 * reason: a console that silently mirrors the failing side is worse than one
 * that shows nothing.
 */

export const COMPONENT_IDS = [
  "head",
  "torso",
  "arm_L",
  "arm_R",
  "leg_L",
  "leg_R",
  "knee_actuator_L",
  "knee_actuator_R",
] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

/**
 * Cycle order for the keyboard, and reading order for anything that lists them.
 *
 * Top-down, and each knee actuator sits immediately after the leg it belongs
 * to rather than in a pair with its opposite number. Same instinct as
 * JOINT_GRID_ORDER: an operator stepping through parts is walking one limb
 * assembly at a time, not comparing symmetries.
 */
export const COMPONENT_ORDER = [
  "head",
  "torso",
  "arm_L",
  "arm_R",
  "leg_L",
  "knee_actuator_L",
  "leg_R",
  "knee_actuator_R",
] as const satisfies readonly ComponentId[];

/** Operator space: sentence case, plain words, never the node name. */
export const COMPONENT_LABELS: Record<ComponentId, string> = {
  head: "Head",
  torso: "Torso",
  arm_L: "Left arm",
  arm_R: "Right arm",
  leg_L: "Left leg",
  leg_R: "Right leg",
  knee_actuator_L: "Left knee actuator",
  knee_actuator_R: "Right knee actuator",
};

export function componentLabel(id: ComponentId): string {
  return COMPONENT_LABELS[id];
}

/**
 * Which component a joint's diagnosis points at.
 *
 * The telemetry vocabulary is six joints; the chassis vocabulary is eight
 * parts. A knee fault resolves to the actuator that drives it — that is the
 * serviceable item, and it is what the verdict names. Hips and ankles have no
 * modelled actuator of their own, so they resolve to the limb that carries
 * them: less precise, but true, which is the only bar that matters.
 */
export const COMPONENT_FOR_JOINT: Record<string, ComponentId> = {
  knee_L: "knee_actuator_L",
  knee_R: "knee_actuator_R",
  hip_L: "leg_L",
  hip_R: "leg_R",
  ankle_L: "leg_L",
  ankle_R: "leg_R",
};

export function componentForJoint(joint: string | null | undefined): ComponentId | null {
  if (!joint) return null;
  return COMPONENT_FOR_JOINT[joint] ?? null;
}

/**
 * The component an alert's own sentence names, or null.
 *
 * Before a diagnostic runs, the only thing the console knows about an incident
 * is the alert — "N-07: left knee actuator trending hot". That sentence already
 * names a part, in the same words this viewer uses for it, so the viewer can
 * point at it without inventing a suspect or re-deriving one from telemetry.
 * The match is against the label vocabulary rather than against prose patterns:
 * the question being asked is "does this alert name something I can point at",
 * and an alert that names nothing gets nothing highlighted.
 *
 * Longest label first, so a sentence containing "left knee actuator" is never
 * claimed by a shorter label that happens to be a substring of it.
 */
const LABELS_BY_SPECIFICITY = COMPONENT_IDS.map((id) => ({
  id,
  needle: COMPONENT_LABELS[id].toLowerCase(),
})).sort((a, b) => b.needle.length - a.needle.length);

export function componentNamedIn(text: string | null | undefined): ComponentId | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  return LABELS_BY_SPECIFICITY.find((c) => haystack.includes(c.needle))?.id ?? null;
}

/**
 * Whether a component is lit, and how urgently.
 *
 * `pulse` is an open question — something is wrong here and nobody has looked
 * yet. `steady` is a settled answer: the scan reached a verdict, the operator
 * came back up with it, and the part stays marked until the sim is reset. The
 * difference is deliberately the same one the incident banner draws between
 * "needs attention" and "service recommended", and it carries the same colour:
 * a diagnosed fault is amber (someone is going out to it), an undiagnosed one
 * wears the unit's own severity.
 */
export type HighlightMode = "pulse" | "steady";

export interface ComponentHighlight {
  id: ComponentId;
  mode: HighlightMode;
  tone: "warn" | "alert";
}

export interface HighlightSources {
  /** The unit's live status from the fleet store. */
  status: UnitStatus | undefined;
  /** Newest alert message for this unit — the incident banner's headline. */
  alertMessage: string | null;
  /** Joint the running scan has flagged, if this unit owns the session. */
  flaggedJoint: string | null;
  /** Joint the diagnosis names: session verdict, or an archived record. */
  verdictJoint: string | null;
}

export function componentHighlight(s: HighlightSources): ComponentHighlight | null {
  // A diagnosis outranks everything, including the unit's own status: the
  // question has moved from "what is wrong" to "when is someone going out".
  const diagnosed = componentForJoint(s.verdictJoint);
  if (diagnosed) return { id: diagnosed, mode: "steady", tone: "warn" };

  // Mid-scan: the machine has named a joint but has not finished arguing it.
  const flagged = componentForJoint(s.flaggedJoint);
  if (flagged) return { id: flagged, mode: "pulse", tone: unitTone(s.status) };

  // Undiagnosed trouble: whatever the alert itself says, and only that.
  if (s.status && s.status !== "nominal") {
    const named = componentNamedIn(s.alertMessage);
    if (named) return { id: named, mode: "pulse", tone: unitTone(s.status) };
  }

  return null;
}

function unitTone(status: UnitStatus | undefined): "warn" | "alert" {
  return status === "red" ? "alert" : "warn";
}

/** The chip beside a component's name. Only the implicated part is not nominal. */
export function componentStatus(
  id: ComponentId,
  highlight: ComponentHighlight | null,
): StatusChipStatus {
  return highlight?.id === id ? highlight.tone : "nominal";
}

/* ---------------------------------------------------------------------------
   Emissive
   ---------------------------------------------------------------------------
   A component that glows like a lava lamp fails the taste bar, so the numbers
   below are deliberately small: this is a warm part in a lit room, not a
   status LED. Kept here, as a pure function of elapsed time, so the shape of
   the pulse is a unit test rather than something you have to film to check.
--------------------------------------------------------------------------- */

/** Settled diagnosis: no motion, just a part that stays warm. */
export const STEADY_EMISSIVE = 0.2;
const PULSE_MIN = 0.09;
const PULSE_MAX = 0.36;
/** Slow enough to read as breathing rather than as blinking. */
export const PULSE_PERIOD_MS = 2600;

export function emissiveIntensity(
  mode: HighlightMode,
  elapsedMs: number,
  reducedMotion = false,
): number {
  if (mode === "steady") return STEADY_EMISSIVE;
  // Under reduced motion the pulse holds at its own midpoint: the part still
  // reads as the one that is wrong, it just stops moving.
  if (reducedMotion) return (PULSE_MIN + PULSE_MAX) / 2;
  const phase = (elapsedMs % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
  return (
    PULSE_MIN + (PULSE_MAX - PULSE_MIN) * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase))
  );
}

/** Whether anything on screen is still moving — i.e. whether frames are owed. */
export function highlightNeedsFrames(
  highlight: ComponentHighlight | null,
  reducedMotion: boolean,
): boolean {
  return highlight?.mode === "pulse" && !reducedMotion;
}

/* ---------------------------------------------------------------------------
   Service records — SIMULATED
   ---------------------------------------------------------------------------
   The one place in this file that is not a fact about the hardware.

   A part detail card that showed only live telemetry would answer "how hot is
   it" and nothing else, and "how hot is it" is the question the strips already
   answer better. What turns a selection into a diagnosis is the second column:
   when was this last touched, what was done, and is it past due. A real console
   reads that from a maintenance system; this one has no maintenance system, so
   the table below stands in for it — and every surface that renders it labels
   it, in the operator's own view, with SERVICE_DISCLAIMER. A console that
   invents a service history and does not say so is a console that lies.

   Ages are stored as days-before-now rather than as calendar dates on purpose.
   A hardcoded "14 May 2026" is correct for about a fortnight and then quietly
   becomes a robot that has not been serviced in three years — the exact kind of
   rot that makes a demo look broken. Days-ago is always plausible, and the
   displayed date is derived from it against the app's own clock.
--------------------------------------------------------------------------- */

/** Shown wherever a service record is rendered. Not optional. */
export const SERVICE_DISCLAIMER = "Service records simulated";

export interface ServiceRecord {
  /** Age of the last service, in days before now. */
  servicedDaysAgo: number;
  /** What the technician wrote, in plain words. */
  note: string;
  /** Nominal interval between services, in days. */
  intervalDays: number;
}

/**
 * Eight parts, eight histories, and one of them is the story.
 *
 * `knee_actuator_L` is the only part past its interval, and it is the part
 * N-07's incident is about. That is not decoration: the whole argument for
 * putting service data next to live telemetry is that the two together say
 * something neither says alone — a knee running hot is a fault, and a knee
 * running hot thirty-three days past its service is an explanation.
 */
export const SERVICE_RECORDS: Record<ComponentId, ServiceRecord> = {
  head: {
    servicedDaysAgo: 96,
    note: "Sensor mast recalibrated; camera gaskets replaced.",
    intervalDays: 365,
  },
  torso: {
    servicedDaysAgo: 41,
    note: "Battery pack reseated; harness inspection passed.",
    intervalDays: 180,
  },
  arm_L: {
    servicedDaysAgo: 128,
    note: "Wrist tendon re-tensioned to spec.",
    intervalDays: 270,
  },
  arm_R: {
    servicedDaysAgo: 63,
    note: "Gripper pads replaced after wear check.",
    intervalDays: 270,
  },
  leg_L: {
    servicedDaysAgo: 74,
    note: "Hip bearing repacked; ankle play within spec.",
    intervalDays: 180,
  },
  leg_R: {
    servicedDaysAgo: 22,
    note: "Ankle actuator reseated after field swap.",
    intervalDays: 180,
  },
  knee_actuator_L: {
    servicedDaysAgo: 213,
    note: "Factory unit; no service since commissioning.",
    intervalDays: 180,
  },
  knee_actuator_R: {
    servicedDaysAgo: 37,
    note: "Encoder re-zeroed; torque curve within spec.",
    intervalDays: 180,
  },
};

export function serviceRecord(id: ComponentId): ServiceRecord {
  return SERVICE_RECORDS[id];
}

/**
 * Days until the next service is due — negative once it is overdue.
 *
 * Signed rather than split into a boolean and a magnitude, because the two
 * readings an operator wants from it ("due in 143 days", "33 days overdue") are
 * the same number with the sign read out loud.
 */
export function serviceDueInDays(record: ServiceRecord): number {
  return record.intervalDays - record.servicedDaysAgo;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * "14 May 2026", from a record and the app's clock.
 *
 * Written out by hand rather than through `Intl`: a locale-formatted date is a
 * different string on the server than in the browser, which is a hydration
 * mismatch on a page that prerenders — and it is a different string in CI than
 * on a laptop, which is a flaky test. Day-month-year with a short month name is
 * unambiguous everywhere, which is the only property this needs.
 *
 * Returns null before the client clock has started (`nowMs === 0`), the same
 * convention every other relative label on the page uses.
 */
export function serviceDateLabel(record: ServiceRecord, nowMs: number): string | null {
  if (nowMs === 0) return null;
  const d = new Date(nowMs - record.servicedDaysAgo * 86_400_000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* ---------------------------------------------------------------------------
   Selection
--------------------------------------------------------------------------- */

/**
 * Next selection for an arrow key. Nothing selected starts at the head rather
 * than wrapping from the end, so the first arrow press after focusing the
 * region always lands somewhere predictable.
 */
export function cycleSelection(current: ComponentId | null, delta: 1 | -1): ComponentId {
  const order: readonly ComponentId[] = COMPONENT_ORDER;
  // From nothing, step *onto* the ends: forward lands on the head, back on the
  // last part, rather than both landing next to wherever index 0 happens to be.
  const at = current ? order.indexOf(current) : delta === 1 ? -1 : 0;
  return order[(at + delta + order.length) % order.length] ?? COMPONENT_ORDER[0];
}

/** Arrow keys move the selection; Escape drops it; everything else is ignored. */
export function selectionKey(
  key: string,
  current: ComponentId | null,
): ComponentId | null | undefined {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return cycleSelection(current, 1);
    case "ArrowLeft":
    case "ArrowUp":
      return cycleSelection(current, -1);
    case "Escape":
      return current === null ? undefined : null;
    default:
      return undefined;
  }
}

/** Where the GLB lives. One constant, shared by the loader and its preload. */
export const CHASSIS_MODEL_URL = "/models/chassis-silhouette.glb";
