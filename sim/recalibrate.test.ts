// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  fleetMessageSchema,
  type CommandEventMessage,
  type DiagEventMessage,
  type FleetMessage,
} from "@/lib/schema";
import { channelTone, gainRatio, rmsDelta } from "@/components/machine/waveform-math";
import {
  createSimEngine,
  DEFAULT_DIAG_TIMELINE,
  DEFAULT_OFFSET_TIMELINE,
  DEFAULT_RECAL_TIMELINE,
  INCIDENT_JOINT,
  INCIDENT_UNIT_ID,
  OFFSET_ALERT_MESSAGE,
  OFFSET_BIAS,
  OFFSET_COMPONENT,
  OFFSET_JOINT,
  OFFSET_UNIT_ID,
  type OffsetTimeline,
  RECAL_PROGRESS_BEATS,
  RECAL_REFUSAL_CURRENT,
  RECAL_REFUSAL_IN_PROGRESS,
  RECAL_REFUSAL_NO_TARGET,
  RECAL_REFUSAL_NOT_SEATED,
  RECAL_REFUSAL_SCAN_IN_PROGRESS,
  RECAL_REFUSAL_SIT_IN_PROGRESS,
  type RecalTimeline,
  type SimEngine,
  type SitTimeline,
} from "./engine";

/**
 * RECALIBRATE JOINT is a real command.
 *
 * The contract this file pins is the one the demo's whole escalation argument
 * rests on — the cheap rung is tried, it is worth something, and it is not
 * worth enough. Concretely: the sim refuses an unloaded sweep on a robot that
 * is not unloaded, it narrates the sweep in its own words, and the channel it
 * hands back afterwards lands in a specific band. If that band ever moves, the
 * verdict card stops being able to say "improved, not fixed" — so it is a
 * contract here rather than a number in a component.
 */

const FAST = { onsetMs: 1000, amberAtMs: 1500, redAtMs: 2000 };
const FAST_SIT: SitTimeline = { rampMs: 1000, completeAtMs: 2000 };
/** Sweep beats at +100/+225/+350/+500, complete at +1000 — all on the 50 ms step. */
const FAST_RECAL: RecalTimeline = { sweepMs: 500, completeAtMs: 1000 };
const STEP_MS = 50;

const isCommandEvent = (m: FleetMessage): m is CommandEventMessage =>
  m.t === "command_event";
const isDiagEvent = (m: FleetMessage): m is DiagEventMessage => m.t === "diag_event";

function drain(engine: SimEngine, fromMs: number, toMs: number): FleetMessage[] {
  const out: FleetMessage[] = [];
  for (let t = fromMs + STEP_MS; t <= toMs; t += STEP_MS) out.push(...engine.advance(t));
  return out;
}

const engineAt = () =>
  createSimEngine({ timeline: FAST, sitTimeline: FAST_SIT, recalTimeline: FAST_RECAL });

/**
 * The demo's own sequence, compressed: let the incident ripen, scan N-07 to the
 * verdict (which is what flags the joint), then sit it down. Returns the clock.
 */
function toSeatedVerdict(engine: SimEngine): number {
  let now = 0;
  now = 2500;
  drain(engine, 0, now);
  engine.handle({ c: "RUN_DIAGNOSTIC", unitId: INCIDENT_UNIT_ID });
  const scanEnd = now + DEFAULT_DIAG_TIMELINE.verdictAtMs + 500;
  drain(engine, now, scanEnd);
  now = scanEnd;
  engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
  const sitEnd = now + FAST_SIT.completeAtMs + 500;
  drain(engine, now, sitEnd);
  return sitEnd;
}

/** The scan's own measurement of the failing joint, for before/after work. */
function scanChannel(): { wave: number[]; ref: number[] } {
  const e = createSimEngine({ timeline: FAST, sitTimeline: FAST_SIT });
  drain(e, 0, 2500);
  e.handle({ c: "RUN_DIAGNOSTIC", unitId: INCIDENT_UNIT_ID });
  const msgs = drain(e, 2500, 2500 + DEFAULT_DIAG_TIMELINE.verdictAtMs + 500);
  for (const m of msgs) {
    if (m.t === "diag_event" && m.ev.k === "channel" && m.ev.joint === INCIDENT_JOINT)
      return { wave: m.ev.wave, ref: m.ev.ref };
  }
  throw new Error("the scan never measured the failing joint");
}

describe("RECALIBRATE JOINT — execution beats", () => {
  it("has demo pacing by default: a sweep, then a verification pass", () => {
    expect(DEFAULT_RECAL_TIMELINE.sweepMs).toBe(2500);
    expect(DEFAULT_RECAL_TIMELINE.completeAtMs).toBe(4500);
    // The gap between them IS the re-measure. Collapse it and `complete` would
    // be announcing a result the machine had not taken yet.
    expect(DEFAULT_RECAL_TIMELINE.completeAtMs).toBeGreaterThan(
      DEFAULT_RECAL_TIMELINE.sweepMs,
    );
  });

  it("answers synchronously, then narrates the sweep in its own words", () => {
    const engine = engineAt();
    const now = toSeatedVerdict(engine);

    const answer = engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID });
    expect(answer).toHaveLength(1);
    expect(answer[0]).toMatchObject({
      t: "command_event",
      cmd: "RECALIBRATE_JOINT",
      ev: { k: "accepted" },
    });

    const beats = drain(engine, now, now + FAST_RECAL.completeAtMs + 200)
      .filter(isCommandEvent)
      .filter((m) => m.cmd === "RECALIBRATE_JOINT");

    expect(beats.map((m) => m.ev.k)).toEqual([
      ...RECAL_PROGRESS_BEATS.map(() => "progress"),
      "complete",
    ]);
    expect(beats.flatMap((m) => (m.ev.k === "progress" ? [m.ev.note] : []))).toEqual(
      RECAL_PROGRESS_BEATS.map((b) => b.note),
    );
    // seqs strictly increase: the store treats seq as the ordering authority.
    const seqs = [answer[0] as CommandEventMessage, ...beats].map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    for (const m of beats) expect(fleetMessageSchema.safeParse(m).success).toBe(true);
  });

  it("hands back a re-measured channel on the diag lane, not inside the receipt", () => {
    const engine = engineAt();
    const now = toSeatedVerdict(engine);
    engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID });

    const msgs = drain(engine, now, now + FAST_RECAL.completeAtMs + 200);
    const evidence = msgs
      .filter(isDiagEvent)
      .filter((m) => m.ev.k === "recalibration");
    expect(evidence).toHaveLength(1);
    const ev = evidence[0]!.ev;
    if (ev.k !== "recalibration") throw new Error("unreachable");
    expect(ev.joint).toBe(INCIDENT_JOINT);
    expect(ev.wave).toHaveLength(ev.ref.length);

    // It lands with the completion, not before it: a result announced ahead of
    // the beat that produced it is the console running ahead of the robot.
    const order = msgs.filter(
      (m) =>
        (m.t === "command_event" && m.ev.k === "complete") ||
        (m.t === "diag_event" && m.ev.k === "recalibration"),
    );
    expect(order.map((m) => m.t)).toEqual(["command_event", "diag_event"]);
  });
});

describe("RECALIBRATE JOINT — the outcome is a property of the fault", () => {
  it("improves the channel out of alert and leaves it short of healthy", () => {
    const before = scanChannel();
    const engine = engineAt();
    const now = toSeatedVerdict(engine);
    engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID });
    const after = drain(engine, now, now + FAST_RECAL.completeAtMs + 200)
      .filter(isDiagEvent)
      .map((m) => m.ev)
      .find((ev) => ev.k === "recalibration");
    if (after?.k !== "recalibration") throw new Error("no re-measure arrived");

    const preRms = rmsDelta(before.wave, before.ref);
    const postRms = rmsDelta(after.wave, after.ref);
    const preGain = gainRatio(before.wave, before.ref);
    const postGain = gainRatio(after.wave, after.ref);

    // The whole argument, in four assertions: it got better…
    expect(postRms).toBeLessThan(preRms);
    expect(postGain).toBeLessThan(preGain);
    // …it stopped being a failing channel…
    expect(channelTone(preRms)).toBe("alert");
    expect(channelTone(postRms)).toBe("warn");
    // …and it did not become a healthy one. A calibration rewrites a gain
    // table; tendon wear is not in the gain table.
    expect(channelTone(postRms)).not.toBe("nominal");
    expect(after.outcome).toBe("partial");
  });

  it("puts the residual in the band the verdict card's copy is written for", () => {
    const engine = engineAt();
    const now = toSeatedVerdict(engine);
    engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID });
    const after = drain(engine, now, now + FAST_RECAL.completeAtMs + 200)
      .filter(isDiagEvent)
      .map((m) => m.ev)
      .find((ev) => ev.k === "recalibration");
    if (after?.k !== "recalibration") throw new Error("no re-measure arrived");

    // "RESIDUAL 1.3x REFERENCE" is a sentence the card prints from this number.
    expect(gainRatio(after.wave, after.ref)).toBeGreaterThan(1.2);
    expect(gainRatio(after.wave, after.ref)).toBeLessThan(1.5);
  });
});

describe("RECALIBRATE JOINT — refusals (terse machine voice, printed verbatim)", () => {
  const refusal = (msgs: FleetMessage[]): string | null => {
    const m = msgs.filter(isCommandEvent).at(0);
    return m && m.ev.k === "failed" ? m.ev.reason : null;
  };

  it("refuses a robot that is standing on the joint", () => {
    const engine = engineAt();
    drain(engine, 0, 2500);
    engine.handle({ c: "RUN_DIAGNOSTIC", unitId: INCIDENT_UNIT_ID });
    drain(engine, 2500, 2500 + DEFAULT_DIAG_TIMELINE.verdictAtMs + 500);

    expect(
      refusal(engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID })),
    ).toBe(RECAL_REFUSAL_NOT_SEATED);
  });

  it("refuses while the sit that would seat it is still running", () => {
    const engine = engineAt();
    drain(engine, 0, 2500);
    engine.handle({ c: "RUN_DIAGNOSTIC", unitId: INCIDENT_UNIT_ID });
    const scanEnd = 2500 + DEFAULT_DIAG_TIMELINE.verdictAtMs + 500;
    drain(engine, 2500, scanEnd);
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    // Past the settle beat (posture is "sitting") but inside the command.
    drain(engine, scanEnd, scanEnd + FAST_SIT.rampMs + STEP_MS);

    expect(
      refusal(engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID })),
    ).toBe(RECAL_REFUSAL_SIT_IN_PROGRESS);
  });

  it("refuses a second sweep while one is running, and a third afterwards", () => {
    const engine = engineAt();
    const now = toSeatedVerdict(engine);
    engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID });
    drain(engine, now, now + FAST_RECAL.sweepMs);

    expect(
      refusal(engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID })),
    ).toBe(RECAL_REFUSAL_IN_PROGRESS);

    drain(engine, now + FAST_RECAL.sweepMs, now + FAST_RECAL.completeAtMs + 200);
    expect(
      refusal(engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID })),
    ).toBe(RECAL_REFUSAL_CURRENT);
  });

  it("refuses mid-scan: moving the joint invalidates the channels being captured", () => {
    const engine = engineAt();
    const now = toSeatedVerdict(engine);
    engine.handle({ c: "RUN_DIAGNOSTIC", unitId: INCIDENT_UNIT_ID });
    drain(engine, now, now + DEFAULT_DIAG_TIMELINE.channelStartMs);

    expect(
      refusal(engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID })),
    ).toBe(RECAL_REFUSAL_SCAN_IN_PROGRESS);
  });

  it("refuses a unit no scan has flagged, however seated it is", () => {
    const engine = engineAt();
    drain(engine, 0, 2500);
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: "N-01" });
    drain(engine, 2500, 2500 + FAST_SIT.completeAtMs + 200);

    expect(refusal(engine.handle({ c: "RECALIBRATE_JOINT", unitId: "N-01" }))).toBe(
      RECAL_REFUSAL_NO_TARGET,
    );
  });

  it("says nothing at all about a unit that does not exist", () => {
    const engine = engineAt();
    expect(engine.handle({ c: "RECALIBRATE_JOINT", unitId: "N-99" })).toEqual([]);
  });

  it("refuses a SAFE SIT while a sweep is running, rather than sitting a seated robot", () => {
    const engine = engineAt();
    const now = toSeatedVerdict(engine);
    engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID });
    drain(engine, now, now + FAST_RECAL.sweepMs);

    const answer = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    const m = answer.filter(isCommandEvent).at(0);
    expect(m?.ev.k).toBe("failed");
  });
});

describe("RECALIBRATE JOINT — replay, reset, determinism", () => {
  it("replays an in-flight sweep to a late joiner, and nothing once it is over", () => {
    const engine = engineAt();
    const now = toSeatedVerdict(engine);
    engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID });
    drain(engine, now, now + FAST_RECAL.sweepMs);

    const replay = engine.activeCommandEvents();
    expect(replay.length).toBeGreaterThan(0);
    expect(replay.every((m) => m.cmd === "RECALIBRATE_JOINT")).toBe(true);
    expect(replay[0]!.ev.k).toBe("accepted");

    drain(engine, now + FAST_RECAL.sweepMs, now + FAST_RECAL.completeAtMs + 200);
    // A finished maneuver has no lifetime left to replay.
    expect(engine.activeCommandEvents()).toEqual([]);
  });

  it("RESET_SIM retires the calibration with the storyline", () => {
    const engine = engineAt();
    const now = toSeatedVerdict(engine);
    engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID });
    drain(engine, now, now + FAST_RECAL.completeAtMs + 200);

    engine.handle({ c: "RESET_SIM" });
    // The flagged joint went with it: there is nothing to recalibrate until a
    // scan flags one again, which is the honest state of a fresh run.
    const after = engine
      .handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID })
      .filter(isCommandEvent)
      .at(0);
    expect(after?.ev.k).toBe("failed");
    if (after?.ev.k === "failed") expect(after.ev.reason).toBe(RECAL_REFUSAL_NOT_SEATED);
  });

  it("is a pure function of the seed and the call pattern", () => {
    const run = () => {
      const engine = engineAt();
      const now = toSeatedVerdict(engine);
      engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID });
      return JSON.stringify(drain(engine, now, now + FAST_RECAL.completeAtMs + 200));
    };
    expect(run()).toBe(run());
  });

  it("measures at the accept instant, so drain granularity cannot change the evidence", () => {
    const measure = (stepMs: number): string => {
      const engine = engineAt();
      const now = toSeatedVerdict(engine);
      engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID });
      const out: FleetMessage[] = [];
      for (let t = now + stepMs; t <= now + FAST_RECAL.completeAtMs + 200; t += stepMs)
        out.push(...engine.advance(t));
      const ev = out
        .filter(isDiagEvent)
        .map((m) => m.ev)
        .find((e) => e.k === "recalibration");
      if (ev?.k !== "recalibration") throw new Error("no re-measure arrived");
      return JSON.stringify(ev.wave);
    };
    // A host advancing in 50 ms steps and one advancing in 200 ms steps hand
    // the console the same evidence for the same press.
    expect(measure(50)).toBe(measure(200));
  });
});

/**
 * the second ending — the same button, a different diagnosis, and a
 * rung of the ladder the demo never got to show working.
 *
 * The knee's contract above is "improved, not fixed", and this file's other
 * half is "fixed", which only means something because both are keyed by the
 * anomaly rather than by chance. What is pinned here is the whole consequence
 * chain a cleared calibration sets off: the channel comes back inside the
 * envelope, the amber the fleet raised is resolved with the right author on it,
 * the unit restates itself nominal — and the fault stops existing, so a second
 * scan finds a clean robot rather than the console contradicting itself.
 */

/** Amber early enough to be inside a compressed test run. */
const FAST_OFFSET: OffsetTimeline = { alertAtMs: 1500 };

const offsetEngine = () =>
  createSimEngine({
    timeline: FAST,
    sitTimeline: FAST_SIT,
    recalTimeline: FAST_RECAL,
    offsetTimeline: FAST_OFFSET,
  });

/** Ripen the amber, scan N-01 to its verdict, sit it down. Returns the clock. */
function toSeatedOffsetVerdict(engine: SimEngine): { now: number; msgs: FleetMessage[] } {
  const msgs: FleetMessage[] = [];
  msgs.push(...drain(engine, 0, 2500));
  msgs.push(...engine.handle({ c: "RUN_DIAGNOSTIC", unitId: OFFSET_UNIT_ID }));
  const scanEnd = 2500 + DEFAULT_DIAG_TIMELINE.verdictAtMs + 500;
  msgs.push(...drain(engine, 2500, scanEnd));
  msgs.push(...engine.handle({ c: "COMMAND_SAFE_SIT", unitId: OFFSET_UNIT_ID }));
  const sitEnd = scanEnd + FAST_SIT.completeAtMs + 500;
  msgs.push(...drain(engine, scanEnd, sitEnd));
  return { now: sitEnd, msgs };
}

describe("N-01 encoder offset — the fault, and how it reads", () => {
  it("displaces the flagged channel without touching its envelope", () => {
    const engine = offsetEngine();
    drain(engine, 0, 1000);
    engine.handle({ c: "RUN_DIAGNOSTIC", unitId: OFFSET_UNIT_ID });
    const channels = drain(engine, 1000, 1000 + DEFAULT_DIAG_TIMELINE.verdictAtMs + 500)
      .filter(isDiagEvent)
      .map((m) => m.ev)
      .filter((ev) => ev.k === "channel");
    expect(channels).toHaveLength(6);

    const subject = channels.find((c) => c.joint === OFFSET_JOINT);
    if (!subject) throw new Error("the scan never measured the flagged joint");

    // A displacement, measured as one: for a pure DC bias the RMS deviation IS
    // the bias, so this number and OFFSET_BIAS are the same fact.
    expect(rmsDelta(subject.wave, subject.ref)).toBeCloseTo(OFFSET_BIAS, 2);
    expect(channelTone(rmsDelta(subject.wave, subject.ref))).toBe("alert");
    // …and the envelope survives it. A gain fault would put this well past
    // 1.3x; the amplitude ratio barely moves, which is exactly the reading the
    // report refuses to state an offset in.
    expect(gainRatio(subject.wave, subject.ref)).toBeLessThan(1.25);

    // Every other channel is clean. One fault, one unit, one joint.
    for (const c of channels) {
      if (c.joint === OFFSET_JOINT) continue;
      expect(channelTone(rmsDelta(c.wave, c.ref))).toBe("nominal");
    }
  });

  it("flags and concludes an offset anomaly, cheapest-first and without a disable", () => {
    const engine = offsetEngine();
    drain(engine, 0, 1000);
    engine.handle({ c: "RUN_DIAGNOSTIC", unitId: OFFSET_UNIT_ID });
    const evs = drain(engine, 1000, 1000 + DEFAULT_DIAG_TIMELINE.verdictAtMs + 500)
      .filter(isDiagEvent)
      .map((m) => m.ev);

    const flag = evs.find((ev) => ev.k === "flag");
    expect(flag).toEqual({
      k: "flag",
      joint: OFFSET_JOINT,
      component: OFFSET_COMPONENT,
      anomaly: "offset",
    });

    const verdict = evs.find((ev) => ev.k === "verdict");
    if (verdict?.k !== "verdict") throw new Error("no verdict arrived");
    expect(verdict.report.anomaly).toBe("offset");
    expect(verdict.report.joint).toBe(OFFSET_JOINT);
    // The machine's own words carry the differentiating half of the finding.
    expect(verdict.report.summary).toContain("ENVELOPE INTACT");
    // Calibration first, and no DISABLE JOINT: a joint that carries load
    // perfectly well and merely believes it is somewhere else is not a joint to
    // take out of service.
    expect(verdict.report.recommendations[0]).toBe("Recalibrate joint");
    expect(verdict.report.recommendations).not.toContain("Disable joint");
    // Dispatch still closes the list. The act is that it is never pressed.
    expect(verdict.report.recommendations).toContain("Dispatch service");
  });

  it("raises one amber and never escalates it", () => {
    const engine = offsetEngine();
    const alerts = drain(engine, 0, 6000).filter(
      (m) => m.t === "alert" && m.alert.unitId === OFFSET_UNIT_ID,
    );
    expect(alerts).toHaveLength(1);
    const raised = alerts[0];
    if (raised?.t !== "alert") throw new Error("no amber arrived");
    expect(raised.alert.severity).toBe("amber");
    expect(raised.alert.message).toContain(OFFSET_ALERT_MESSAGE);
    // Prefixed with the home's name like every per-unit alert — the cohort
    // signature is the one deliberate exception, and this is not it.
    expect(raised.alert.message.startsWith(OFFSET_ALERT_MESSAGE)).toBe(false);
    expect(raised.alert.ts).toBe(FAST_OFFSET.alertAtMs);
  });

  it("keeps the demo-true beat clear of every other storyline", () => {
    // The knee window, N-03's replan, and the whole rollout act all finish
    // before this one opens. If a default ever moves, this is the assertion
    // that says the acts have started overlapping.
    expect(DEFAULT_OFFSET_TIMELINE.alertAtMs).toBeGreaterThan(300_000);
  });
});

describe("N-01 encoder offset — recalibrating actually fixes it", () => {
  it("returns the channel to reference and says so", () => {
    const engine = offsetEngine();
    const { now, msgs } = toSeatedOffsetVerdict(engine);
    const before = msgs
      .filter(isDiagEvent)
      .map((m) => m.ev)
      .find((ev) => ev.k === "channel" && ev.joint === OFFSET_JOINT);
    if (before?.k !== "channel") throw new Error("no subject channel");

    engine.handle({ c: "RECALIBRATE_JOINT", unitId: OFFSET_UNIT_ID });
    const after = drain(engine, now, now + FAST_RECAL.completeAtMs + 200)
      .filter(isDiagEvent)
      .map((m) => m.ev)
      .find((ev) => ev.k === "recalibration");
    if (after?.k !== "recalibration") throw new Error("no re-measure arrived");

    expect(after.outcome).toBe("cleared");
    expect(after.joint).toBe(OFFSET_JOINT);
    // The counterpart of the knee's band, and the contrast the two acts are
    // for: alert -> warn there, alert -> nominal here. Re-zeroing an encoder
    // does not leave a smaller offset behind, so the channel that comes back is
    // indistinguishable from one that was never wrong.
    expect(channelTone(rmsDelta(before.wave, before.ref))).toBe("alert");
    expect(channelTone(rmsDelta(after.wave, before.ref))).toBe("nominal");
  });

  it("clears the alert it was raised for, crediting the operator's command", () => {
    const engine = offsetEngine();
    const { now, msgs } = toSeatedOffsetVerdict(engine);
    const raised = msgs.find((m) => m.t === "alert" && m.alert.unitId === OFFSET_UNIT_ID);
    if (raised?.t !== "alert") throw new Error("the amber never raised");
    expect(engine.activeAlerts().map((m) => m.alert.id)).toContain(raised.alert.id);

    engine.handle({ c: "RECALIBRATE_JOINT", unitId: OFFSET_UNIT_ID });
    const out = drain(engine, now, now + FAST_RECAL.completeAtMs + 200);

    const cleared = out.find((m) => m.t === "alert_clear");
    if (cleared?.t !== "alert_clear") throw new Error("the amber never cleared");
    expect(cleared.alertId).toBe(raised.alert.id);
    expect(cleared.unitId).toBe(OFFSET_UNIT_ID);
    // Not "self-recovery": a person pressed a button. The report reads this
    // value as remote operations — rung two, and no van.
    expect(cleared.via).toBe("recalibration");

    // The unit restates itself nominal, and the resolved alert leaves the
    // late-joiner replay list: activeAlerts() means ACTIVE.
    const restated = out.filter(
      (m) => m.t === "unit_update" && m.unit.id === OFFSET_UNIT_ID,
    );
    expect(restated.at(-1)).toMatchObject({ unit: { status: "nominal" } });
    expect(engine.activeAlerts().map((m) => m.alert.id)).not.toContain(raised.alert.id);

    // Evidence before conclusion: a receiver reading the stream in order sees
    // the measurement that justifies the clear before the clear.
    const iEvidence = out.findIndex(
      (m) => m.t === "diag_event" && m.ev.k === "recalibration",
    );
    const iClear = out.findIndex((m) => m.t === "alert_clear");
    expect(iEvidence).toBeGreaterThanOrEqual(0);
    expect(iEvidence).toBeLessThan(iClear);
  });

  it("retires the fault itself, so a second scan finds a clean robot", () => {
    const engine = offsetEngine();
    const { now } = toSeatedOffsetVerdict(engine);
    engine.handle({ c: "RECALIBRATE_JOINT", unitId: OFFSET_UNIT_ID });
    const settled = now + FAST_RECAL.completeAtMs + 200;
    drain(engine, now, settled);

    engine.handle({ c: "RUN_DIAGNOSTIC", unitId: OFFSET_UNIT_ID });
    const evs = drain(engine, settled, settled + DEFAULT_DIAG_TIMELINE.verdictAtMs + 500)
      .filter(isDiagEvent)
      .map((m) => m.ev);

    expect(evs.some((ev) => ev.k === "flag")).toBe(false);
    const verdict = evs.find((ev) => ev.k === "verdict");
    if (verdict?.k !== "verdict") throw new Error("no verdict arrived");
    expect(verdict.report.anomaly).toBe("none");
    for (const c of evs.filter((ev) => ev.k === "channel")) {
      expect(channelTone(rmsDelta(c.wave, c.ref))).toBe("nominal");
    }
  });

  it("never raises an amber for a fault that was corrected before the detector tripped", () => {
    // The operator who scans N-01 out of curiosity and fixes it at 0:10 must
    // not be told at 0:15 that the robot has the problem they just removed.
    const engine = createSimEngine({
      timeline: FAST,
      sitTimeline: FAST_SIT,
      recalTimeline: FAST_RECAL,
      offsetTimeline: { alertAtMs: 60_000 },
    });
    const { now } = toSeatedOffsetVerdict(engine);
    engine.handle({ c: "RECALIBRATE_JOINT", unitId: OFFSET_UNIT_ID });
    const out = drain(engine, now, 70_000);
    expect(out.some((m) => m.t === "alert" && m.alert.unitId === OFFSET_UNIT_ID)).toBe(
      false,
    );
  });

  it("replays both acts identically after RESET_SIM", () => {
    const run = (): string => {
      const engine = offsetEngine();
      const { now } = toSeatedOffsetVerdict(engine);
      engine.handle({ c: "RECALIBRATE_JOINT", unitId: OFFSET_UNIT_ID });
      const settled = now + FAST_RECAL.completeAtMs + 200;
      drain(engine, now, settled);
      // The latch must not survive the reset, or the demo is re-runnable in one
      // act only: the encoder is drifted again and the amber is pending again.
      engine.handle({ c: "RESET_SIM" });
      const out = drain(engine, settled, settled + 6000);
      return JSON.stringify(
        out.filter((m) => m.t === "alert" || m.t === "alert_clear"),
      );
    };
    const first = run();
    expect(first).toBe(run());
    expect(first).toContain(OFFSET_ALERT_MESSAGE);
  });

  it("stays deterministic and schema-valid across the whole act", () => {
    const stream = (): string => {
      const engine = offsetEngine();
      const { now, msgs } = toSeatedOffsetVerdict(engine);
      engine.handle({ c: "RECALIBRATE_JOINT", unitId: OFFSET_UNIT_ID });
      const out = [...msgs, ...drain(engine, now, now + FAST_RECAL.completeAtMs + 200)];
      for (const m of out) expect(fleetMessageSchema.safeParse(m).success).toBe(true);
      return JSON.stringify(out.filter((m) => m.t !== "telemetry"));
    };
    expect(stream()).toBe(stream());
  });

  it("leaves the knee act partial, from the same table and the same button", () => {
    const engine = offsetEngine();
    const now = toSeatedVerdict(engine);
    engine.handle({ c: "RECALIBRATE_JOINT", unitId: INCIDENT_UNIT_ID });
    const out = drain(engine, now, now + FAST_RECAL.completeAtMs + 200);
    const after = out
      .filter(isDiagEvent)
      .map((m) => m.ev)
      .find((ev) => ev.k === "recalibration");
    if (after?.k !== "recalibration") throw new Error("no re-measure arrived");
    expect(after.outcome).toBe("partial");
    // …and a partial outcome resolves nothing. The knee's alerts stand, which
    // is what makes DISPATCH SERVICE the next step rather than the third button.
    expect(out.some((m) => m.t === "alert_clear")).toBe(false);
    expect(
      engine.activeAlerts().some((m) => m.alert.unitId === INCIDENT_UNIT_ID),
    ).toBe(true);
  });
});
