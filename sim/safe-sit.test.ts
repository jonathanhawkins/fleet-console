// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  fleetMessageSchema,
  type CommandEventMessage,
  type FleetMessage,
  type TelemetryMessage,
  type UnitUpdateMessage,
} from "@/lib/schema";
import {
  createSimEngine,
  DEFAULT_SIT_TIMELINE,
  INCIDENT_JOINT,
  INCIDENT_UNIT_ID,
  SIT_PROGRESS_BEATS,
  SIT_REFUSAL_ALREADY_SITTING,
  SIT_REFUSAL_SCAN_IN_PROGRESS,
  SIT_REFUSAL_SIT_IN_PROGRESS,
  type SimEngine,
  type SitTimeline,
} from "./engine";

/**
 * (b): SAFE SIT actually executes. Beats on the engine clock,
 * telemetry physics that read in a sparkline (torque → ~0, ripple ceases,
 * knee temp decays, currents drop), posture in snapshots and restated live by
 * the settle beat's unit_update, machine-voice refusals, RESET
 * restoration, late-joiner replay, determinism.
 */

/** Incident beats compressed: onset 1 s, amber 1.5 s, red 2 s. */
const FAST = { onsetMs: 1000, amberAtMs: 1500, redAtMs: 2000 };

/** Sit compressed 2x, every beat a multiple of the 50 ms step: progress at +250/+500/+750/+1000, complete at +2000. */
const FAST_SIT: SitTimeline = { rampMs: 1000, completeAtMs: 2000 };
const STEP_MS = 50;

const isCommandEvent = (m: FleetMessage): m is CommandEventMessage =>
  m.t === "command_event";
const isTelemetry = (m: FleetMessage): m is TelemetryMessage => m.t === "telemetry";

interface Arrival {
  t: number;
  msg: FleetMessage;
}

function stepDrain(
  engine: SimEngine,
  fromMs: number,
  toMs: number,
  stepMs = STEP_MS,
): Arrival[] {
  const arrivals: Arrival[] = [];
  for (let t = fromMs + stepMs; t <= toMs; t += stepMs) {
    for (const msg of engine.advance(t)) arrivals.push({ t, msg });
  }
  return arrivals;
}

function kneeSeries(
  msgs: FleetMessage[],
  from: number,
  to: number,
): Array<{ torqueNm: number; tempC: number; currentA: number }> {
  return msgs
    .filter(isTelemetry)
    .filter((m) => m.unitId === INCIDENT_UNIT_ID && m.ts >= from && m.ts <= to)
    .flatMap((m) => m.batch.filter((p) => p.joint === INCIDENT_JOINT));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const swing = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

const sitEngine = () => createSimEngine({ timeline: FAST, sitTimeline: FAST_SIT });

describe("SAFE SIT — execution beats", () => {
  it("has demo pacing by default: ~2 s ramp inside a 4 s command", () => {
    expect(DEFAULT_SIT_TIMELINE.rampMs).toBe(2000);
    expect(DEFAULT_SIT_TIMELINE.completeAtMs).toBe(4000);
    expect(DEFAULT_SIT_TIMELINE.completeAtMs).toBeGreaterThanOrEqual(
      DEFAULT_SIT_TIMELINE.rampMs,
    );
  });

  it("answers with a synchronous accepted, then progress beats on the clock, then complete", () => {
    const engine = sitEngine();
    engine.advance(2500); // incident live, N-07 red
    const immediate = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });

    expect(immediate).toHaveLength(1);
    const accepted = immediate[0]!;
    if (!isCommandEvent(accepted)) throw new Error("expected a command_event");
    expect(accepted).toMatchObject({
      t: "command_event",
      unitId: INCIDENT_UNIT_ID,
      cmd: "COMMAND_SAFE_SIT",
      ts: 2500,
      ev: { k: "accepted" },
    });

    const arrivals = stepDrain(engine, 2500, 2500 + FAST_SIT.completeAtMs);
    const beats = arrivals.filter((a) => isCommandEvent(a.msg)) as Array<{
      t: number;
      msg: CommandEventMessage;
    }>;

    for (const b of beats) expect(() => fleetMessageSchema.parse(b.msg)).not.toThrow();

    // four progress beats at frac * rampMs, then complete at completeAtMs
    expect(beats.map((b) => b.msg.ev.k)).toEqual([
      "progress",
      "progress",
      "progress",
      "progress",
      "complete",
    ]);
    SIT_PROGRESS_BEATS.forEach((spec, i) => {
      const beat = beats[i]!;
      expect(beat.t).toBe(2500 + FAST_SIT.rampMs * spec.frac);
      expect(beat.msg.ts).toBe(2500 + FAST_SIT.rampMs * spec.frac);
      expect(beat.msg.ev).toEqual({ k: "progress", pct: spec.pct, note: spec.note });
    });
    const complete = beats.at(-1)!;
    expect(complete.t).toBe(2500 + FAST_SIT.completeAtMs);
    expect(complete.msg.ts).toBe(2500 + FAST_SIT.completeAtMs);

    // seq strictly ascending, accepted lowest — the store's ordering authority
    const seqs = [accepted, ...beats.map((b) => b.msg)].map((m) => m.seq);
    for (let i = 1; i < seqs.length; i += 1)
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  });

  it("flips posture to sitting in snapshots once the ramp settles; N-07 stays red (broken but safe)", () => {
    const engine = sitEngine();
    engine.advance(2500);
    const findN07 = () => engine.snapshot().units.find((u) => u.id === INCIDENT_UNIT_ID)!;
    expect(findN07().posture).toBe("walking");

    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    stepDrain(engine, 2500, 2500 + FAST_SIT.rampMs - STEP_MS);
    expect(findN07().posture).toBe("walking"); // settle beat not yet due

    stepDrain(engine, 2500 + FAST_SIT.rampMs - STEP_MS, 2500 + FAST_SIT.completeAtMs);
    expect(findN07().posture).toBe("sitting");
    expect(findN07().status).toBe("red"); // the alert story does NOT resolve itself
  });

  it("offsets command_event ts by startTimeMs like every other message", () => {
    const engine = createSimEngine({
      timeline: FAST,
      sitTimeline: FAST_SIT,
      startTimeMs: 1_700_000_000_000,
    });
    engine.advance(2500);
    const [accepted] = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: "N-03" });
    if (!isCommandEvent(accepted!)) throw new Error("expected a command_event");
    expect(accepted.ts).toBe(1_700_000_000_000 + 2500);
  });
});

describe("SAFE SIT — posture on the wire", () => {
  const isUnitUpdate = (m: FleetMessage): m is UnitUpdateMessage => m.t === "unit_update";

  it("emits exactly one unit_update at the settle beat, right after POSTURE SETTLED", () => {
    const engine = sitEngine();
    engine.advance(2500); // incident live, N-07 red
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    const arrivals = stepDrain(engine, 2500, 2500 + FAST_SIT.completeAtMs);

    const updates = arrivals.filter((a) => isUnitUpdate(a.msg));
    expect(updates).toHaveLength(1);
    const settle = updates[0]!;
    expect(settle.t).toBe(2500 + FAST_SIT.rampMs); // the settle beat's instant
    if (!isUnitUpdate(settle.msg)) throw new Error("expected a unit_update");
    expect(() => fleetMessageSchema.parse(settle.msg)).not.toThrow();
    expect(settle.msg.unit).toMatchObject({
      id: INCIDENT_UNIT_ID,
      posture: "sitting",
      status: "red", // broken but safe: the restatement does not resolve the fault
    });

    // it trails the narration that announced it, in the same drain
    const sameInstant = arrivals.filter((a) => a.t === settle.t).map((a) => a.msg);
    const settledBeat = sameInstant.findIndex(
      (m) =>
        isCommandEvent(m) && m.ev.k === "progress" && m.ev.note === "POSTURE SETTLED",
    );
    expect(settledBeat).toBeGreaterThanOrEqual(0);
    expect(sameInstant.indexOf(settle.msg)).toBe(settledBeat + 1);
  });

  it("restates exactly what snapshot() would say for that unit at that instant", () => {
    const engine = sitEngine();
    engine.advance(2500);
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    const arrivals = stepDrain(engine, 2500, 2500 + FAST_SIT.rampMs);
    const update = arrivals.map((a) => a.msg).find(isUnitUpdate);
    if (!update) throw new Error("expected a unit_update by the settle beat");
    // the two statements share one mapping — a drift here is a client seeing
    // a unit the snapshot would contradict
    expect(update.unit).toEqual(
      engine.snapshot().units.find((u) => u.id === INCIDENT_UNIT_ID),
    );
  });

  it("emits none for refusals and none before the ramp settles", () => {
    const engine = sitEngine();
    engine.advance(2500);
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    const refusal = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    expect(refusal.filter(isUnitUpdate)).toHaveLength(0);

    const preSettle = stepDrain(engine, 2500, 2500 + FAST_SIT.rampMs - STEP_MS);
    expect(preSettle.filter((a) => isUnitUpdate(a.msg))).toHaveLength(0);
  });

  it("RESET_SIM mid-sit answers with the snapshot alone — no orphaned unit_update", () => {
    const engine = sitEngine();
    engine.advance(2500);
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    stepDrain(engine, 2500, 3000); // mid-ramp, settle beat still pending
    const resetOut = engine.handle({ c: "RESET_SIM" });
    expect(resetOut.map((m) => m.t)).toEqual(["fleet_snapshot"]);

    const after = stepDrain(engine, 3000, 3000 + FAST_SIT.completeAtMs);
    expect(after.filter((a) => isUnitUpdate(a.msg))).toHaveLength(0);
  });
});

describe("SAFE SIT — telemetry physics (reads in a sparkline)", () => {
  // One long run: incident live, sit at 2.5 s, watch through +12 s.
  const engine = sitEngine();
  const msgs = stepDrain(engine, 0, 2500, 100).map((a) => a.msg);
  engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
  msgs.push(...stepDrain(engine, 2500, 14_500, 100).map((a) => a.msg));

  // windows: the second before the sit vs. the second after the ramp settles
  const before = kneeSeries(msgs, 1500, 2500);
  const settled = kneeSeries(
    msgs,
    2500 + FAST_SIT.rampMs + 500,
    2500 + FAST_SIT.rampMs + 1500,
  );

  it("ramps torque to ~0 and kills the gait + fault ripple (flat + sensor noise)", () => {
    expect(swing(before.map((p) => p.torqueNm))).toBeGreaterThan(2); // rippling before
    for (const p of settled) expect(Math.abs(p.torqueNm)).toBeLessThan(0.5);
    expect(swing(settled.map((p) => p.torqueNm))).toBeLessThan(0.5);
  });

  it("drops the currents with the torque", () => {
    expect(mean(settled.map((p) => p.currentA))).toBeLessThan(0.6);
    expect(mean(settled.map((p) => p.currentA))).toBeLessThan(
      mean(before.map((p) => p.currentA)),
    );
  });

  it("decays the overheated knee toward ambient with a visible time constant", () => {
    const tempAtSit = mean(kneeSeries(msgs, 2400, 2500).map((p) => p.tempC));
    const tempAt2s = mean(kneeSeries(msgs, 4300, 4500).map((p) => p.tempC));
    const tempAt10s = mean(kneeSeries(msgs, 12_200, 12_500).map((p) => p.tempC));
    expect(tempAtSit).toBeGreaterThan(48); // it WAS overheating (52+ C band)
    expect(tempAt2s).toBeLessThan(tempAtSit - 1); // decay already visible at complete
    expect(tempAt10s).toBeLessThan(tempAtSit - 6); // and unmistakable by +10 s
    expect(tempAt10s).toBeGreaterThan(30); // decays TOWARD ambient, not below it
  });

  it("leaves every other unit's telemetry untouched", () => {
    const other = msgs
      .filter(isTelemetry)
      .filter((m) => m.unitId === "N-03" && m.ts >= 3500 && m.ts <= 4500)
      .flatMap((m) => m.batch.map((p) => Math.abs(p.torqueNm)));
    expect(Math.max(...other)).toBeGreaterThan(2); // still walking around the house
  });
});

describe("SAFE SIT — refusals (terse machine voice, printed verbatim)", () => {
  it("refuses a repeat mid-maneuver with SIT IN PROGRESS", () => {
    const engine = sitEngine();
    engine.advance(2500);
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    const out = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    expect(out).toHaveLength(1);
    if (!isCommandEvent(out[0]!)) throw new Error("expected a command_event");
    expect(out[0].ev).toEqual({ k: "failed", reason: SIT_REFUSAL_SIT_IN_PROGRESS });
  });

  it("refuses a unit that is already sitting with ALREADY SITTING", () => {
    const engine = sitEngine();
    engine.advance(2500);
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    stepDrain(engine, 2500, 2500 + FAST_SIT.completeAtMs); // maneuver done
    const out = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    if (!isCommandEvent(out[0]!)) throw new Error("expected a command_event");
    expect(out[0].ev).toEqual({ k: "failed", reason: SIT_REFUSAL_ALREADY_SITTING });
  });

  it("refuses the unit under an active diagnostic scan with SCAN IN PROGRESS — but not other units", () => {
    const engine = createSimEngine({
      timeline: FAST,
      sitTimeline: FAST_SIT,
      diagTimeline: { verdictAtMs: 5000 },
    });
    engine.advance(2500);
    engine.handle({ c: "RUN_DIAGNOSTIC", unitId: INCIDENT_UNIT_ID });

    const refused = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    if (!isCommandEvent(refused[0]!)) throw new Error("expected a command_event");
    expect(refused[0].ev).toEqual({ k: "failed", reason: SIT_REFUSAL_SCAN_IN_PROGRESS });

    // the scanner is busy with N-07; N-03's sit is its own business
    const ok = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: "N-03" });
    if (!isCommandEvent(ok[0]!)) throw new Error("expected a command_event");
    expect(ok[0].ev).toEqual({ k: "accepted" });
  });

  it("ignores a well-formed command for a unit not in the fleet (like RUN_DIAGNOSTIC)", () => {
    const engine = sitEngine();
    engine.advance(1000);
    expect(engine.handle({ c: "COMMAND_SAFE_SIT", unitId: "N-99" })).toEqual([]);
    expect(engine.activeCommandEvents()).toEqual([]);
  });

  it("refusals consume seqs but leave no session and are never replayed", () => {
    const engine = sitEngine();
    engine.advance(2500);
    const [accepted] = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    const [refused] = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    if (!isCommandEvent(accepted!) || !isCommandEvent(refused!))
      throw new Error("expected command_events");
    expect(refused.seq).toBeGreaterThan(accepted.seq);
    expect(engine.activeCommandEvents()).toEqual([accepted]); // only the live maneuver
  });
});

describe("SAFE SIT — concurrency, replay, and RESET", () => {
  it("runs sits on different units concurrently, each on its own clock", () => {
    const engine = sitEngine();
    engine.advance(2500);
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: "N-02" });
    stepDrain(engine, 2500, 3000);
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: "N-05" });
    const arrivals = stepDrain(engine, 3000, 3000 + FAST_SIT.completeAtMs);

    const completes = arrivals
      .map((a) => a.msg)
      .filter(isCommandEvent)
      .filter((m) => m.ev.k === "complete");
    expect(completes.map((m) => m.unitId)).toEqual(["N-02", "N-05"]);
    expect(completes.map((m) => m.ts)).toEqual([
      2500 + FAST_SIT.completeAtMs,
      3000 + FAST_SIT.completeAtMs,
    ]);

    const postures = engine.snapshot().units.filter((u) => u.posture === "sitting");
    expect(postures.map((u) => u.id).sort()).toEqual(["N-02", "N-05"]);
  });

  it("exposes accepted + progress for late-joiner replay, cleared once complete lands", () => {
    const engine = sitEngine();
    engine.advance(2500);
    const [accepted] = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    const arrivals = stepDrain(engine, 2500, 2500 + FAST_SIT.rampMs / 2); // two progress beats out
    const seen = [accepted!, ...arrivals.map((a) => a.msg).filter(isCommandEvent)];
    expect(engine.activeCommandEvents()).toEqual(seen); // a joiner now replays exactly this
    expect(seen).toHaveLength(3);

    stepDrain(engine, 2500 + FAST_SIT.rampMs / 2, 2500 + FAST_SIT.completeAtMs);
    expect(engine.activeCommandEvents()).toEqual([]); // maneuver over, nothing to adopt
  });

  it("RESET_SIM mid-sit cancels the maneuver and restores walking physics", () => {
    const engine = sitEngine();
    engine.advance(2500);
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    stepDrain(engine, 2500, 3000); // mid-ramp

    const resetOut = engine.handle({ c: "RESET_SIM" });
    expect(resetOut[0]!.t).toBe("fleet_snapshot");
    expect(engine.activeCommandEvents()).toEqual([]);
    expect(engine.snapshot().units.every((u) => u.posture === "walking")).toBe(true);

    // no orphaned beats fire, and the fresh storyline's telemetry walks again
    const after = stepDrain(engine, 3000, 3000 + FAST_SIT.completeAtMs + 1000);
    expect(after.map((a) => a.msg).filter(isCommandEvent)).toHaveLength(0);
    const torques = after
      .map((a) => a.msg)
      .filter(isTelemetry)
      .filter((m) => m.unitId === INCIDENT_UNIT_ID)
      .flatMap((m) =>
        m.batch.filter((p) => p.joint === INCIDENT_JOINT).map((p) => p.torqueNm),
      );
    expect(swing(torques)).toBeGreaterThan(2); // rippling/walking again, not seated
  });

  it("after RESET the unit can be commanded to sit again (ALREADY SITTING cleared)", () => {
    const engine = sitEngine();
    engine.advance(2500);
    engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    stepDrain(engine, 2500, 2500 + FAST_SIT.completeAtMs); // seated
    engine.handle({ c: "RESET_SIM" });
    const out = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID });
    if (!isCommandEvent(out[0]!)) throw new Error("expected a command_event");
    expect(out[0].ev).toEqual({ k: "accepted" });
  });

  it("is deterministic: same seed and command timing → byte-identical streams, command_events included", () => {
    const run = (seed: number, cmdAt: number) => {
      const engine = createSimEngine({ seed, timeline: FAST, sitTimeline: FAST_SIT });
      const out: FleetMessage[] = [];
      for (let t = STEP_MS; t <= cmdAt; t += STEP_MS) out.push(...engine.advance(t));
      out.push(...engine.handle({ c: "COMMAND_SAFE_SIT", unitId: INCIDENT_UNIT_ID }));
      for (let t = cmdAt + STEP_MS; t <= cmdAt + 3000; t += STEP_MS)
        out.push(...engine.advance(t));
      return out;
    };
    expect(JSON.stringify(run(7, 2500))).toEqual(JSON.stringify(run(7, 2500)));
    expect(JSON.stringify(run(7, 2500))).not.toEqual(JSON.stringify(run(8, 2500)));
    expect(JSON.stringify(run(7, 2500))).not.toEqual(JSON.stringify(run(7, 2600)));
  });
});
