import * as z from "zod/mini";

/**
 * The message contract (PRD §4). Shared verbatim by the app and the simulator:
 * the sim constructs these shapes, every transport zod-validates every inbound
 * message against them, and the stores reduce them. This file is the single
 * source of truth — no parallel hand-written types anywhere.
 *
 * `zod/mini`, not classic zod, and the choice is a perf receipt: this module
 * is in the fleet page's initial JS (the transports parse on the main thread),
 * and classic zod 4 ships ~66 KB gz of method-chained API the contract never
 * uses. The functional mini API tree-shakes to the validators actually named
 * below, with the identical core: same parse semantics, same issue shapes,
 * same inference. (One deliberate no-op: zod 4's `z.number()` already rejects
 * NaN and ±Infinity, so no explicit finite check is needed anywhere.)
 *
 * Timestamps are epoch milliseconds. The sim engine runs on an injected clock
 * and offsets by a configurable start epoch, so tests can pin ts to sim-time.
 */

/**
 * Unit ids are "N-" + two or three digits. The core fleet is N-01…N-08; the
 * SIM_UNITS scale knob generates N-009…N-500 style three-digit ids beyond the
 * core eight.
 */
export const unitIdSchema = z
  .string()
  .check(z.regex(/^N-\d{2,3}$/, "unit id must match N-XX or N-XXX"));

/** Battery state of charge, percent (0–100). */
export const batteryPctSchema = z.number().check(z.minimum(0), z.maximum(100));

/**
 * Firmware version, plain three-part semver ("2.3.7"). Additive:
 * firmware is fleet-management state (the rollout-cohort storyline groups and
 * rolls back units by it), so it rides the unit summary like posture does.
 */
export const fwVersionSchema = z
  .string()
  .check(z.regex(/^\d+\.\d+\.\d+$/, "fw must be MAJOR.MINOR.PATCH"));

/** A required, non-empty string — the contract's plain workhorse. */
const nonEmpty = z.string().check(z.minLength(1));

/**
 * One telemetry sample for one joint. A 10 Hz batch carries one point per
 * joint per emission, so `battery` (a unit-level value) repeats across the
 * points of a batch — the contract keeps the point self-describing.
 */
export const telemetryPointSchema = z.object({
  joint: nonEmpty,
  tempC: z.number(),
  torqueNm: z.number(),
  currentA: z.number(),
  battery: batteryPctSchema,
});
export type TelemetryPoint = z.infer<typeof telemetryPointSchema>;

export const unitStatusSchema = z.enum(["nominal", "amber", "red"]);
export type UnitStatus = z.infer<typeof unitStatusSchema>;

/**
 * Gross body posture. Optional (additive): this sim always emits it,
 * but consumers must treat `undefined` as "walking" so pre-posture snapshots
 * stay valid. SAFE SIT flips it to "sitting" — restated live by a
 * `unit_update` at the settle beat — and RESET_SIM's snapshot restores
 * "walking".
 */
export const postureSchema = z.enum(["walking", "sitting"]);
export type Posture = z.infer<typeof postureSchema>;

/** What the fleet map / rail need to render a unit before telemetry arrives. */
export const unitSummarySchema = z.object({
  id: unitIdSchema,
  name: nonEmpty,
  status: unitStatusSchema,
  battery: batteryPctSchema,
  pos: z.object({
    lat: z.number().check(z.minimum(-90), z.maximum(90)),
    lng: z.number().check(z.minimum(-180), z.maximum(180)),
  }),
  posture: z.optional(postureSchema),
  /**
   * Installed firmware (additive). This sim always emits it;
   * consumers must treat `undefined` as "unknown" so pre-firmware snapshots
   * stay valid. Restated live by `unit_update` when it changes (the pending
   * unit's scheduled upgrade landing; a staged rollback restoring a unit).
   */
  fw: z.optional(fwVersionSchema),
  /**
   * A scheduled-but-not-installed upgrade (additive). Present only
   * while the rollout program has this unit queued: `fw` stays the running
   * version, `fwPending` names what is about to install. HALT_ROLLOUT clears
   * it without installing (the demo's visible save); the upgrade landing
   * moves the value into `fw` and drops this field. Absent everywhere else.
   */
  fwPending: z.optional(fwVersionSchema),
});
export type UnitSummary = z.infer<typeof unitSummarySchema>;

export const alertSeveritySchema = z.enum(["amber", "red"]);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

export const alertSchema = z.object({
  id: nonEmpty,
  unitId: unitIdSchema,
  severity: alertSeveritySchema,
  message: nonEmpty,
  ts: z.number(),
});
export type Alert = z.infer<typeof alertSchema>;

/** The diagnosis the scan ends on: one component, one anomaly, actions to take. */
export const verdictReportSchema = z.object({
  unitId: unitIdSchema,
  joint: nonEmpty,
  component: nonEmpty,
  anomaly: nonEmpty,
  summary: nonEmpty,
  recommendations: z.array(nonEmpty).check(z.minLength(1)),
  ts: z.number(),
});
export type VerdictReport = z.infer<typeof verdictReportSchema>;

/**
 * What kind of wrong a flagged channel is — the field the console's tables are
 * keyed by, and the only part of a `flag` that carries behaviour.
 *
 * Closed, and additive: it was the literal "gain" while one incident was
 * scripted, and adds the second. The two are genuinely different
 * failures rather than two names for one — a `gain` channel has the right shape
 * at the wrong amplitude (a control-gain fault, correctable only in the part a
 * gain table can reach); an `offset` channel has the right shape at the wrong
 * datum (an encoder zero that has drifted, which a calibration re-zeroes
 * outright). Three tables downstream key on this value — the scan's
 * differential, the report's, and the sim's own judgement of what a
 * recalibration is worth — so a receiver that met an unknown kind would render
 * a finding with no medicine attached. Better to reject it at the transport.
 *
 * `joint` and `component` widen to plain identifiers alongside it, matching
 * `verdictReportSchema`, which has always carried them that way: the flag and
 * the verdict describe one finding, and a shape that let them disagree about
 * what a joint name is would be two contracts for one fact.
 */
export const anomalyKindSchema = z.enum(["gain", "offset"]);
export type AnomalyKind = z.infer<typeof anomalyKindSchema>;

/**
 * Scan choreography events (PRD §4). A scan flags at most one channel, and
 * `flag` names it: where, which part, and what kind of wrong.
 */
export const diagEventSchema = z.discriminatedUnion("k", [
  z.object({ k: z.literal("scan_start") }),
  z.object({ k: z.literal("walk"), path: nonEmpty }),
  z.object({
    k: z.literal("channel"),
    joint: nonEmpty,
    wave: z.array(z.number()),
    ref: z.array(z.number()),
  }),
  z.object({
    k: z.literal("flag"),
    joint: nonEmpty,
    component: nonEmpty,
    anomaly: anomalyKindSchema,
  }),
  z.object({ k: z.literal("verdict"), report: verdictReportSchema }),
  /**
   * The re-measured channel after a RECALIBRATE_JOINT completes.
   *
   * It travels on `diag_event` rather than inside the command's `complete`
   * beat because it is *evidence*, and evidence has one road on this wire. The
   * doctrine is the one fleet commands established: a command narrates
   * itself on its own lane, and its per-unit consequences ride the per-unit
   * messages they always did. A recalibration's consequence is a channel, so
   * it arrives as a channel — the verdict card redraws the exhibit it already
   * had rather than learning to read waveforms out of a receipt.
   *
   * `outcome` is the sim's judgement of its own work — did the correction
   * clear the fault — and it is the only judgement here. The *residual* is
   * deliberately not a field: the console already computes gain and RMS from
   * wave-vs-ref with one shared function (components/machine/waveform-math.ts,
   * whose whole reason for existing is that three surfaces must not disagree
   * about whether a channel is healthy), so a residual on the wire would be a
   * second number obliged to agree with the one under the trace. The wire
   * carries the measurement; the console measures it.
   *
   * `cleared` is produced by no scripted incident today is the act
   * that adds one — and is in the schema because the outcome of a calibration
   * is a two-valued fact, and a receiver that could only represent "partial"
   * would have to be edited before it could believe a robot got better.
   */
  z.object({
    k: z.literal("recalibration"),
    joint: nonEmpty,
    wave: z.array(z.number()),
    ref: z.array(z.number()),
    outcome: z.enum(["partial", "cleared"]),
  }),
]);
export type DiagEvent = z.infer<typeof diagEventSchema>;

/**
 * Commands the sim *executes* (as opposed to RUN_DIAGNOSTIC's own diag_event
 * choreography and RESET_SIM's snapshot). Every executed command is narrated
 * on the wire by command_events carrying this name.
 */
export const executedCommandSchema = z.enum(["COMMAND_SAFE_SIT", "RECALIBRATE_JOINT"]);
export type ExecutedCommand = z.infer<typeof executedCommandSchema>;

/**
 * Fleet-scoped commands the sim executes (additive) — commands whose
 * subject is the rollout program, not one unit. Narrated on the wire by
 * `fleet_command_event`s carrying this name; per-unit consequences travel on
 * the per-unit messages they always have (`unit_update`, `alert_clear`).
 */
export const fleetCommandSchema = z.enum(["HALT_ROLLOUT", "ROLLBACK_COHORT"]);
export type FleetCommand = z.infer<typeof fleetCommandSchema>;

/**
 * Execution beats of one command. Exactly one `accepted` or
 * `failed` answers the command synchronously; an accepted command then streams
 * `progress` beats and ends in exactly one `complete`. `failed.reason` and
 * `progress.note` are terse machine-voice strings the UI prints verbatim.
 */
export const commandEventSchema = z.discriminatedUnion("k", [
  z.object({ k: z.literal("accepted") }),
  z.object({
    k: z.literal("progress"),
    pct: z.number().check(z.minimum(0), z.maximum(100)),
    note: nonEmpty,
  }),
  z.object({ k: z.literal("complete") }),
  z.object({ k: z.literal("failed"), reason: nonEmpty }),
]);
export type CommandEvent = z.infer<typeof commandEventSchema>;

/** Everything the sim can say to the console. */
export const fleetMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("fleet_snapshot"), units: z.array(unitSummarySchema) }),
  /**
   * Live restatement of ONE unit's summary (additive). Emitted when
   * unit state changes between snapshots — today the SAFE SIT settle beat,
   * where posture flips to "sitting" — so a connected client never has to
   * reconnect to learn it. Deliberately per-unit: at 500 units a full
   * re-snapshot is ~64 KB; this is one summary. Idempotent by content — a
   * receiver holding an identical summary treats it as a no-op.
   */
  z.object({ t: z.literal("unit_update"), unit: unitSummarySchema }),
  z.object({
    t: z.literal("telemetry"),
    unitId: unitIdSchema,
    ts: z.number(),
    batch: z.array(telemetryPointSchema).check(z.minLength(1)),
  }),
  z.object({ t: z.literal("alert"), alert: alertSchema }),
  /**
   * An alert the SIM resolved (additive) — the N-03 blocked-navigation
   * storyline clearing itself, and a staged rollback clearing each
   * restored unit's cohort alert. Resolution is normally an operator fact
   * recorded client-side (there is no RESOLVE command on the wire); this
   * message is the case where the *sim* is the author, and the console records
   * it the way it records an operator's resolution (`resolveAlert(via)`). The
   * unit's status restatement travels separately as the `unit_update` around
   * it — this message carries the lifecycle fact, not unit state.
   *
   * `via` names the author — the enum the literal was documented to
   * widen into, and the three values are three rungs of the recovery ladder the
   * incident report is written in:
   *
   * - "self-recovery": the unit cleared its own blockage, nobody acted.
   * - "rollback": ROLLBACK_COHORT restored the unit's firmware and the fault
   * went with it.
   * - "recalibration": an operator's RECALIBRATE_JOINT re-zeroed the
   * flagged channel and the fault it was raised for stopped existing. The
   * author is a person, at a console, over the link — which is exactly why it
   * is not "self-recovery", and exactly why the report files it one rung up.
   */
  z.object({
    t: z.literal("alert_clear"),
    /** Which alert resolved — an id this run previously raised. */
    alertId: nonEmpty,
    unitId: unitIdSchema,
    via: z.enum(["self-recovery", "rollback", "recalibration"]),
    ts: z.number(),
  }),
  z.object({ t: z.literal("diag_event"), unitId: unitIdSchema, ev: diagEventSchema }),
  z.object({
    t: z.literal("command_event"),
    unitId: unitIdSchema,
    cmd: executedCommandSchema,
    /**
     * Strictly increasing per engine run (never reset, like alert ids), so a
     * receiver can order command_events without trusting arrival order: the
     * store drops any event whose seq is <= the last one applied for the unit.
     */
    seq: z.int().check(z.positive()),
    ts: z.number(),
    ev: commandEventSchema,
  }),
  /**
   * Execution beats of one FLEET-scoped command (additive) —
   * HALT_ROLLOUT and ROLLBACK_COHORT, whose subject is the rollout program
   * rather than a unit. Deliberately its own message, not a unitId-less
   * `command_event`: per-unit command ordering keys on unitId, and a fleet
   * command is one lifecycle in one scope, so it gets ONE ordering lane of its
   * own (see lib/transport/orderingGate.ts). `ev` reuses the per-unit beat
   * grammar verbatim — accepted/progress/complete/failed, notes and reasons in
   * machine voice, printed verbatim — and `seq` draws from the same
   * engine-monotonic counter as `command_event`, so seqs stay globally unique
   * and strictly increasing within the fleet lane. Per-unit consequences of a
   * fleet command (a firmware restatement, an alert clearing) travel as the
   * per-unit messages they already are: `unit_update` and `alert_clear`.
   */
  z.object({
    t: z.literal("fleet_command_event"),
    cmd: fleetCommandSchema,
    /** The firmware the command concerns (the halted rollout's target; the rolled-back cohort's version). */
    fw: z.optional(fwVersionSchema),
    seq: z.int().check(z.positive()),
    ts: z.number(),
    ev: commandEventSchema,
  }),
]);
export type FleetMessage = z.infer<typeof fleetMessageSchema>;

export type FleetSnapshotMessage = Extract<FleetMessage, { t: "fleet_snapshot" }>;
export type UnitUpdateMessage = Extract<FleetMessage, { t: "unit_update" }>;
export type TelemetryMessage = Extract<FleetMessage, { t: "telemetry" }>;
export type AlertMessage = Extract<FleetMessage, { t: "alert" }>;
export type AlertClearMessage = Extract<FleetMessage, { t: "alert_clear" }>;
export type DiagEventMessage = Extract<FleetMessage, { t: "diag_event" }>;
export type CommandEventMessage = Extract<FleetMessage, { t: "command_event" }>;
export type FleetCommandEventMessage = Extract<
  FleetMessage,
  { t: "fleet_command_event" }
>;

/** Everything the console can say to the sim. */
/** The storyline's addressable chapters; the engine resolves each to a beat. */
export const storylineChapterSchema = z.enum(["knee", "nav", "cohort", "offset"]);
export type StorylineChapterName = z.infer<typeof storylineChapterSchema>;

export const operatorCommandSchema = z.discriminatedUnion("c", [
  z.object({ c: z.literal("RUN_DIAGNOSTIC"), unitId: unitIdSchema }),
  z.object({ c: z.literal("COMMAND_SAFE_SIT"), unitId: unitIdSchema }),
  /**
   * Drive the flagged joint through an unloaded calibration sweep:
   * the cheapest rung on the recovery ladder, and the one the verdict prints
   * first. Unloaded is not a description, it is the precondition — the sim
   * refuses this unless the unit is already seated, which is what makes
   * COMMAND_SAFE_SIT the step before it rather than the step beside it.
   *
   * No joint on the wire: the target is the joint the scan flagged, and a
   * console that named one could ask the sim to recalibrate something the
   * diagnosis never implicated.
   */
  z.object({ c: z.literal("RECALIBRATE_JOINT"), unitId: unitIdSchema }),
  /**
   * Stop the firmware rollout program: scheduled upgrades are
   * canceled before they install — already-upgraded units are NOT touched
   * (that is ROLLBACK_COHORT's job). Fleet-scoped: no unitId.
   */
  z.object({ c: z.literal("HALT_ROLLOUT") }),
  /**
   * Roll every unit running `fw` back to the known-good baseline, strictly one
   * unit at a time. Fleet-scoped: the cohort is named by firmware,
   * not by unit ids — the operator acts on the blast radius, not on a robot.
   */
  z.object({ c: z.literal("ROLLBACK_COHORT"), fw: fwVersionSchema }),
  z.object({ c: z.literal("RESET_SIM") }),
  /**
   * Replay the storyline from the top and stop just short of one chapter, so
   * the fleet is in the state that chapter opens on and its first alert is
   * still seconds away.
   *
   * A chapter, not a timestamp: the timelines are configurable per build, so
   * the moment named "the firmware cohort" is 180 s in the shipped sim and
   * parked past the horizon in the e2e one. The console names the story and
   * the engine owns the clock — the same division that keeps a joint off
   * RECALIBRATE_JOINT.
   */
  z.object({ c: z.literal("SEEK_STORYLINE"), chapter: storylineChapterSchema }),
]);
export type OperatorCommand = z.infer<typeof operatorCommandSchema>;
