import {
  type Alert,
  type AlertMessage,
  type AnomalyKind,
  type CommandEventMessage,
  type DiagEventMessage,
  type ExecutedCommand,
  type FleetCommandEventMessage,
  type FleetMessage,
  type FleetSnapshotMessage,
  type OperatorCommand,
  type Posture,
  type TelemetryPoint,
  type UnitStatus,
  type UnitSummary,
  type VerdictReport,
} from "@/lib/schema";

/**
 * The simulator core (PRD §4, "the scripted incident").
 *
 * Pure TypeScript and transport-agnostic on purpose: no ws imports, no timers,
 * no Date.now(). The host (dev ws server today, Web Worker in Phase 6) owns the
 * clock and calls `advance(totalMs)`; the engine returns the FleetMessages due
 * since the previous call. That inversion is what makes the storyline unit-
 * testable at any time compression and identical across both transports.
 *
 * Determinism: per-unit character (base temps, gait phase, start battery) is
 * drawn once from a seeded mulberry32 stream, and per-sample noise is a pure
 * hash of (seed, unit, joint, storyline-slot) — so a run is a pure function of
 * (seed, timeline), RESET_SIM replays the exact same story, and two engines
 * with the same seed produce byte-identical streams.
 */

export const JOINTS = [
  "hip_L",
  "hip_R",
  "knee_L",
  "knee_R",
  "ankle_L",
  "ankle_R",
] as const;
export type Joint = (typeof JOINTS)[number];

export const INCIDENT_UNIT_ID = "N-07";
export const INCIDENT_JOINT = "knee_L" satisfies Joint;
export const INCIDENT_COMPONENT = "actuator_A07";

/**
 * The core eight homes around Bend, Oregon. Names are part of the product
 * voice. `unitCount` (SIM_UNITS / NEXT_PUBLIC_SIM_UNITS) appends generated
 * units after these — the eight are always present and always first, so N-07's
 * storyline survives any fleet size.
 */
export const FLEET_UNITS: ReadonlyArray<{
  id: string;
  name: string;
  pos: { lat: number; lng: number };
}> = [
  // Each home is named for the real street its (quantized) pin sits near —
  // reverse-geocoded, not guessed — so the map and the roster tell one story.
  { id: "N-01", name: "Prospect Row", pos: { lat: 37.511, lng: -122.272 } },
  { id: "N-02", name: "Cedar Hollow", pos: { lat: 37.4937, lng: -122.2549 } },
  { id: "N-03", name: "Carmelita Drive", pos: { lat: 37.4999, lng: -122.2776 } },
  { id: "N-04", name: "Taylor Bend", pos: { lat: 37.5152, lng: -122.2635 } },
  { id: "N-05", name: "Regent Court", pos: { lat: 37.4861, lng: -122.2864 } },
  { id: "N-06", name: "Hill Crossing", pos: { lat: 37.5202, lng: -122.2789 } },
  { id: "N-07", name: "Elm House", pos: { lat: 37.5018, lng: -122.2591 } },
  { id: "N-08", name: "Hubbard Farm", pos: { lat: 37.4803, lng: -122.2617 } },
];

// ---------------------------------------------------------------------------
// fleet scale: deterministic generation beyond the core eight

/** unitCount clamps to [8, 500]: the core eight always exist; 500 is the stress ceiling. */
export const MIN_UNIT_COUNT = FLEET_UNITS.length;
export const MAX_UNIT_COUNT = 500;

/**
 * Generated house names: 24 x 21 = 504 unique combinations — enough for the
 * 492 generated units at MAX_UNIT_COUNT, with the second-word list disjoint
 * from every handcrafted suffix so no generated name collides with the core
 * eight. Pure index math, no PRNG draws: names are stable per index.
 */
const GEN_NAME_FIRST: readonly string[] = [
  "Alder",
  "Aspen",
  "Birch",
  "Bristle",
  "Camas",
  "Cinder",
  "Dogwood",
  "Elm",
  "Fern",
  "Hazel",
  "Juniper",
  "Larch",
  "Lupine",
  "Mesa",
  "Obsidian",
  "Pine",
  "Ponderosa",
  "Quartz",
  "Rimrock",
  "Sierra",
  "Tamarack",
  "Thistle",
  "Timber",
  "Tumalo",
];
const GEN_NAME_SECOND: readonly string[] = [
  "Court",
  "Terrace",
  "Ridge",
  "Meadow",
  "Point",
  "Way",
  "Loop",
  "Green",
  "Rise",
  "Hill",
  "Grove",
  "Park",
  "Path",
  "Walk",
  "Run",
  "View",
  "Gate",
  "Yard",
  "Commons",
  "Corner",
  "Place",
];

/** Name for the i-th generated unit (0-based over the generated tail). */
function generatedName(i: number): string {
  const first = GEN_NAME_FIRST[i % GEN_NAME_FIRST.length]!;
  const second =
    GEN_NAME_SECOND[Math.floor(i / GEN_NAME_FIRST.length) % GEN_NAME_SECOND.length]!;
  return `${first} ${second}`;
}

/**
 * The Peninsula service region generated homes scatter across — a box a
 * little wider than the handcrafted eight (lat 37.4803–37.5202, lng
 * -122.2864 to -122.2549), so the 500-unit map reads as the same towns at
 * density. Narrower east–west than it is tall: the neighborhoods run in a
 * strip between the hills and the bay, and a box that ignored that would
 * scatter homes into the water.
 */
export const GEN_REGION = {
  latMin: 37.455,
  latMax: 37.555,
  lngMin: -122.315,
  lngMax: -122.245,
} as const;

/** Ids: core eight keep N-0X; generated units pad to the fleet's widest index. */
function unitIdFor(index: number, unitCount: number): string {
  const width = unitCount > 99 ? 3 : 2;
  return `N-${String(index + 1).padStart(width, "0")}`;
}

/** Storyline beats, ms of storyline time (zeroed by RESET_SIM). */
export interface IncidentTimeline {
  /** N-07 knee_L temperature starts climbing, torque ripple begins. */
  onsetMs: number;
  /** Amber alert fires; N-07 status → amber. */
  amberAtMs: number;
  /** Red alert fires; N-07 status → red. */
  redAtMs: number;
}

/** Real demo pacing: ~15 s calm, visible climb, amber at 28 s, red at 38 s. */
export const DEFAULT_TIMELINE: IncidentTimeline = {
  onsetMs: 15_000,
  amberAtMs: 28_000,
  redAtMs: 38_000,
};

/** 10 Hz batches (CLAUDE.md non-negotiable #4). */
export const BATCH_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// diagnostic scan choreography (PRD §4 diag_event sequence)

/**
 * Beat offsets for one diagnostic scan, ms after the RUN_DIAGNOSTIC command.
 * Same pattern as IncidentTimeline: a named-beat table, overridable per field
 * and compressible wholesale via `scaleDiagTimeline` (SIM_DIAG_SCALE on the
 * dev server). Invariants the defaults honor (overrides should too): walks
 * finish before the first channel; the flag lands between the incident
 * joint's channel and the verdict; the verdict comes last.
 */
export interface DiagTimeline {
  /** First `walk` line. */
  walkStartMs: number;
  /** Cadence between `walk` lines. */
  walkStepMs: number;
  /** First `channel` event (joints stream in JOINTS order). */
  channelStartMs: number;
  /** Cadence between `channel` events. */
  channelStepMs: number;
  /** `flag` delay after the incident joint's channel (failure path only). */
  flagDelayMs: number;
  /** `verdict` beat — the scan's total runtime. */
  verdictAtMs: number;
}

/**
 * Default pacing, ~15 s command → verdict:
 *
 * beat t (s)
 * scan_start 0 (emitted synchronously with the command)
 * walk x20 1.0 → 5.75 (250 ms cadence)
 * channel hip_L 6.5
 * channel hip_R 7.8
 * channel knee_L 9.1
 * flag 9.7 (failure path only; scan keeps walking)
 * channel knee_R 10.4
 * channel ankle_L 11.7
 * channel ankle_R 13.0
 * verdict 15.0
 */
export const DEFAULT_DIAG_TIMELINE: DiagTimeline = {
  walkStartMs: 1_000,
  walkStepMs: 250,
  channelStartMs: 6_500,
  channelStepMs: 1_300,
  flagDelayMs: 600,
  verdictAtMs: 15_000,
};

/** Uniformly compress (or stretch) a diag timeline; scale 0.1 = 10x faster. */
export function scaleDiagTimeline(t: DiagTimeline, scale: number): DiagTimeline {
  return {
    walkStartMs: Math.round(t.walkStartMs * scale),
    walkStepMs: Math.round(t.walkStepMs * scale),
    channelStartMs: Math.round(t.channelStartMs * scale),
    channelStepMs: Math.round(t.channelStepMs * scale),
    flagDelayMs: Math.round(t.flagDelayMs * scale),
    verdictAtMs: Math.round(t.verdictAtMs * scale),
  };
}

/**
 * The MAGI-style program walk the ScanLog renders: one coherent pass through
 * the robot's tree — core services, actuator bus (knee_L is A07, the flagged
 * component), gait firmware, per-joint gain calibration (foreshadowing the
 * verdict), proprioception. Identical for every scan: a scan is a scan.
 */
export const DIAG_WALK_PATHS: readonly string[] = [
  "/sys/core/heartbeat.svc",
  "/sys/core/power_rail/v48_main",
  "/sys/core/thermal/zone_map.cfg",
  "/sys/actuator_bus/enumerate",
  "/sys/actuator_bus/hip_L/actuator_A03",
  "/sys/actuator_bus/hip_R/actuator_A04",
  "/sys/actuator_bus/knee_L/actuator_A07",
  "/sys/actuator_bus/knee_R/actuator_A08",
  "/sys/actuator_bus/ankle_L/actuator_A11",
  "/sys/actuator_bus/ankle_R/actuator_A12",
  "/firmware/gait/park_pose.ko",
  "/firmware/gait/walk_cycle.ko",
  "/firmware/gait/balance_reflex.ko",
  "/calib/hip_L/gain_table.bin",
  "/calib/hip_R/gain_table.bin",
  "/calib/knee_L/gain_table.bin",
  "/calib/knee_R/gain_table.bin",
  "/calib/ankle_L/gain_table.bin",
  "/calib/ankle_R/gain_table.bin",
  "/proprio/imu/fusion_state",
];

/** Samples per channel trace (~120, normalized -1..1 — the WaveformStrip contract). */
export const CHANNEL_SAMPLES = 120;

/** Failing-channel gain ramp: live trace amplitude vs reference across the window. */
export const FAULT_GAIN_START = 1.35;
export const FAULT_GAIN_END = 1.8;

// ---------------------------------------------------------------------------
// SAFE SIT execution — the one command the sim actually performs

/**
 * SAFE SIT pacing, ms after the accepted command. Same named-beat pattern as
 * IncidentTimeline / DiagTimeline. Invariant: completeAtMs >= rampMs — the
 * command completes only after the physical maneuver has settled.
 */
export interface SitTimeline {
  /**
   * The physical maneuver: torque and gait ripple fade to a seated hold over
   * this window, knee temperature starts its decay at 0, and posture flips to
   * "sitting" at its end. Progress beats land at fixed fractions of it.
   */
  rampMs: number;
  /** `complete` beat — the command's total runtime (post-settle verification). */
  completeAtMs: number;
}

/** Real demo pacing: ~2 s visible ramp-down, complete at 4 s. */
export const DEFAULT_SIT_TIMELINE: SitTimeline = {
  rampMs: 2_000,
  completeAtMs: 4_000,
};

/**
 * Progress narration, machine voice (the UI prints notes verbatim). Beats land
 * at `frac * rampMs`; the last one (frac 1) is the instant posture flips.
 */
export const SIT_PROGRESS_BEATS: ReadonlyArray<{
  frac: number;
  pct: number;
  note: string;
}> = [
  { frac: 0.25, pct: 20, note: "GAIT ARRESTED" },
  { frac: 0.5, pct: 45, note: "CROUCH PHASE" },
  { frac: 0.75, pct: 70, note: "TORQUE RAMP-DOWN" },
  { frac: 1, pct: 90, note: "POSTURE SETTLED" },
];

/** Refusal reasons, machine voice, printed verbatim by the UI. */
export const SIT_REFUSAL_ALREADY_SITTING = "ALREADY SITTING";
export const SIT_REFUSAL_SIT_IN_PROGRESS = "SIT IN PROGRESS";
export const SIT_REFUSAL_SCAN_IN_PROGRESS = "SCAN IN PROGRESS";

/**
 * Post-sit thermal time constant: joint temps decay toward their resting base
 * as exp(-dt/tau). 20 s puts a clearly falling slope inside the 60 s sparkline
 * window without pretending actuators cool instantly.
 */
export const SIT_TEMP_TAU_MS = 20_000;

// ---------------------------------------------------------------------------
// RECALIBRATE JOINT execution — the cheapest rung, and a real one

/**
 * Recalibration pacing, ms after the accepted command. Same named-beat pattern
 * as SitTimeline, and the same invariant: `completeAtMs >= sweepMs`. The gap
 * between them is not padding — it is the re-measure, which is the entire
 * point of the maneuver and the reason COMPLETE means something here.
 */
export interface RecalTimeline {
  /** The sweep: the joint is driven through its unloaded range and a new gain table is written. */
  sweepMs: number;
  /** `complete` beat — sweep plus the verification pass that produces the new channel. */
  completeAtMs: number;
}

/** Real demo pacing: ~2.5 s of sweep, re-measured and complete at 4.5 s. */
export const DEFAULT_RECAL_TIMELINE: RecalTimeline = {
  sweepMs: 2_500,
  completeAtMs: 4_500,
};

/**
 * Progress narration, machine voice (the UI prints notes verbatim). Beats land
 * at `frac * sweepMs`; the last one is the new table being written, after
 * which the machine goes quiet and measures.
 */
export const RECAL_PROGRESS_BEATS: ReadonlyArray<{
  frac: number;
  pct: number;
  note: string;
}> = [
  { frac: 0.2, pct: 15, note: "JOINT UNLOADED" },
  { frac: 0.45, pct: 40, note: "RANGE SWEEP 1/2" },
  { frac: 0.7, pct: 65, note: "RANGE SWEEP 2/2" },
  { frac: 1, pct: 85, note: "GAIN TABLE WRITTEN" },
];

/**
 * Refusal reasons, machine voice, printed verbatim by the UI.
 *
 * REQUIRES SEATED POSTURE is the load-bearing one and it is a refusal rather
 * than a warning: driving a knee through its range while the robot stands on
 * it is the failure the SAFE SIT exists to prevent. The console gates the
 * control on posture too, so an operator should never see this line — it is
 * here because the sim does not trust a client to enforce a physical
 * precondition, which is the same reason the posture gate is not the only
 * thing standing between DISABLE JOINT and a dropped robot.
 */
export const RECAL_REFUSAL_IN_PROGRESS = "RECALIBRATION IN PROGRESS";
export const RECAL_REFUSAL_SIT_IN_PROGRESS = "SIT IN PROGRESS";
export const RECAL_REFUSAL_NOT_SEATED = "REQUIRES SEATED POSTURE";
export const RECAL_REFUSAL_SCAN_IN_PROGRESS = "SCAN IN PROGRESS";
export const RECAL_REFUSAL_CURRENT = "CALIBRATION CURRENT";
export const RECAL_REFUSAL_NO_TARGET = "NO CALIBRATION TARGET";

/**
 * What a calibration is worth on this fault, as a gain ramp replacing
 * FAULT_GAIN_START/END on the re-measured channel.
 *
 * The verdict's own differential says GAIN DRIFT · TENDON WEAR · ACTUATOR
 * DEGRADATION. A calibration rewrites a gain table, which is the first of
 * those and none of the other two, so the correctable component comes out and
 * the wear-driven ramp stays — the trace lands between healthy and failing
 * rather than on either. That is not a dramatic choice dressed up as a
 * physical one: a correction that zeroed a mechanical fault would be the sim
 * telling the operator a robot with a worn tendon is fine.
 *
 * The numbers are chosen against the thresholds the whole product reads
 * channels by (components/machine/waveform-math.ts): the re-measured RMS lands
 * above RMS_HEALTHY and below RMS_FAILING, so the trace visibly changes tone
 * from alert to warn. Improved, not fixed, in the one variable the console
 * already colours by. sim/diagnostics.test.ts holds that band as a contract.
 */
export const CALIB_GAIN_START = 1.18;
export const CALIB_GAIN_END = 1.38;

// ---------------------------------------------------------------------------
// N-01 encoder-offset incident — the second ending

/**
 * The fourth deterministic storyline, and the counterpart the recalibration
 * mechanism was built to have: a fault the cheap rung actually fixes.
 *
 * N-07's knee is a gain anomaly over tendon wear, so a rewritten gain table
 * takes out the part it can reach and the rest is mechanical — PARTIAL, and
 * that is what earns the van. This one is an encoder whose zero has drifted:
 * the joint reports a position biased from the truth, the gait controller
 * compensates, and the robot walks very slightly crooked. Re-zeroing an encoder
 * is *exactly* what a calibration is, so here the ladder stops at rung two —
 * remote operations — and nobody drives anywhere.
 *
 * N-01 because it is the only unit in the core eight that no other storyline
 * touches: N-07 has the knee, N-03 the blocked route, N-02/04/06/08 the rollout
 * cohort, N-05 the queued install. Collision-free by construction rather than
 * by scheduling luck.
 */
export const OFFSET_UNIT_ID = "N-01";
export const OFFSET_JOINT = "ankle_R" satisfies Joint;
export const OFFSET_COMPONENT = "actuator_A12";

/**
 * The encoder's zero error, in the channel's own normalized units — a DC
 * displacement of the whole trace, NOT a scaling of it.
 *
 * That is the entire visual argument for a second anomaly kind, and it reads
 * without a caption: a gain fault has the right shape at the wrong amplitude
 * (the trace grows away from its reference), an offset fault has the right
 * shape at the wrong datum (the trace rides parallel above it, envelope
 * intact). Two failures, two silhouettes.
 *
 * Sized against the thresholds the whole product reads channels by
 * (components/machine/waveform-math.ts). For a pure displacement the RMS
 * deviation IS the displacement, so 0.21 lands well clear of RMS_FAILING and
 * the channel comes in alert-toned — a verdict, measured the same way the
 * knee's is. sim/diagnostics.test.ts holds the band as a contract.
 */
export const OFFSET_BIAS = 0.21;

/**
 * What the drift costs the rest of the machine, and why it is nearly invisible
 * until something looks.
 *
 * A mis-zeroed ankle is not a hot ankle. The controller holds a small standing
 * torque against a joint it believes is somewhere it is not, and the joint runs
 * a couple of degrees warm for it — enough to see on the unit page's strips
 * once you are already looking at them, nowhere near enough to move a status
 * chip. The fleet view stays green until the alert below, which is the honest
 * shape of this fault class and the reason the *scan* is what finds it.
 */
export const OFFSET_TORQUE_BIAS = 1.2;
export const OFFSET_TEMP_RISE = 2.4;

/** Storyline beats, ms of storyline time (zeroed by RESET_SIM). */
export interface OffsetTimeline {
  /** The unit's own monitor trips and raises the amber. */
  alertAtMs: number;
}

/**
 * Real demo pacing: the amber lands at 5:30, into a fleet where every other
 * storyline has finished — the knee window (amber 58 s, red 72 s) and the walk
 * it starts, N-03's replan (120–160 s), and the whole rollout act (raises
 * 180–210 s, queued install 270 s, a staged rollback done by ~300 s). This act
 * needs about a minute of an operator's undivided attention, and that is the
 * first minute in the programme where nothing else is asking for any.
 *
 * The fault itself is NOT on this clock. An encoder zero does not ramp — it
 * drifted at some point in the past and has been quietly wrong ever since, so
 * the channel is displaced from the first sample of the run and a scan finds it
 * whenever one is asked for. What waits until this beat is the unit's own
 * detector: gait asymmetry is a slow statistical estimate over many strides,
 * which is exactly why a small persistent bias takes minutes to trip a
 * threshold that a thermal runaway trips in seconds.
 *
 * That split is also what keeps the act cheap to demonstrate. The alert is how
 * the fleet *tells* you; running a diagnostic on N-01 is how you can ask, and
 * the answer is the same at 0:10 as at 5:31.
 */
export const DEFAULT_OFFSET_TIMELINE: OffsetTimeline = {
  alertAtMs: 330_000,
};

/**
 * Operator-voice alert copy, unit-name prefixed like every per-unit alert (the
 * cohort signature is the deliberate exception).
 *
 * Amber, and amber is where it stays: unlike the knee there is no escalation
 * beat, because nothing here is getting worse. A drifted zero is as wrong today
 * as it will be tomorrow, and an alert that climbed to red would be the sim
 * manufacturing urgency the physics does not support.
 */
export const OFFSET_ALERT_MESSAGE =
  "right ankle position feedback offset — gait asymmetry above threshold";

// ---------------------------------------------------------------------------
// the scripted faults, and what a calibration is worth on each

/**
 * How a flagged channel is wrong, as the scan measures it — the shape passed to
 * `buildChannel`, with `null` meaning a channel that sits on its reference.
 *
 * A discriminated union rather than a bag of optional numbers: the two faults
 * are alternatives, never a blend, and a channel carrying both a gain ramp and
 * a datum bias is not a thing this simulator should be able to construct.
 */
export type ChannelFault =
  | { kind: "gain"; start: number; end: number }
  | { kind: "offset"; bias: number };

/** One scripted fault: where it is, what it is, and what the verdict says about it. */
export interface ScriptedFault {
  unitId: string;
  joint: Joint;
  component: string;
  anomaly: AnomalyKind;
  /** The failing channel's signature. */
  channel: ChannelFault;
  /** The verdict's own words, machine voice. */
  summary: string;
  /**
   * Cheapest-first, human escalation last — the order the verdict card reads
   * as a procedure. What is *absent* is as deliberate as what is present.
   */
  recommendations: readonly string[];
}

export const KNEE_FAULT: ScriptedFault = {
  unitId: INCIDENT_UNIT_ID,
  joint: INCIDENT_JOINT,
  component: INCIDENT_COMPONENT,
  anomaly: "gain",
  channel: { kind: "gain", start: FAULT_GAIN_START, end: FAULT_GAIN_END },
  summary: "LEFT KNEE ACTUATOR A-07: GAIN ANOMALY. LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE.",
  // Calibration-first: the least invasive response leads, the human
  // escalation closes, and the one command the sim executes sits second. The
  // card classifies these by IDENTITY, not position (safe-sit-copy.ts):
  // "Command safe sit" and "Recalibrate joint" execute; the other two record to
  // the incident — and "Disable joint" is posture-gated there.
  recommendations: ["Recalibrate joint", "Command safe sit", "Disable joint", "Dispatch service"],
};

export const OFFSET_FAULT: ScriptedFault = {
  unitId: OFFSET_UNIT_ID,
  joint: OFFSET_JOINT,
  component: OFFSET_COMPONENT,
  anomaly: "offset",
  channel: { kind: "offset", bias: OFFSET_BIAS },
  // "ENVELOPE INTACT" is the differentiating half of the sentence and the
  // reason this is not the knee's verdict with different nouns: the shape is
  // right, the zero is not. The figure is interpolated from the constant so the
  // machine's own words cannot drift from what it emitted.
  summary: `RIGHT ANKLE ACTUATOR A-12: OFFSET ANOMALY. LIVE TRACE DISPLACED ${OFFSET_BIAS.toFixed(2)} FROM REFERENCE DATUM, ENVELOPE INTACT.`,
  // No "Disable joint". Taking a joint out of service is what you do to a
  // component that is failing under load; this one carries load perfectly well
  // and simply believes it is somewhere it is not. Dispatch still closes the
  // list — if a re-zero does not hold, the mount has moved and that IS a visit
  // — and the point of the act is that it is never reached.
  recommendations: ["Recalibrate joint", "Command safe sit", "Dispatch service"],
};

/**
 * What a calibration is worth, keyed by the kind of fault it was aimed at.
 *
 * The seam left here, and the reason the outcome is a table
 * rather than a branch: it is a property of the anomaly, never of chance.
 * Non-negotiable 6 wants the scripted incident re-runnable, and a coin flip
 * means one run of the demo shows the escalation ladder and the next does not.
 *
 * - `gain` → PARTIAL. A calibration rewrites a gain table, which is the first
 * entry of that differential and none of the other two, so the correctable
 * component comes out and the wear-driven ramp stays. The trace lands between
 * healthy and failing: over RMS_HEALTHY, under RMS_FAILING, alert → warn.
 * - `offset` → CLEARED, with `null` for the residual, which is not shorthand
 * for "nearly right" — it is the healthy-channel construction. Re-zeroing an
 * encoder does not leave a smaller offset behind; it removes the offset, and
 * the channel that comes back is indistinguishable from one that was never
 * wrong. Anything else would be the sim withholding a fix it just performed.
 */
export const CALIBRATION_OUTCOME: Readonly<
  Record<AnomalyKind, { outcome: "partial" | "cleared"; residual: ChannelFault | null }>
> = {
  gain: {
    outcome: "partial",
    residual: { kind: "gain", start: CALIB_GAIN_START, end: CALIB_GAIN_END },
  },
  offset: { outcome: "cleared", residual: null },
};

// ---------------------------------------------------------------------------
// N-03 blocked-navigation self-recovery

/**
 * The second deterministic storyline: N-03 halts on a blocked route, raises an
 * amber, replans, and clears its own alert — the fleet handling routine
 * ambiguity autonomously, with zero operator action, while N-07 stays the
 * escalation exception. The raise is an ordinary `alert`; the clear is the
 * additive `alert_clear` message (resolution via "self-recovery") followed by
 * a `unit_update` restating the unit nominal — the same restatement mechanism
 * the SAFE SIT settle beat uses, because status is snapshot-carried state.
 */
export const NAV_UNIT_ID = "N-03";

/** Storyline beats, ms of storyline time (zeroed by RESET_SIM), like IncidentTimeline. */
export interface NavTimeline {
  /** N-03 halts and raises the amber ("navigation blocked"). */
  blockAtMs: number;
  /** The route replans; the alert clears itself. Invariant: > blockAtMs. */
  clearAtMs: number;
}

/** Real demo pacing: blocked ~2 min in, self-resolved 40 s later. */
export const DEFAULT_NAV_TIMELINE: NavTimeline = {
  blockAtMs: 120_000,
  clearAtMs: 160_000,
};

/**
 * Halt/resume ramp. The robot is not a switch: gait ripple fades out over this
 * window at the block beat and back in at the clear — the same smoothstep the
 * SAFE SIT ramp uses, because it is the same physical act of stopping.
 */
export const NAV_RAMP_MS = 2_000;

/** Operator-voice alert copy; the unit's name is prefixed like every alert. */
export const NAV_BLOCK_MESSAGE = "navigation blocked — replanning around obstruction";

// ---------------------------------------------------------------------------
// firmware rollout cohort — the fleet-wide storyline

/**
 * The third deterministic storyline, and the epic's thesis: fleet management
 * is managing blast radius. A firmware rollout (2.3.7 → 2.4.1) has reached
 * half the fleet when every upgraded unit starts saying the same words — the
 * cohort signature — while one more unit sits queued for the same build. The
 * operator's moves are fleet-scoped: HALT_ROLLOUT saves the queued unit
 * before its install lands, ROLLBACK_COHORT restores the affected units one
 * at a time. N-07's knee incident and N-03's blocked navigation coexist
 * untouched — a mechanical fault and a routine replan are exactly what the
 * canary comparison must NOT count.
 */

/** The known-good baseline every unit shipped on. */
export const FW_STABLE = "2.3.7";
/** The rollout build — the one the cohort incriminates. */
export const FW_ROLLOUT = "2.4.1";

/**
 * The rollout wave: four units already running FW_ROLLOUT. Chosen to keep
 * every other storyline's unit on the baseline — N-07 (knee incident) and
 * N-03 (blocked navigation) must read clean in the canary comparison.
 */
export const ROLLOUT_UNIT_IDS: readonly string[] = ["N-02", "N-04", "N-06", "N-08"];

/**
 * The queued fifth install: N-05 stays on FW_STABLE with `fwPending`
 * FW_ROLLOUT until the scheduler reaches it at `pendingAtMs` — unless
 * HALT_ROLLOUT lands first. That race is the storyline's save.
 */
export const PENDING_UNIT_ID = "N-05";

/**
 * The cohort signature — deliberately NOT prefixed with the unit's name like
 * every other alert: the signal IS four units saying byte-identical words.
 * Client-side cohort detection groups unresolved alerts by exactly this
 * string plus the unit's firmware (lib/stores/cohortStore.ts).
 */
export const COHORT_ALERT_MESSAGE = "Balance reflex latency above threshold";

/** Storyline beats + rollback pacing, ms of storyline time (zeroed by RESET_SIM). */
export interface CohortTimeline {
  /** First rollout unit raises the signature amber. */
  onsetMs: number;
  /** Cadence between the rollout units' raises (4 units span 3 staggers). */
  staggerMs: number;
  /**
   * The queued unit's install lands — unless the rollout was halted first.
   * An installed build then raises the same signature at `pendingAtMs +
   * staggerMs`: halting late does not un-install, so the save has a deadline.
   */
  pendingAtMs: number;
  /** ROLLBACK_COHORT pacing: one unit restored per this window, strictly serial. */
  rollbackPerUnitMs: number;
}

/**
 * Real demo pacing: the cohort forms AFTER the N-07 window (amber 58 s, red
 * 72 s) and the N-03 replan (120–160 s), so the default demo keeps N-07 first.
 * Raises at 180/190/200/210 s (~30 s of stagger); the queued install at
 * onset + 90 s; rollback ~4 s per unit.
 */
export const DEFAULT_COHORT_TIMELINE: CohortTimeline = {
  onsetMs: 180_000,
  staggerMs: 10_000,
  pendingAtMs: 270_000,
  rollbackPerUnitMs: 4_000,
};

/** Refusal reasons, machine voice, printed verbatim by the UI. */
export const ROLLOUT_REFUSAL_NO_ROLLOUT_ACTIVE = "NO ROLLOUT ACTIVE";
export const ROLLOUT_REFUSAL_ROLLBACK_IN_PROGRESS = "ROLLBACK IN PROGRESS";

export interface SimEngineOptions {
  seed?: number;
  /** Epoch offset added to every emitted ts. 0 (default) keeps ts == sim ms for tests. */
  startTimeMs?: number;
  timeline?: Partial<IncidentTimeline>;
  batchIntervalMs?: number;
  /** Diagnostic scan pacing; see DEFAULT_DIAG_TIMELINE. */
  diagTimeline?: Partial<DiagTimeline>;
  /** SAFE SIT pacing; see DEFAULT_SIT_TIMELINE. */
  sitTimeline?: Partial<SitTimeline>;
  /** RECALIBRATE JOINT pacing; see DEFAULT_RECAL_TIMELINE. */
  recalTimeline?: Partial<RecalTimeline>;
  /** N-03 blocked-navigation beats; see DEFAULT_NAV_TIMELINE. */
  navTimeline?: Partial<NavTimeline>;
  /** N-01 encoder-offset beats; see DEFAULT_OFFSET_TIMELINE. */
  offsetTimeline?: Partial<OffsetTimeline>;
  /** Firmware-cohort beats + rollback pacing; see DEFAULT_COHORT_TIMELINE. */
  cohortTimeline?: Partial<CohortTimeline>;
  /**
   * Fleet size, clamped to [MIN_UNIT_COUNT, MAX_UNIT_COUNT] (8–500). The core
   * eight are always units 0–7; the rest are generated deterministically from
   * the seed (SIM_UNITS / NEXT_PUBLIC_SIM_UNITS on the hosts).
   */
  unitCount?: number;
}

export interface SimEngine {
  /** Fleet state right now — sent to every client on connect. */
  snapshot(): FleetSnapshotMessage;
  /**
   * Alerts raised in the current storyline run (cleared by RESET_SIM). The
   * host replays these to late-joining clients right after the snapshot, so a
   * page refresh mid-incident still shows the alert feed, not just statuses.
   */
  activeAlerts(): AlertMessage[];
  /**
   * diag_events emitted so far by the active scan, oldest first (empty when no
   * scan is in flight). The host replays these to late joiners after snapshot
   * + alerts: the incident store adopts an in-flight scan on `scan_start`, so
   * a page refreshed mid-descent resumes exactly where the scan is. Cleared
   * when the verdict lands (the scan is over) and by RESET_SIM.
   */
  activeDiagEvents(): DiagEventMessage[];
  /**
   * command_events emitted so far by in-flight per-unit commands — SAFE SIT
   * and RECALIBRATE JOINT — (accepted + progress beats), oldest first per
   * unit. The host replays these after the diag events, so a client joining
   * mid-maneuver sees the command executing rather than a unit that quietly
   * changes posture. Cleared per unit when its `complete` lands and by
   * RESET_SIM; refusals are never replayed (a failed command has no lifetime).
   */
  activeCommandEvents(): CommandEventMessage[];
  /**
   * fleet_command_events emitted so far by an in-flight ROLLBACK_COHORT
   * (accepted + progress beats), oldest first. The host replays these last —
   * after the per-unit command_events — so a client joining mid-rollback sees
   * the staged restoration executing. Firmware itself needs no replay: `fw` /
   * `fwPending` ride the greeting snapshot, and already-restored units are
   * already restored there. Cleared when `complete` lands and by RESET_SIM;
   * HALT_ROLLOUT is fully synchronous, so it never appears here, and refusals
   * are never replayed.
   */
  activeFleetCommandEvents(): FleetCommandEventMessage[];
  /** Advance the sim clock to `totalMs` (monotonic, ms since engine start); returns messages due since the last call. */
  advance(totalMs: number): FleetMessage[];
  /** Apply an operator command; returns messages to broadcast (e.g. a fresh snapshot after RESET_SIM). */
  handle(cmd: OperatorCommand): FleetMessage[];
}

// ---------------------------------------------------------------------------
// deterministic randomness

/** mulberry32 — tiny seeded PRNG for per-unit character drawn at init. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless noise in [-1, 1): a pure function of its keys, so a sample never depends on call order. */
function noise(seed: number, k1: number, k2: number, k3: number, k4: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (k1 + 0x9e3779b9), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (k2 + 0x9e3779b9), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16) ^ (k3 + 0x9e3779b9), 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15) ^ (k4 + 0x9e3779b9), 0x165667b1);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

// ---------------------------------------------------------------------------
// per-unit character

/** Anti-phase left/right legs; knees and ankles lag the hips. */
const JOINT_PHASE: Record<Joint, number> = {
  hip_L: 0,
  hip_R: Math.PI,
  knee_L: 0.6,
  knee_R: Math.PI + 0.6,
  ankle_L: 1.2,
  ankle_R: Math.PI + 1.2,
};

const BASE_TORQUE: Record<Joint, number> = {
  hip_L: 17,
  hip_R: 17,
  knee_L: 13,
  knee_R: 13,
  ankle_L: 8,
  ankle_R: 8,
};

const GAIT_AMP: Record<Joint, number> = {
  hip_L: 5.5,
  hip_R: 5.5,
  knee_L: 4.5,
  knee_R: 4.5,
  ankle_L: 2.8,
  ankle_R: 2.8,
};

/** Battery drain, percent per ms (~0.35 %/min while pottering around the house). */
const BATTERY_DRAIN_PER_MS = 0.35 / 60_000;

interface UnitState {
  id: string;
  name: string;
  pos: { lat: number; lng: number };
  status: UnitStatus;
  batteryStart: number;
  battery: number;
  baseTemp: Record<Joint, number>;
  gaitFreqHz: number;
  gaitPhase: number;
  activityPeriodMs: number;
  activityPhase: number;
  unitIndex: number;
  posture: Posture;
  /** Storyline ms at which the accepted SAFE SIT began; null while walking. */
  sitStartMs: number | null;
  /** Installed firmware (FW_STABLE or FW_ROLLOUT). */
  fw: string;
  /** Scheduled-but-not-installed upgrade; null unless the rollout has this unit queued. */
  fwPending: string | null;
}

/**
 * Draw order is the determinism contract: the core eight consume exactly the
 * PRNG draws they always have (11 per unit, in this order), THEN each
 * generated unit draws 2 position jitters + the same 11 — so the eight-unit
 * stream is byte-identical whatever `unitCount` is, and N-01…N-08 emit the
 * same telemetry at 8 units and at 500.
 */
function initUnits(seed: number, unitCount: number): UnitState[] {
  const rand = mulberry32(seed);

  const drawCharacter = (
    u: { id: string; name: string; pos: { lat: number; lng: number } },
    unitIndex: number,
  ): UnitState => {
    const baseTemp = {} as Record<Joint, number>;
    for (const j of JOINTS) baseTemp[j] = 30 + rand() * 5; // 30–35 C at rest
    const batteryStart = 62 + rand() * 34; // 62–96 %
    return {
      ...u,
      status: "nominal" as UnitStatus,
      batteryStart,
      battery: batteryStart,
      baseTemp,
      gaitFreqHz: 0.8 + rand() * 0.3, // step cadence
      gaitPhase: rand() * Math.PI * 2,
      activityPeriodMs: 40_000 + rand() * 50_000, // walk / rest cycles
      activityPhase: rand() * Math.PI * 2,
      unitIndex,
      posture: "walking" as Posture,
      sitStartMs: null,
      // Firmware distribution is pure id lookup — zero PRNG draws, so the
      // draw-order contract above holds and pre-Phase-11 streams stay
      // byte-identical. Generated units (beyond the core eight) all run the
      // baseline: the rollout wave touched only the named fleet.
      fw: ROLLOUT_UNIT_IDS.includes(u.id) ? FW_ROLLOUT : FW_STABLE,
      fwPending: u.id === PENDING_UNIT_ID ? FW_ROLLOUT : null,
    };
  };

  const units = FLEET_UNITS.map((u, i) => drawCharacter(u, i));

  // Generated tail: a seeded grid-jitter scatter over GEN_REGION. Grid cells
  // keep density even at 500; the jitter keeps it from reading as a lattice.
  const extra = unitCount - FLEET_UNITS.length;
  if (extra > 0) {
    const cols = Math.ceil(Math.sqrt(extra));
    const rows = Math.ceil(extra / cols);
    const latStep = (GEN_REGION.latMax - GEN_REGION.latMin) / rows;
    const lngStep = (GEN_REGION.lngMax - GEN_REGION.lngMin) / cols;
    for (let i = 0; i < extra; i += 1) {
      const unitIndex = FLEET_UNITS.length + i;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const jLat = rand() * 2 - 1;
      const jLng = rand() * 2 - 1;
      const pos = {
        lat: round4(GEN_REGION.latMin + (row + 0.5 + 0.45 * jLat) * latStep),
        lng: round4(GEN_REGION.lngMin + (col + 0.5 + 0.45 * jLng) * lngStep),
      };
      units.push(
        drawCharacter(
          { id: unitIdFor(unitIndex, unitCount), name: generatedName(i), pos },
          unitIndex,
        ),
      );
    }
  }

  return units;
}

// ---------------------------------------------------------------------------
// engine

export function createSimEngine(options: SimEngineOptions = {}): SimEngine {
  const seed = options.seed ?? 0x5eed;
  const startTimeMs = options.startTimeMs ?? 0;
  const interval = options.batchIntervalMs ?? BATCH_INTERVAL_MS;
  const timeline: IncidentTimeline = { ...DEFAULT_TIMELINE, ...options.timeline };
  const diagTimeline: DiagTimeline = {
    ...DEFAULT_DIAG_TIMELINE,
    ...options.diagTimeline,
  };
  const sitTimeline: SitTimeline = { ...DEFAULT_SIT_TIMELINE, ...options.sitTimeline };
  const recalTimeline: RecalTimeline = {
    ...DEFAULT_RECAL_TIMELINE,
    ...options.recalTimeline,
  };
  const navTimeline: NavTimeline = { ...DEFAULT_NAV_TIMELINE, ...options.navTimeline };
  const offsetTimeline: OffsetTimeline = {
    ...DEFAULT_OFFSET_TIMELINE,
    ...options.offsetTimeline,
  };
  const cohortTimeline: CohortTimeline = {
    ...DEFAULT_COHORT_TIMELINE,
    ...options.cohortTimeline,
  };
  const unitCount = Math.min(
    MAX_UNIT_COUNT,
    Math.max(MIN_UNIT_COUNT, Math.round(options.unitCount ?? FLEET_UNITS.length)),
  );

  /** If advance() is called after a huge gap (laptop slept), emit at most this many slots. */
  const MAX_CATCHUP_SLOTS = 100;

  let units = initUnits(seed, unitCount);
  let lastSlot = 0; // last emitted slot on the total-time grid
  let storylineStartMs = 0; // total-time ms at which the current run began
  let alertSeq = 0;
  let raisedAlerts: AlertMessage[] = []; // this run's alerts, for late-joiner replay
  /** This run's N-03 nav alert, until it self-clears (null before and after). */
  let navAlertId: string | null = null;
  /** This run's N-01 offset amber, until a calibration clears it (null before and after). */
  let offsetAlertId: string | null = null;
  /**
   * Latched when a recalibration re-zeroes N-01's encoder: from that instant
   * the fault does not exist — the telemetry bias stops, a re-scan finds six
   * clean channels, and the amber that had not raised yet never does. A fix
   * that only silenced the alert would leave the console able to contradict
   * itself the moment anyone scanned again.
   */
  let offsetCleared = false;
  /** Never reset (like alertSeq): command_event seqs stay unique across RESET_SIM. */
  let commandSeq = 0;

  /** The one in-flight scan (the scanner is a shared resource; one at a time). */
  let diagSession: {
    unitId: string;
    /** Still-due beats, ascending by atTotalMs. */
    pending: Array<{ atTotalMs: number; msg: DiagEventMessage }>;
    /** Everything already emitted (scan_start first), for late-joiner replay. */
    emitted: DiagEventMessage[];
  } | null = null;

  /**
   * Rollout program state. `rolloutHalted` flips on HALT_ROLLOUT —
   * and on ROLLBACK_COHORT of the rollout build, which implies it (rolling a
   * build back while still installing it would be self-sabotage). Cleared by
   * RESET_SIM: the storyline replays, queued install included.
   */
  let rolloutHalted = false;
  /**
   * This run's still-active cohort alerts, unitId → alertId — the ids a staged
   * rollback's per-unit `alert_clear`s cite. Entries leave when cleared;
   * wholesale on RESET_SIM.
   */
  const cohortAlertIds = new Map<string, string>();

  /**
   * The one in-flight staged rollback (the rollout program is one resource,
   * like the scanner — ROLLBACK IN PROGRESS refuses a second). Beats carry
   * their consequences by unit id and are applied at drain time, because the
   * firmware flip must happen at the beat, not at accept.
   */
  type RollbackBeat =
    | { atTotalMs: number; kind: "note"; msg: FleetCommandEventMessage }
    | { atTotalMs: number; kind: "unitDone"; unitId: string }
    | { atTotalMs: number; kind: "complete"; msg: FleetCommandEventMessage };
  let rollbackSession: {
    /** The build being rolled back (the cohort's fw). */
    fromFw: string;
    /** The known-good baseline the units return to. */
    toFw: string;
    /** Still-due beats, ascending by atTotalMs (built in emission order). */
    pending: RollbackBeat[];
    /** accepted + progress emitted so far, for late-joiner replay. */
    emitted: FleetCommandEventMessage[];
  } | null = null;

  /**
   * In-flight per-unit commands — SAFE SIT and RECALIBRATE JOINT — one per
   * unit (they are per-unit, so unlike the scanner they may run concurrently
   * across units). Insertion order is command order, which keeps drain order —
   * and therefore the stream — deterministic.
   *
   * ONE session per unit, not one per command, and that is a contract about
   * the robot rather than about the console: two maneuvers cannot run on one
   * body at once, so the refusals below make a concurrent second command
   * unrepresentable from this side. It no longer rests on the store's shape —
   * the console keys its commands by (unit, cmd) so it could
   * hold two lifecycles if the sim ever narrated them. The rule stands on the
   * physics.
   */
  type CommandBeat = {
    atTotalMs: number;
    msg: CommandEventMessage;
    /**
     * What the world does at this beat, on the road that fact always
     * travelled — the same doctrine Phase 11 wrote for fleet commands, where a
     * command narrates on its own lane and its consequences ride the per-unit
     * messages they already are.
     *
     * `settle`: posture flips to "sitting" and the unit restates itself.
     * `remeasure`: the calibrated joint is measured again and the new channel
     * goes out as a `diag_event`, because a channel is evidence and evidence
     * has one road on this wire.
     */
    consequence?: "settle" | "remeasure";
  };
  const commandSessions = new Map<
    string,
    {
      cmd: ExecutedCommand;
      /**
       * The slot the command was accepted at — the noise coordinate any
       * measurement it produces is drawn from, so the evidence is a property
       * of the press rather than of how finely the host advances the clock.
       */
      slot: number;
      /** Still-due beats, ascending by atTotalMs. */
      pending: CommandBeat[];
      /** accepted + progress emitted so far, for late-joiner replay. */
      emitted: CommandEventMessage[];
    }
  >();

  /**
   * What this run's scans flagged, unitId → the finding: the calibration target
   * and the kind of wrong it is.
   *
   * The anomaly rides along with the joint because it is what decides the
   * outcome (CALIBRATION_OUTCOME) — the sim's judgement of its own work is
   * keyed by what it diagnosed, not by which unit it happens to be.
   *
   * Written when the `flag` beat actually emits rather than when the schedule
   * is built, so the sim knows what it has *said*, not what it intends to say —
   * a RECALIBRATE arriving mid-scan is refused for being mid-scan, and one
   * arriving before any scan has nothing to aim at. Cleared wholesale by
   * RESET_SIM with the rest of the storyline.
   */
  const flaggedJoints = new Map<string, { joint: Joint; anomaly: AnomalyKind }>();

  /** Units whose flagged joint has been recalibrated this run. */
  const calibrated = new Set<string>();

  const incidentUnit = () => {
    const u = units.find((x) => x.id === INCIDENT_UNIT_ID);
    if (!u) throw new Error(`sim fleet is missing ${INCIDENT_UNIT_ID}`);
    return u;
  };

  const navUnit = () => {
    const u = units.find((x) => x.id === NAV_UNIT_ID);
    if (!u) throw new Error(`sim fleet is missing ${NAV_UNIT_ID}`);
    return u;
  };

  const offsetUnit = () => {
    const u = units.find((x) => x.id === OFFSET_UNIT_ID);
    if (!u) throw new Error(`sim fleet is missing ${OFFSET_UNIT_ID}`);
    return u;
  };

  /**
   * The scripted fault live on this unit right now, or null.
   *
   * Two faults, two liveness rules, and the difference is the physics rather
   * than the scheduling. The knee's fault DEVELOPS — before onset that joint is
   * genuinely healthy, so a scan run early correctly finds nothing. The ankle's
   * fault IS: the zero drifted before the run began, and it stops existing only
   * when someone re-zeroes it.
   */
  function activeFault(u: UnitState, storylineMs: number): ScriptedFault | null {
    if (u.id === INCIDENT_UNIT_ID && incidentSeverity(storylineMs) > 0) return KNEE_FAULT;
    if (u.id === OFFSET_UNIT_ID && !offsetCleared) return OFFSET_FAULT;
    return null;
  }

  /** 0 → calm; ramps to 1 at amber; 1 → 2 between amber and red; plateaus after. */
  function incidentSeverity(storylineMs: number): number {
    if (storylineMs < timeline.onsetMs) return 0;
    const a = clamp01(
      (storylineMs - timeline.onsetMs) / (timeline.amberAtMs - timeline.onsetMs),
    );
    const b = clamp01(
      (storylineMs - timeline.amberAtMs) / (timeline.redAtMs - timeline.amberAtMs),
    );
    return a + b;
  }

  /**
   * The walking-robot signal (gait, activity envelope, incident overlay) —
   * factored out so the seated thermal decay can evaluate "the temperature
   * this joint had at the instant the sit began" as a pure function.
   */
  function activeSample(
    u: UnitState,
    joint: Joint,
    storylineMs: number,
  ): { torque: number; temp: number } {
    const tSec = storylineMs / 1000;
    const slot = Math.round(storylineMs / interval);
    const jIdx = JOINTS.indexOf(joint);

    // walking around the house: slow walk/rest envelope in [0.15, 1]
    const activityRaw =
      (Math.sin((storylineMs / u.activityPeriodMs) * Math.PI * 2 + u.activityPhase) + 1) /
      2;
    const activity = 0.15 + 0.85 * activityRaw;

    const gait = Math.sin(
      2 * Math.PI * u.gaitFreqHz * tSec + u.gaitPhase + JOINT_PHASE[joint],
    );

    let torque =
      BASE_TORQUE[joint] * (0.35 + 0.65 * activity) +
      GAIT_AMP[joint] * activity * gait +
      0.4 * noise(seed, u.unitIndex, jIdx, slot, 0);

    let temp = clamp(
      u.baseTemp[joint] +
        1.6 * activity +
        0.8 * Math.sin(tSec / 47 + u.gaitPhase) +
        0.3 * noise(seed, u.unitIndex, jIdx, slot, 1),
      28,
      44,
    );

    // The second scripted fault: N-01's right ankle is held against a zero it
    // does not have. A standing torque bias and a couple of degrees for it —
    // constant, because a drifted encoder is a step and not a ramp. It rides
    // `activeSample` rather than `samplePoint` so the sit blend below fades it
    // out with everything else: an unloaded joint carries no standing torque,
    // whatever its encoder believes.
    if (u.id === OFFSET_UNIT_ID && joint === OFFSET_JOINT && !offsetCleared) {
      torque += OFFSET_TORQUE_BIAS;
      temp = clamp(temp + OFFSET_TEMP_RISE, 28, 44);
    }

    // the scripted incident: N-07 left knee climbs and ripples
    if (u.id === INCIDENT_UNIT_ID && joint === INCIDENT_JOINT) {
      const sev = incidentSeverity(storylineMs); // 0..2
      if (sev > 0) {
        temp = clamp(temp + 12 * Math.min(sev, 1) + 8 * Math.max(sev - 1, 0), 28, 58);
        const rippleAmp = 1.4 * Math.min(sev, 1) + 2.4 * Math.max(sev - 1, 0);
        torque +=
          rippleAmp * Math.sin(2 * Math.PI * 1.7 * tSec) +
          0.5 * sev * noise(seed, u.unitIndex, jIdx, slot, 2);
      }
    }

    return { torque, temp };
  }

  const smoothstep01 = (x: number) => x * x * (3 - 2 * x);

  /** 0 walking → 1 seated, smoothstepped across the sit ramp. */
  function sitFactor(u: UnitState, storylineMs: number): number {
    if (u.sitStartMs === null || storylineMs < u.sitStartMs) return 0;
    return smoothstep01(clamp01((storylineMs - u.sitStartMs) / sitTimeline.rampMs));
  }

  /**
   * 0 en route → 1 halted → 0 resumed: N-03's blocked-navigation window,
   * smoothstepped at both edges. Unlike a sit this window CLOSES — the unit
   * replans and walks on — and unlike a sit it never touches posture.
   */
  function navFactor(storylineMs: number): number {
    if (storylineMs < navTimeline.blockAtMs) return 0;
    const rise = smoothstep01(
      clamp01((storylineMs - navTimeline.blockAtMs) / NAV_RAMP_MS),
    );
    const fall = smoothstep01(
      clamp01((storylineMs - navTimeline.clearAtMs) / NAV_RAMP_MS),
    );
    return rise * (1 - fall);
  }

  function samplePoint(u: UnitState, joint: Joint, storylineMs: number): TelemetryPoint {
    const slot = Math.round(storylineMs / interval);
    const jIdx = JOINTS.indexOf(joint);
    const active = activeSample(u, joint, storylineMs);
    const sit = sitFactor(u, storylineMs);

    let torque = active.torque;
    let temp = active.temp;

    // SAFE SIT physics: the maneuver blends the walking signal into a seated
    // hold across the ramp. Torque collapses to a small hold residual (gait
    // ripple and the incident's fault ripple fade with it — an unloaded joint
    // is a quiet joint); temperature stops being generated at sit start and
    // decays exponentially toward the joint's resting base. Current derives
    // from torque below, so it drops with it. All of it stays a pure function
    // of (seed, unit, joint, slot, sitStartMs) — determinism holds.
    if (sit > 0 && u.sitStartMs !== null) {
      const residual = 0.12 + 0.05 * noise(seed, u.unitIndex, jIdx, slot, 4);
      torque = active.torque * (1 - sit) + residual * sit;

      const tempAtSit = activeSample(u, joint, u.sitStartMs).temp;
      const decayed =
        u.baseTemp[joint] +
        (tempAtSit - u.baseTemp[joint]) *
          Math.exp(-(storylineMs - u.sitStartMs) / SIT_TEMP_TAU_MS) +
        0.15 * noise(seed, u.unitIndex, jIdx, slot, 5);
      temp = active.temp * (1 - sit) + decayed * sit;
    }

    // Blocked-navigation halt: the sit-physics building blocks —
    // gait blended to a hold, generation stopped and temperature decaying on
    // SIT_TEMP_TAU_MS — with two differences. The hold is a STANDING hold
    // (posture never changes, and a robot standing on a blocked path carries
    // real static torque, not a seated residual), and the window closes: past
    // clearAtMs the factor ramps back down and the walking signal resumes. A
    // commanded sit outranks it — a seated robot is stationary already, so
    // the sit blend above owns the signal (the branches are exclusive). All
    // of it stays a pure function of (seed, unit, joint, slot): determinism
    // holds, and every unit but N-03 is untouched.
    if (u.id === NAV_UNIT_ID && u.sitStartMs === null) {
      const nav = navFactor(storylineMs);
      if (nav > 0) {
        const hold =
          0.5 * BASE_TORQUE[joint] + 0.15 * noise(seed, u.unitIndex, jIdx, slot, 6);
        torque = torque * (1 - nav) + hold * nav;

        const tempAtBlock = activeSample(u, joint, navTimeline.blockAtMs).temp;
        const settled =
          u.baseTemp[joint] +
          (tempAtBlock - u.baseTemp[joint]) *
            Math.exp(-(storylineMs - navTimeline.blockAtMs) / SIT_TEMP_TAU_MS) +
          0.15 * noise(seed, u.unitIndex, jIdx, slot, 7);
        temp = temp * (1 - nav) + settled * nav;
      }
    }

    const current =
      0.4 + 0.11 * Math.abs(torque) + 0.08 * noise(seed, u.unitIndex, jIdx, slot, 3);

    return {
      joint,
      tempC: round1(temp),
      torqueNm: round2(torque),
      currentA: round2(Math.max(0.05, current)),
      battery: round1(u.battery),
    };
  }

  function updateBattery(u: UnitState, storylineMs: number): void {
    u.battery = clamp(u.batteryStart - BATTERY_DRAIN_PER_MS * storylineMs, 3, 100);
  }

  /** Ids stay unique across RESET_SIM: the seq never resets. */
  const nextAlertId = () => `al-${String(++alertSeq).padStart(3, "0")}`;

  function makeAlert(severity: Alert["severity"], storylineMs: number): FleetMessage {
    const u = incidentUnit();
    const alert: Alert = {
      id: nextAlertId(),
      unitId: u.id,
      severity,
      message:
        severity === "amber"
          ? `${u.name}: left knee actuator trending hot, projected to overheat within 6 hours`
          : `${u.name}: left knee actuator overheating, torque ripple detected`,
      ts: startTimeMs + storylineStartMs + storylineMs,
    };
    const msg: AlertMessage = { t: "alert", alert };
    raisedAlerts.push(msg);
    return msg;
  }

  /** Alerts due in storyline window (prevMs, curMs]; also flips N-07's status. */
  function alertCrossings(prevMs: number, curMs: number): FleetMessage[] {
    const out: FleetMessage[] = [];
    if (prevMs < timeline.amberAtMs && curMs >= timeline.amberAtMs) {
      incidentUnit().status = "amber";
      out.push(makeAlert("amber", timeline.amberAtMs));
    }
    if (prevMs < timeline.redAtMs && curMs >= timeline.redAtMs) {
      incidentUnit().status = "red";
      out.push(makeAlert("red", timeline.redAtMs));
    }
    return out;
  }

  /**
   * N-03 storyline beats in (prevMs, curMs]. The raise is an
   * ordinary amber; the clear is `alert_clear` + a nominal `unit_update` — in
   * that order, the fact then the restatement, the same shape as a sit's
   * settle beat + unit_update. The cleared alert leaves the replay list:
   * `activeAlerts()` means ACTIVE, and a late joiner after the recovery gets
   * the current truth (nominal N-03, no alert), not a resolved ghost it never
   * saw raised. The clear guards on `navAlertId` so a degenerate timeline
   * (clear <= block) simply never clears what never raised.
   */
  function navCrossings(prevMs: number, curMs: number): FleetMessage[] {
    const out: FleetMessage[] = [];
    if (prevMs < navTimeline.blockAtMs && curMs >= navTimeline.blockAtMs) {
      const u = navUnit();
      u.status = "amber";
      const alert: Alert = {
        id: nextAlertId(),
        unitId: u.id,
        severity: "amber",
        message: `${u.name}: ${NAV_BLOCK_MESSAGE}`,
        ts: startTimeMs + storylineStartMs + navTimeline.blockAtMs,
      };
      const msg: AlertMessage = { t: "alert", alert };
      raisedAlerts.push(msg);
      navAlertId = alert.id;
      out.push(msg);
    }
    if (
      navAlertId !== null &&
      prevMs < navTimeline.clearAtMs &&
      curMs >= navTimeline.clearAtMs
    ) {
      const u = navUnit();
      u.status = "nominal";
      out.push({
        t: "alert_clear",
        alertId: navAlertId,
        unitId: u.id,
        via: "self-recovery",
        ts: startTimeMs + storylineStartMs + navTimeline.clearAtMs,
      });
      out.push({ t: "unit_update", unit: summarize(u) });
      raisedAlerts = raisedAlerts.filter((m) => m.alert.id !== navAlertId);
      navAlertId = null;
    }
    return out;
  }

  /**
   * N-01 storyline beat in (prevMs, curMs]: the unit's own monitor
   * finally trips on a bias it has carried all run.
   *
   * One beat and no clear — this alert does not resolve itself, which is the
   * whole difference between it and N-03's. Something has to *happen* to it,
   * and the something is one button. The guards say the two ways it can be
   * moot: the fault was already corrected before the detector got there, or an
   * amber is already standing (a degenerate compressed timeline crossing twice).
   */
  function offsetCrossings(prevMs: number, curMs: number): FleetMessage[] {
    if (offsetCleared || offsetAlertId !== null) return [];
    if (!(prevMs < offsetTimeline.alertAtMs && curMs >= offsetTimeline.alertAtMs)) {
      return [];
    }
    const u = offsetUnit();
    u.status = "amber";
    const alert: Alert = {
      id: nextAlertId(),
      unitId: u.id,
      severity: "amber",
      message: `${u.name}: ${OFFSET_ALERT_MESSAGE}`,
      ts: startTimeMs + storylineStartMs + offsetTimeline.alertAtMs,
    };
    const msg: AlertMessage = { t: "alert", alert };
    raisedAlerts.push(msg);
    offsetAlertId = alert.id;
    return [msg];
  }

  /**
   * What a *cleared* calibration does to the world beyond the channel it
   * re-measured.
   *
   * The consequences ride the roads they always did — `alert_clear` for the
   * lifecycle fact, `unit_update` for the status restatement, in that order,
   * the same shape N-03's self-recovery uses. `via: "recalibration"` names the
   * author the way "self-recovery" and "rollback" do: this alert was resolved
   * by an operator's command over the link, and the report's recovery ladder
   * reads that as remote operations — rung two, and no van.
   *
   * Latching the fault itself is the part that is easy to leave out and wrong
   * to. A console that cleared the alert while the sim kept emitting a
   * displaced channel would contradict itself on the next scan.
   */
  function resolveByCalibration(unitId: string, atTotalMs: number): FleetMessage[] {
    // Scoped to the one scripted fault a calibration can actually retire, and
    // scoped deliberately rather than written generically. "The fault is gone"
    // is three facts here — the latch, the alert, the status — and a version
    // that restated an arbitrary unit nominal outside the guard would, on some
    // future cleared act, hand a client a green robot with its own alert still
    // standing in the feed. The three move together or not at all.
    if (unitId !== OFFSET_UNIT_ID) return [];
    const u = units.find((x) => x.id === unitId);
    if (!u) return [];

    offsetCleared = true;
    const out: FleetMessage[] = [];
    if (offsetAlertId !== null) {
      out.push({
        t: "alert_clear",
        alertId: offsetAlertId,
        unitId: u.id,
        via: "recalibration",
        ts: startTimeMs + atTotalMs,
      });
      raisedAlerts = raisedAlerts.filter((m) => m.alert.id !== offsetAlertId);
      offsetAlertId = null;
    }
    // Guarded because the act is reachable before the detector ever trips: a
    // unit that was already nominal has nothing to restate, and a `unit_update`
    // saying so would be the sim announcing a change that did not happen.
    if (u.status !== "nominal") {
      u.status = "nominal";
      out.push({ t: "unit_update", unit: summarize(u) });
    }
    return out;
  }

  /** Raise one unit's cohort-signature amber (identical message across units — that IS the signature). */
  function raiseCohortAlert(u: UnitState, atStorylineMs: number): AlertMessage {
    u.status = "amber";
    const alert: Alert = {
      id: nextAlertId(),
      unitId: u.id,
      severity: "amber",
      message: COHORT_ALERT_MESSAGE,
      ts: startTimeMs + storylineStartMs + atStorylineMs,
    };
    const msg: AlertMessage = { t: "alert", alert };
    raisedAlerts.push(msg);
    cohortAlertIds.set(u.id, alert.id);
    return msg;
  }

  /**
   * Firmware-cohort beats in (prevMs, curMs]. Three kinds:
   *
   * - Each rollout unit raises the signature amber at onset + i·stagger —
   * guarded on the unit still RUNNING the rollout build, so a rollback that
   * outraces a raise (compressed timelines) leaves a restored unit silent.
   * - The queued install lands at pendingAtMs unless the rollout was halted
   * first: fw flips, fwPending clears, and a `unit_update` restates the
   * unit — firmware is snapshot-carried state, same rule as posture. The
   * halt path is the storyline's save: nothing here fires, and the receipt
   * is HALT_ROLLOUT's own narration.
   * - An installed queued build raises the same signature one stagger later:
   * halting AFTER the install does not un-install, so the save has a real
   * deadline. The `fw === FW_ROLLOUT` guard doubles as the rollback guard.
   */
  function cohortCrossings(prevMs: number, curMs: number): FleetMessage[] {
    const out: FleetMessage[] = [];
    ROLLOUT_UNIT_IDS.forEach((id, i) => {
      const at = cohortTimeline.onsetMs + i * cohortTimeline.staggerMs;
      if (prevMs < at && curMs >= at) {
        const u = units.find((x) => x.id === id);
        if (u && u.fw === FW_ROLLOUT && !cohortAlertIds.has(id)) {
          out.push(raiseCohortAlert(u, at));
        }
      }
    });

    if (prevMs < cohortTimeline.pendingAtMs && curMs >= cohortTimeline.pendingAtMs) {
      const u = units.find((x) => x.id === PENDING_UNIT_ID);
      if (u && !rolloutHalted && u.fwPending !== null) {
        u.fw = u.fwPending;
        u.fwPending = null;
        out.push({ t: "unit_update", unit: summarize(u) });
      }
    }

    const lateAt = cohortTimeline.pendingAtMs + cohortTimeline.staggerMs;
    if (prevMs < lateAt && curMs >= lateAt) {
      const u = units.find((x) => x.id === PENDING_UNIT_ID);
      if (u && u.fw === FW_ROLLOUT && !cohortAlertIds.has(u.id)) {
        out.push(raiseCohortAlert(u, lateAt));
      }
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // diagnostic scan choreography

  /**
   * The reference ("expected") trace for a joint: three gait cycles of a
   * two-harmonic waveform, phase-shifted per joint via JOINT_PHASE. Amplitude
   * 0.55 leaves headroom so the failing trace at 1.8x gain still fits -1..1.
   * Seed-independent on purpose: it plays the factory calibration table.
   */
  function refSample(joint: Joint, i: number): number {
    const theta = (2 * Math.PI * 3 * i) / CHANNEL_SAMPLES + JOINT_PHASE[joint];
    return 0.55 * (0.78 * Math.sin(theta) + 0.22 * Math.sin(2 * theta + 0.9));
  }

  /** Noise key-space tag so diag samples never collide with telemetry noise. */
  const DIAG_NOISE_TAG = 101;

  /**
   * One channel event's payload. Healthy: wave = ref x (1 ± 4 % gain jitter)
   * + 2 % additive noise — it visibly hugs the reference. Failing (knee_L on
   * the incident path): wave = ref x g(i) with g ramping FAULT_GAIN_START →
   * FAULT_GAIN_END across the window — phase-consistent, amplitude-wrong, so
   * the divergence reads as GAIN even to a non-engineer (the eva-brainwave
   * two-traces-overlaid look). Noise is keyed on (unit, joint, sample, scan
   * start slot): a given scan is byte-deterministic, and RESET_SIM + the same
   * command timing replays it exactly.
   */
  /**
   * One measured channel: the live trace against the calibration table it is
   * supposed to match.
   *
   * `fault` is how the joint is wrong — `null` for a healthy channel, which
   * sits on its reference inside jitter. Passing the fault rather than a
   * `failing` boolean is what lets a *re-measure* exist: a recalibrated joint
   * is neither healthy nor running the fault it was flagged for, and a boolean
   * can only say one of those two things.
   *
   * The two kinds are applied at different points of the same expression, and
   * that is the whole difference between them on screen. A gain fault
   * multiplies the reference, so the trace keeps its phase and loses its
   * envelope. An offset fault adds to it, so the trace keeps its envelope and
   * loses its datum. Same reference, same noise, two unmistakable silhouettes.
   */
  function buildChannel(
    u: UnitState,
    joint: Joint,
    scanSlot: number,
    fault: ChannelFault | null,
  ): { wave: number[]; ref: number[] } {
    const jIdx = JOINTS.indexOf(joint);
    const wave: number[] = [];
    const ref: number[] = [];
    for (let i = 0; i < CHANNEL_SAMPLES; i += 1) {
      const r = refSample(joint, i);
      const jitter = noise(seed, DIAG_NOISE_TAG + u.unitIndex, jIdx, 2 * i, scanSlot);
      const hiss = noise(seed, DIAG_NOISE_TAG + u.unitIndex, jIdx, 2 * i + 1, scanSlot);
      const gain =
        fault?.kind === "gain"
          ? fault.start + (fault.end - fault.start) * (i / (CHANNEL_SAMPLES - 1))
          : 1 + 0.04 * jitter;
      const bias = fault?.kind === "offset" ? fault.bias : 0;
      wave.push(round4(clamp(r * gain + bias + 0.02 * hiss, -1, 1)));
      ref.push(round4(r));
    }
    return { wave, ref };
  }

  /**
   * The re-measured channel a completed RECALIBRATE JOINT produces.
   *
   * Measured at the slot the command was ACCEPTED at, not at the slot it
   * happened to drain on. Both are deterministic given an identical call
   * pattern, but only the accept slot is a property of the operator's press —
   * so a host that advances in 250 ms steps and one that advances in 50 ms
   * steps hand the console the same evidence for the same maneuver.
   *
   * The outcome is the sim's own verdict on its own work, and it is read out of
   * CALIBRATION_OUTCOME by the anomaly the scan flagged — never by chance and
   * never by which unit this is. Both scripted acts press the same button and
   * get the answer their own diagnosis implies.
   */
  function buildRecalibration(unitId: string, slot: number): DiagEventMessage | null {
    const u = units.find((x) => x.id === unitId);
    const finding = flaggedJoints.get(unitId);
    if (!u || !finding) return null;
    const { outcome, residual } = CALIBRATION_OUTCOME[finding.anomaly];
    return {
      t: "diag_event",
      unitId,
      ev: {
        k: "recalibration",
        joint: finding.joint,
        ...buildChannel(u, finding.joint, slot, residual),
        outcome,
      },
    };
  }

  /** Every beat after scan_start, in beat order, stable-sorted by due time. */
  function buildDiagSchedule(
    u: UnitState,
    nowTotalMs: number,
    fault: ScriptedFault | null,
  ): Array<{ atTotalMs: number; msg: DiagEventMessage }> {
    const scanSlot = Math.round(nowTotalMs / interval);
    const at = (offsetMs: number) => nowTotalMs + offsetMs;
    const ev = (
      atTotalMs: number,
      e: DiagEventMessage["ev"],
    ): { atTotalMs: number; msg: DiagEventMessage } => ({
      atTotalMs,
      msg: { t: "diag_event", unitId: u.id, ev: e },
    });

    const beats: Array<{ atTotalMs: number; msg: DiagEventMessage }> = [];

    DIAG_WALK_PATHS.forEach((path, i) => {
      beats.push(
        ev(at(diagTimeline.walkStartMs + i * diagTimeline.walkStepMs), {
          k: "walk",
          path,
        }),
      );
    });

    JOINTS.forEach((joint, i) => {
      const channelAt = at(diagTimeline.channelStartMs + i * diagTimeline.channelStepMs);
      const failing = fault !== null && joint === fault.joint;
      beats.push(
        ev(channelAt, {
          k: "channel",
          joint,
          ...buildChannel(u, joint, scanSlot, failing ? fault.channel : null),
        }),
      );
      if (failing) {
        beats.push(
          ev(channelAt + diagTimeline.flagDelayMs, {
            k: "flag",
            joint: fault.joint,
            component: fault.component,
            anomaly: fault.anomaly,
          }),
        );
      }
    });

    const verdictAt = at(diagTimeline.verdictAtMs);
    const report: VerdictReport = fault
      ? {
          unitId: u.id,
          joint: fault.joint,
          component: fault.component,
          anomaly: fault.anomaly,
          summary: fault.summary,
          recommendations: [...fault.recommendations],
          ts: startTimeMs + verdictAt,
        }
      : {
          unitId: u.id,
          joint: "all",
          component: "all",
          anomaly: "none",
          summary: "SCAN COMPLETE. 6 CHANNELS WITHIN TOLERANCE. NO ANOMALY DETECTED.",
          recommendations: ["No action required"],
          ts: startTimeMs + verdictAt,
        };
    beats.push(ev(verdictAt, { k: "verdict", report }));

    // Stable sort: equal due times keep beat order (e.g. flagDelayMs: 0).
    return beats.sort((a, b) => a.atTotalMs - b.atTotalMs);
  }

  /** Emit every diag beat due by totalMs; the verdict ends the session. */
  function drainDiag(totalMs: number): FleetMessage[] {
    const out: FleetMessage[] = [];
    while (
      diagSession !== null &&
      diagSession.pending.length > 0 &&
      diagSession.pending[0]!.atTotalMs <= totalMs
    ) {
      const beat = diagSession.pending.shift()!;
      diagSession.emitted.push(beat.msg);
      out.push(beat.msg);
      // The calibration target is what the scan SAID, so it is recorded when
      // the flag emits rather than when the schedule was built.
      if (beat.msg.ev.k === "flag") {
        const { joint, anomaly } = beat.msg.ev;
        // The wire says `joint` is an identifier; the calibration target has to
        // be one of this robot's actual joints, and only the sim can say so.
        const known = JOINTS.find((j) => j === joint);
        if (known) flaggedJoints.set(diagSession.unitId, { joint: known, anomaly });
        // A fresh diagnosis retires the previous calibration: the joint has
        // been measured again and found wanting, so "CALIBRATION CURRENT" is
        // no longer a true thing to refuse a second attempt with.
        calibrated.delete(diagSession.unitId);
      }
      if (beat.msg.ev.k === "verdict") diagSession = null;
    }
    return out;
  }

  /**
   * Emit every per-unit command beat due by totalMs; a `complete` retires its
   * session. Two beats carry a consequence with them, each on the road that
   * fact always travelled:
   *
   * - the sit's settle beat emits a `unit_update` restating the unit's summary
   * — posture is snapshot-carried state, and a live client must not have to
   * reconnect to see it flip;
   * - the recalibration's `complete` emits a `diag_event` carrying the
   * re-measured channel, because a channel is evidence and the verdict card
   * reads evidence off the diag lane it already subscribes to.
   *
   * Neither consequence is added to `emitted`: late joiners read posture from
   * the greeting snapshot, and a recalibration that has already completed has
   * no lifetime left to replay.
   */
  function drainCommands(totalMs: number): FleetMessage[] {
    const out: FleetMessage[] = [];
    for (const [unitId, session] of commandSessions) {
      while (session.pending.length > 0 && session.pending[0]!.atTotalMs <= totalMs) {
        const beat = session.pending.shift()!;
        let settled: UnitState | undefined;
        if (beat.consequence === "settle") {
          settled = units.find((x) => x.id === unitId);
          if (settled) settled.posture = "sitting";
        }
        out.push(beat.msg);
        if (settled) out.push({ t: "unit_update", unit: summarize(settled) });
        if (beat.consequence === "remeasure") {
          const evidence = buildRecalibration(unitId, session.slot);
          if (evidence) {
            out.push(evidence);
            // A cleared calibration is the one maneuver in this sim that ends
            // an incident, so its consequences reach past the channel: the
            // fault is retired, the amber it raised is resolved, and the unit
            // restates itself nominal. Evidence first — the measurement is
            // what justifies the clear, and a receiver reading the stream in
            // order should see the reason before the conclusion.
            if (evidence.ev.k === "recalibration" && evidence.ev.outcome === "cleared") {
              out.push(...resolveByCalibration(unitId, beat.atTotalMs));
            }
          }
        }
        if (beat.msg.ev.k === "complete") {
          commandSessions.delete(unitId); // maneuver over: nothing left to replay
        } else {
          session.emitted.push(beat.msg);
        }
      }
    }
    return out;
  }

  /**
   * Emit every rollback beat due by totalMs; `complete` retires the session.
   * A "unitDone" beat is where the restoration actually happens — firmware
   * flips to the baseline, status returns to nominal — and its consequences go
   * out in a fixed order: the unit's summary restated via
   * `unit_update` (fw is snapshot-carried state), then its cohort alert
   * cleared via `alert_clear` (via "rollback"). The cleared alert leaves the
   * late-joiner replay list exactly like N-03's self-recovery: activeAlerts()
   * means ACTIVE. A unit whose cohort alert never raised (rolled back before
   * its stagger beat) restates without a clear — there is nothing to clear.
   */
  function drainRollback(totalMs: number): FleetMessage[] {
    const out: FleetMessage[] = [];
    while (
      rollbackSession !== null &&
      rollbackSession.pending.length > 0 &&
      rollbackSession.pending[0]!.atTotalMs <= totalMs
    ) {
      const beat = rollbackSession.pending.shift()!;
      switch (beat.kind) {
        case "note":
          rollbackSession.emitted.push(beat.msg);
          out.push(beat.msg);
          break;
        case "unitDone": {
          const u = units.find((x) => x.id === beat.unitId);
          if (!u) break;
          u.fw = rollbackSession.toFw;
          u.status = "nominal";
          out.push({ t: "unit_update", unit: summarize(u) });
          const alertId = cohortAlertIds.get(u.id);
          if (alertId !== undefined) {
            out.push({
              t: "alert_clear",
              alertId,
              unitId: u.id,
              via: "rollback",
              ts: startTimeMs + beat.atTotalMs,
            });
            raisedAlerts = raisedAlerts.filter((m) => m.alert.id !== alertId);
            cohortAlertIds.delete(u.id);
          }
          break;
        }
        case "complete":
          out.push(beat.msg);
          rollbackSession = null; // staged restoration over: nothing left to replay
          break;
      }
    }
    return out;
  }

  /** One unit's wire summary — the single mapping snapshot() and unit_update share. */
  function summarize(u: UnitState): UnitSummary {
    return {
      id: u.id,
      name: u.name,
      status: u.status,
      battery: round1(u.battery),
      pos: u.pos,
      posture: u.posture,
      fw: u.fw,
      // Omitted (not null) when nothing is queued: the field is additive and
      // absent everywhere except the still-pending install.
      ...(u.fwPending !== null ? { fwPending: u.fwPending } : {}),
    };
  }

  function snapshot(): FleetSnapshotMessage {
    return { t: "fleet_snapshot", units: units.map(summarize) };
  }

  function advance(totalMs: number): FleetMessage[] {
    const out: FleetMessage[] = [];
    const targetSlot = Math.floor(totalMs / interval);

    if (targetSlot > lastSlot) {
      let slot = lastSlot;
      if (targetSlot - slot > MAX_CATCHUP_SLOTS) {
        // Long gap: skip stale telemetry but honor any alert beats inside it.
        const skipTo = targetSlot - MAX_CATCHUP_SLOTS;
        const fromMs = slot * interval - storylineStartMs;
        const toMs = skipTo * interval - storylineStartMs;
        out.push(...alertCrossings(fromMs, toMs));
        out.push(...navCrossings(fromMs, toMs));
        out.push(...offsetCrossings(fromMs, toMs));
        out.push(...cohortCrossings(fromMs, toMs));
        slot = skipTo;
      }

      while (slot < targetSlot) {
        slot += 1;
        const slotTotalMs = slot * interval;
        const storylineMs = slotTotalMs - storylineStartMs;
        out.push(...alertCrossings(storylineMs - interval, storylineMs));
        out.push(...navCrossings(storylineMs - interval, storylineMs));
        out.push(...offsetCrossings(storylineMs - interval, storylineMs));
        out.push(...cohortCrossings(storylineMs - interval, storylineMs));
        for (const u of units) {
          updateBattery(u, storylineMs);
          out.push({
            t: "telemetry",
            unitId: u.id,
            ts: startTimeMs + slotTotalMs,
            batch: JOINTS.map((j) => samplePoint(u, j, storylineMs)),
          });
        }
      }

      lastSlot = targetSlot;
    }

    // Diag, sit, and rollback beats live off the slot grid: drain everything
    // due, even when this call advanced less than one batch interval. A long
    // catch-up gap never drops a beat — the whole backlog drains in order (the
    // sequence's integrity outranks its pacing). Within one advance() the
    // order is fixed — telemetry, diag beats, command beats (each settle beat
    // trailed by its unit_update), rollback beats (each restored unit's
    // unit_update + alert_clear) — so identical call patterns produce
    // identical streams.
    out.push(...drainDiag(totalMs));
    out.push(...drainCommands(totalMs));
    out.push(...drainRollback(totalMs));
    return out;
  }

  function handle(cmd: OperatorCommand): FleetMessage[] {
    switch (cmd.c) {
      case "RESET_SIM": {
        // Restart the storyline from the current instant: same seed, same
        // character, same beats — the demo replays identically. An in-flight
        // scan stops cleanly: pending beats vanish, replay state clears. Sits
        // are undone wholesale — postures return to walking with the fresh
        // units, pending sit beats vanish (commandSeq keeps counting so seqs
        // stay unique across resets, like alert ids). The rollout program
        // resets with the fleet: the initial firmware distribution returns
        // (initUnits reassigns it), the halt lifts, a mid-flight rollback's
        // pending beats vanish, and the queued install is scheduled again.
        units = initUnits(seed, unitCount);
        storylineStartMs = lastSlot * interval;
        raisedAlerts = [];
        navAlertId = null; // the N-03 storyline replays with the rest
        // …and so does N-01's: the encoder is drifted again, the amber is
        // pending again, and the second ending is available again. A latch that
        // survived a reset would leave the demo re-runnable in one act only.
        offsetAlertId = null;
        offsetCleared = false;
        diagSession = null;
        commandSessions.clear();
        flaggedJoints.clear();
        calibrated.clear();
        rolloutHalted = false;
        rollbackSession = null;
        cohortAlertIds.clear();
        return [snapshot()];
      }
      case "COMMAND_SAFE_SIT": {
        // Contract: every well-targeted COMMAND_SAFE_SIT is answered
        // synchronously with exactly one `accepted` or `failed` — a command
        // never dies silently.
        const u = units.find((x) => x.id === cmd.unitId);
        if (!u) return []; // valid-shaped but unknown unit: nothing to command

        const nowTotalMs = lastSlot * interval;
        const ev = (
          atTotalMs: number,
          e: CommandEventMessage["ev"],
        ): CommandEventMessage => ({
          t: "command_event",
          unitId: u.id,
          cmd: "COMMAND_SAFE_SIT",
          seq: ++commandSeq,
          ts: startTimeMs + atTotalMs,
          ev: e,
        });
        const refuse = (reason: string): FleetMessage[] => [
          ev(nowTotalMs, { k: "failed", reason }),
        ];

        // Refusals, most specific first. A refusal consumes seqs but no state.
        // A recalibration in flight also refuses here — it holds this unit's
        // one command slot, and it is running *because* the unit is seated, so
        // ALREADY SITTING is the honest reason either way.
        if (commandSessions.get(u.id)?.cmd === "COMMAND_SAFE_SIT")
          return refuse(SIT_REFUSAL_SIT_IN_PROGRESS);
        if (u.posture === "sitting") return refuse(SIT_REFUSAL_ALREADY_SITTING);
        if (diagSession !== null && diagSession.unitId === u.id) {
          // Sitting mid-scan would invalidate the channels being captured.
          // (A scan on some OTHER unit does not block this one's sit.)
          return refuse(SIT_REFUSAL_SCAN_IN_PROGRESS);
        }

        // Accepted: the physics start NOW (sitFactor ramps from this instant);
        // the narration beats follow on the engine clock. seq order matters —
        // accepted lowest, then beats ascending — because the store treats seq
        // as the ordering authority.
        u.sitStartMs = nowTotalMs - storylineStartMs;
        const accepted = ev(nowTotalMs, { k: "accepted" });
        const pending: CommandBeat[] = SIT_PROGRESS_BEATS.map((b) => {
          const at = nowTotalMs + Math.round(sitTimeline.rampMs * b.frac);
          return {
            atTotalMs: at,
            msg: ev(at, { k: "progress", pct: b.pct, note: b.note }),
            ...(b.frac === 1 ? { consequence: "settle" as const } : {}),
          };
        });
        const completeAt = nowTotalMs + sitTimeline.completeAtMs;
        pending.push({
          atTotalMs: completeAt,
          msg: ev(completeAt, { k: "complete" }),
        });
        commandSessions.set(u.id, {
          cmd: "COMMAND_SAFE_SIT",
          slot: lastSlot,
          pending,
          emitted: [accepted],
        });
        return [accepted];
      }
      case "RECALIBRATE_JOINT": {
        // The second command the sim executes, and the cheapest rung on the
        // recovery ladder the incident report files actions against. Same
        // contract as SAFE SIT: exactly one `accepted` or `failed`, always
        // synchronous.
        const u = units.find((x) => x.id === cmd.unitId);
        if (!u) return [];

        const nowTotalMs = lastSlot * interval;
        const ev = (
          atTotalMs: number,
          e: CommandEventMessage["ev"],
        ): CommandEventMessage => ({
          t: "command_event",
          unitId: u.id,
          cmd: "RECALIBRATE_JOINT",
          seq: ++commandSeq,
          ts: startTimeMs + atTotalMs,
          ev: e,
        });
        const refuse = (reason: string): FleetMessage[] => [
          ev(nowTotalMs, { k: "failed", reason }),
        ];

        // Refusals, most specific first — "what is happening right now" before
        // "what this unit is", before "whether there is anything to do".
        const running = commandSessions.get(u.id);
        if (running?.cmd === "RECALIBRATE_JOINT")
          return refuse(RECAL_REFUSAL_IN_PROGRESS);
        if (running) return refuse(RECAL_REFUSAL_SIT_IN_PROGRESS);
        // The physical precondition, enforced here and not only in the UI: an
        // unloaded sweep on a load-bearing joint is unloaded because the robot
        // is sitting on the floor, not because the console said so.
        if (u.posture !== "sitting") return refuse(RECAL_REFUSAL_NOT_SEATED);
        if (diagSession !== null && diagSession.unitId === u.id) {
          // Same reason a sit is refused mid-scan: moving the joint being
          // measured invalidates the channels the scan is capturing.
          return refuse(RECAL_REFUSAL_SCAN_IN_PROGRESS);
        }
        if (calibrated.has(u.id)) return refuse(RECAL_REFUSAL_CURRENT);
        // Nothing this run's scans flagged on this unit: there is no joint to
        // aim at, and the sim does not pick one.
        if (!flaggedJoints.has(u.id)) return refuse(RECAL_REFUSAL_NO_TARGET);

        // Accepted. The calibration is recorded now rather than at complete:
        // the gain table is being rewritten from this instant, so a second
        // command arriving mid-sweep is refused for the sweep, and one
        // arriving after it is refused for the table.
        calibrated.add(u.id);
        const accepted = ev(nowTotalMs, { k: "accepted" });
        const pending: CommandBeat[] = RECAL_PROGRESS_BEATS.map((b) => {
          const at = nowTotalMs + Math.round(recalTimeline.sweepMs * b.frac);
          return {
            atTotalMs: at,
            msg: ev(at, { k: "progress", pct: b.pct, note: b.note }),
          };
        });
        const recalCompleteAt = nowTotalMs + recalTimeline.completeAtMs;
        pending.push({
          atTotalMs: recalCompleteAt,
          msg: ev(recalCompleteAt, { k: "complete" }),
          // The verification pass fills the gap between the last sweep beat
          // and this one, and this is where its result goes out.
          consequence: "remeasure",
        });
        commandSessions.set(u.id, {
          cmd: "RECALIBRATE_JOINT",
          slot: lastSlot,
          pending,
          emitted: [accepted],
        });
        return [accepted];
      }
      case "HALT_ROLLOUT": {
        // Fleet-scoped and fully synchronous: halting is bookkeeping — cancel
        // what has not installed yet. Contract mirrors SAFE SIT's: exactly one
        // `accepted` or `failed` answers the command; here the whole lifecycle
        // is synchronous, so accepted, the receipt narration, the queued
        // unit's restatement, and complete all ride the command's broadcast.
        // Nothing pends, so HALT_ROLLOUT is never replayed to late joiners —
        // its durable receipts are the snapshot (no more fwPending) and the
        // client-side audit line built from the note below.
        const nowTotalMs = lastSlot * interval;
        const fleetEv = (e: CommandEventMessage["ev"]): FleetCommandEventMessage => ({
          t: "fleet_command_event",
          cmd: "HALT_ROLLOUT",
          fw: FW_ROLLOUT,
          seq: ++commandSeq,
          ts: startTimeMs + nowTotalMs,
          ev: e,
        });

        // Nothing left to halt: already halted (a rollback implies the halt
        // too), or every queued install already landed. A refusal consumes
        // seqs but no state, like SAFE SIT's.
        if (rolloutHalted || !units.some((x) => x.fwPending !== null)) {
          return [fleetEv({ k: "failed", reason: ROLLOUT_REFUSAL_NO_ROLLOUT_ACTIVE })];
        }

        // The save: the queued install is canceled BEFORE it lands. The
        // demonstrable non-event — fw stays the baseline — is stated three
        // ways: the machine-voice receipt note (the audit line's text), the
        // unit_update dropping `fwPending`, and every later snapshot.
        rolloutHalted = true;
        const out: FleetMessage[] = [fleetEv({ k: "accepted" })];
        for (const u of units) {
          if (u.fwPending === null) continue;
          u.fwPending = null;
          out.push(
            fleetEv({
              k: "progress",
              pct: 100,
              note: `ROLLOUT HALTED — ${u.id} REMAINS ON ${u.fw}`,
            }),
          );
          out.push({ t: "unit_update", unit: summarize(u) });
        }
        out.push(fleetEv({ k: "complete" }));
        return out;
      }
      case "ROLLBACK_COHORT": {
        // Fleet-scoped, staged, strictly serial: the units running cmd.fw are
        // restored to the baseline one at a time, ~rollbackPerUnitMs each, in
        // roster order — deterministic, like everything else here. Accepted
        // answers synchronously (with the first unit's narration — its window
        // starts NOW); each unit's window closes with its restoration
        // (unit_update, then its cohort alert's alert_clear); complete lands
        // when the last unit's does.
        const nowTotalMs = lastSlot * interval;
        const fleetEv = (
          atTotalMs: number,
          e: CommandEventMessage["ev"],
        ): FleetCommandEventMessage => ({
          t: "fleet_command_event",
          cmd: "ROLLBACK_COHORT",
          fw: cmd.fw,
          seq: ++commandSeq,
          ts: startTimeMs + atTotalMs,
          ev: e,
        });

        // One staged rollback at a time: the rollout program is one resource.
        if (rollbackSession !== null) {
          return [
            fleetEv(nowTotalMs, {
              k: "failed",
              reason: ROLLOUT_REFUSAL_ROLLBACK_IN_PROGRESS,
            }),
          ];
        }
        // No unit runs cmd.fw, or cmd.fw IS the baseline (nowhere lower to
        // go): like a well-formed SAFE SIT for a unit not in the fleet, there
        // is nothing to command — ignored, not refused.
        const targets = units.filter((x) => x.fw === cmd.fw);
        if (cmd.fw === FW_STABLE || targets.length === 0) return [];

        const out: FleetMessage[] = [fleetEv(nowTotalMs, { k: "accepted" })];

        // Rolling a build back implies halting its rollout: a still-queued
        // install of cmd.fw is canceled here (visible as the unit_update
        // dropping fwPending), and rolloutHalted flips so a later
        // HALT_ROLLOUT answers NO ROLLOUT ACTIVE truthfully.
        rolloutHalted = true;
        for (const u of units) {
          if (u.fwPending === cmd.fw) {
            u.fwPending = null;
            out.push({ t: "unit_update", unit: summarize(u) });
          }
        }

        // Build every beat up front in emission order — seqs are assigned
        // here, so the fleet lane's seqs ascend exactly as the events emit.
        // The consequences ("unitDone") are applied at drain time instead:
        // the firmware flip must happen at the beat, not at accept.
        const per = cohortTimeline.rollbackPerUnitMs;
        const pending: RollbackBeat[] = [];
        targets.forEach((u, i) => {
          const startAt = nowTotalMs + i * per;
          pending.push({
            atTotalMs: startAt,
            kind: "note",
            msg: fleetEv(startAt, {
              k: "progress",
              pct: Math.round((100 * i) / targets.length),
              note: `ROLLING BACK ${u.id} ${cmd.fw}->${FW_STABLE}`,
            }),
          });
          pending.push({ atTotalMs: startAt + per, kind: "unitDone", unitId: u.id });
        });
        const completeAt = nowTotalMs + per * targets.length;
        pending.push({
          atTotalMs: completeAt,
          kind: "complete",
          msg: fleetEv(completeAt, { k: "complete" }),
        });

        rollbackSession = { fromFw: cmd.fw, toFw: FW_STABLE, pending, emitted: [] };
        // The accepted lifecycle starts replaying to late joiners from here.
        rollbackSession.emitted.push(out[0] as FleetCommandEventMessage);
        // The first unit's window opens NOW: drain its narration (and, with a
        // fully compressed rollbackPerUnitMs, anything else already due) into
        // the same synchronous answer.
        out.push(...drainRollback(nowTotalMs));
        return out;
      }
      case "RUN_DIAGNOSTIC": {
        // One scan at a time: a repeat command mid-scan (same unit or not) is
        // ignored — the UI's "Run diagnostic" double-click does nothing rude.
        if (diagSession !== null) return [];
        const u = units.find((x) => x.id === cmd.unitId);
        if (!u) return []; // valid-shaped but unknown unit: nothing to scan

        // "Now" is the engine's clock, not the wall: the last advanced slot.
        const nowTotalMs = lastSlot * interval;
        const storylineMs = nowTotalMs - storylineStartMs;
        // Whichever scripted fault is live on this unit right now; every other
        // unit — and N-07 before onset, and N-01 after a successful re-zero —
        // gets a clean all-pass scan.
        const fault = activeFault(u, storylineMs);

        const scanStart: DiagEventMessage = {
          t: "diag_event",
          unitId: u.id,
          ev: { k: "scan_start" },
        };
        diagSession = {
          unitId: u.id,
          pending: buildDiagSchedule(u, nowTotalMs, fault),
          emitted: [scanStart],
        };
        return [scanStart]; // scan_start goes out with the command's broadcast
      }
    }
  }

  return {
    snapshot,
    activeAlerts: () => [...raisedAlerts],
    activeDiagEvents: () => (diagSession ? [...diagSession.emitted] : []),
    activeCommandEvents: () => {
      const out: CommandEventMessage[] = [];
      for (const session of commandSessions.values()) out.push(...session.emitted);
      return out;
    },
    activeFleetCommandEvents: () => (rollbackSession ? [...rollbackSession.emitted] : []),
    advance,
    handle,
  };
}
