// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  fleetMessageSchema,
  type AlertClearMessage,
  type AlertMessage,
  type FleetMessage,
  type TelemetryMessage,
  type UnitUpdateMessage,
} from "@/lib/schema";
import {
  createSimEngine,
  DEFAULT_NAV_TIMELINE,
  NAV_BLOCK_MESSAGE,
  NAV_RAMP_MS,
  NAV_UNIT_ID,
  type NavTimeline,
  type SimEngine,
} from "./engine";

/**
 * the N-03 blocked-navigation self-recovery storyline. The fleet's
 * second deterministic story, and the counterweight to N-07: routine ambiguity
 * the fleet handles autonomously — halt, amber, replan, clear — with zero
 * operator action. Every fact here comes out of `advance()` alone; no
 * `handle()` call appears on the happy path, which IS the assertion.
 */

/** N-07's storyline parked past this suite's window: only N-03 speaks below. */
const QUIET_N07 = { onsetMs: 60_000, amberAtMs: 70_000, redAtMs: 80_000 };

/**
 * Nav beats compressed but wider than NAV_RAMP_MS (2 s), so the storyline
 * reaches a full hold: ramp-in completes at 4 s, plateau to 8 s, resumed by
 * 10 s. Every beat is a multiple of the 50 ms step, so arrival times are exact.
 */
const FAST_NAV: NavTimeline = { blockAtMs: 2_000, clearAtMs: 8_000 };
const STEP_MS = 50;

const isAlert = (m: FleetMessage): m is AlertMessage => m.t === "alert";
const isClear = (m: FleetMessage): m is AlertClearMessage => m.t === "alert_clear";
const isUnitUpdate = (m: FleetMessage): m is UnitUpdateMessage => m.t === "unit_update";
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

/**
 * N-03's samples for ONE joint inside [from, to] (engine ts, startTimeMs 0).
 * One joint on purpose: each joint holds a different static torque, so a
 * cross-joint swing would measure the leg's anatomy, not the gait's motion.
 */
function navSeries(
  msgs: FleetMessage[],
  from: number,
  to: number,
  joint = "hip_L",
): Array<{ torqueNm: number; tempC: number }> {
  return msgs
    .filter(isTelemetry)
    .filter((m) => m.unitId === NAV_UNIT_ID && m.ts >= from && m.ts <= to)
    .flatMap((m) => m.batch.filter((p) => p.joint === joint));
}

const swing = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

const navEngine = () => createSimEngine({ timeline: QUIET_N07, navTimeline: FAST_NAV });

describe("N-03 blocked navigation — beats", () => {
  it("has demo pacing by default: blocked ~2 min in, self-recovered 40 s later", () => {
    expect(DEFAULT_NAV_TIMELINE.blockAtMs).toBe(120_000);
    expect(DEFAULT_NAV_TIMELINE.clearAtMs).toBe(160_000);
    // The window must outlast the halt/resume ramp or the hold never forms.
    expect(
      DEFAULT_NAV_TIMELINE.clearAtMs - DEFAULT_NAV_TIMELINE.blockAtMs,
    ).toBeGreaterThan(NAV_RAMP_MS);
  });

  it("raises an operator-voice amber at the block beat, clears itself at the clear beat", () => {
    const engine = navEngine();
    const arrivals = stepDrain(engine, 0, 10_000);
    const msgs = arrivals.map((a) => a.msg);
    for (const m of msgs) expect(() => fleetMessageSchema.parse(m)).not.toThrow();

    const alerts = msgs.filter(isAlert);
    expect(alerts).toHaveLength(1); // N-07 is parked; this window is N-03's
    const raise = alerts[0]!.alert;
    expect(raise).toMatchObject({
      unitId: NAV_UNIT_ID,
      severity: "amber",
      message: `Carmelita Drive: ${NAV_BLOCK_MESSAGE}`,
      ts: FAST_NAV.blockAtMs,
    });

    const clears = msgs.filter(isClear);
    expect(clears).toHaveLength(1);
    expect(clears[0]).toEqual({
      t: "alert_clear",
      alertId: raise.id, // the clear names the alert it resolves
      unitId: NAV_UNIT_ID,
      via: "self-recovery",
      ts: FAST_NAV.clearAtMs,
    });

    // On the engine clock, not before.
    const raiseAt = arrivals.find((a) => isAlert(a.msg))!.t;
    const clearAt = arrivals.find((a) => isClear(a.msg))!.t;
    expect(raiseAt).toBe(FAST_NAV.blockAtMs);
    expect(clearAt).toBe(FAST_NAV.clearAtMs);
  });

  it("follows the clear with a nominal unit_update — fact first, restatement second", () => {
    const engine = navEngine();
    const msgs = stepDrain(engine, 0, 10_000).map((a) => a.msg);

    const clearIdx = msgs.findIndex(isClear);
    const next = msgs[clearIdx + 1]!;
    if (!isUnitUpdate(next)) throw new Error("no unit_update after alert_clear");
    expect(next.unit).toMatchObject({
      id: NAV_UNIT_ID,
      status: "nominal",
      posture: "walking", // a halt is not a sit: posture never moved
    });
  });

  it("flips snapshot status amber inside the window and nominal after — posture untouched", () => {
    const engine = navEngine();
    const navSnap = () => engine.snapshot().units.find((u) => u.id === NAV_UNIT_ID)!;

    engine.advance(1_000);
    expect(navSnap().status).toBe("nominal");

    stepDrain(engine, 1_000, 5_000);
    expect(navSnap().status).toBe("amber");
    expect(navSnap().posture).toBe("walking");

    stepDrain(engine, 5_000, 10_000);
    expect(navSnap().status).toBe("nominal");
    expect(navSnap().posture).toBe("walking");
  });

  it("honors both beats across a long catch-up gap, in order", () => {
    const engine = navEngine();
    const msgs = engine.advance(60_000); // 600 slots >> catch-up cap
    const alertIdx = msgs.findIndex(isAlert);
    const clearIdx = msgs.findIndex(isClear);
    expect(alertIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeGreaterThan(alertIdx);
    expect(engine.snapshot().units.find((u) => u.id === NAV_UNIT_ID)?.status).toBe(
      "nominal",
    );
  });
});

describe("N-03 blocked navigation — stationary telemetry signature", () => {
  it("stops the gait ripple and steadies the temps while holding, then resumes", () => {
    const engine = navEngine();
    const msgs = stepDrain(engine, 0, 14_000).map((a) => a.msg);

    // Walking baseline before the block vs the settled hold (ramp-in done at
    // block + NAV_RAMP_MS) vs walking again after the resume ramp.
    const before = navSeries(msgs, 200, FAST_NAV.blockAtMs);
    const held = navSeries(msgs, FAST_NAV.blockAtMs + NAV_RAMP_MS, FAST_NAV.clearAtMs);
    const after = navSeries(msgs, FAST_NAV.clearAtMs + NAV_RAMP_MS + 1_000, 14_000);

    const torqueSwing = (xs: typeof before) => swing(xs.map((p) => p.torqueNm));
    // The ripple ceases: the held swing is noise, a fraction of the gait's.
    expect(torqueSwing(held)).toBeLessThan(torqueSwing(before) * 0.25);
    // And comes back: the unit is en route again, not quietly parked forever.
    expect(torqueSwing(after)).toBeGreaterThan(torqueSwing(held) * 2);

    // Temps hold steady (no gait heat, slow settle — not a spike either way).
    const heldTemps = held.map((p) => p.tempC);
    expect(swing(heldTemps)).toBeLessThan(2.5);
  });

  it("keeps posture 'walking' through the entire storyline — a halt is not a sit", () => {
    const engine = navEngine();
    const msgs = stepDrain(engine, 0, 12_000).map((a) => a.msg);
    for (const m of msgs.filter(isUnitUpdate)) {
      expect(m.unit.posture).toBe("walking");
    }
    expect(engine.snapshot().units.find((u) => u.id === NAV_UNIT_ID)?.posture).toBe(
      "walking",
    );
  });

  it("yields to a commanded SAFE SIT: the sit owns the signal and the clear restates a seated unit", () => {
    const engine = navEngine();
    stepDrain(engine, 0, 4_000); // mid-hold
    const answer = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: NAV_UNIT_ID });
    expect(answer[0]).toMatchObject({ t: "command_event", ev: { k: "accepted" } });

    const msgs = stepDrain(engine, 4_000, 10_000).map((a) => a.msg);
    const clearIdx = msgs.findIndex(isClear);
    const restated = msgs[clearIdx + 1]!;
    if (!isUnitUpdate(restated)) throw new Error("no unit_update after alert_clear");
    // The self-recovery still clears its alert; the restatement tells the
    // truth about the unit as it now is — seated, and no longer alerting.
    expect(restated.unit).toMatchObject({
      id: NAV_UNIT_ID,
      status: "nominal",
      posture: "sitting",
    });
  });
});

describe("N-03 blocked navigation — replay, determinism, reset", () => {
  it("replays the alert to late joiners only while it is ACTIVE", () => {
    const engine = navEngine();
    stepDrain(engine, 0, 1_000);
    expect(engine.activeAlerts()).toEqual([]); // before the block: nothing

    stepDrain(engine, 1_000, 5_000); // mid-window
    const active = engine.activeAlerts();
    expect(active).toHaveLength(1);
    expect(active[0]!.alert.unitId).toBe(NAV_UNIT_ID);

    stepDrain(engine, 5_000, 10_000); // self-recovered
    // A joiner now gets the current truth — nominal N-03, no alert — not a
    // resolved ghost it never saw raised.
    expect(engine.activeAlerts()).toEqual([]);
  });

  it("is deterministic: same seed → byte-identical streams, including the halt physics", () => {
    const run = (seed: number) => {
      const engine = createSimEngine({
        seed,
        timeline: QUIET_N07,
        navTimeline: FAST_NAV,
      });
      return stepDrain(engine, 0, 11_000).map((a) => a.msg);
    };
    expect(JSON.stringify(run(7))).toEqual(JSON.stringify(run(7)));
    expect(JSON.stringify(run(7))).not.toEqual(JSON.stringify(run(8)));
  });

  it("RESET_SIM replays the storyline: raise and clear again, fresh alert id", () => {
    const engine = navEngine();
    const first = stepDrain(engine, 0, 10_000).map((a) => a.msg);
    const firstRaise = first.filter(isAlert)[0]!.alert;

    engine.handle({ c: "RESET_SIM" });
    const replay = stepDrain(engine, 10_000, 20_000).map((a) => a.msg);
    const replayRaises = replay.filter(isAlert);
    const replayClears = replay.filter(isClear);

    expect(replayRaises).toHaveLength(1);
    expect(replayClears).toHaveLength(1);
    expect(replayRaises[0]!.alert.id).not.toBe(firstRaise.id); // seq never resets
    expect(replayClears[0]!.alertId).toBe(replayRaises[0]!.alert.id);
    expect(replayRaises[0]!.alert.message).toBe(firstRaise.message);
  });

  it("never clears what never raised: a degenerate timeline (clear <= block) just stays blocked", () => {
    const engine = createSimEngine({
      timeline: QUIET_N07,
      navTimeline: { blockAtMs: 2_000, clearAtMs: 1_000 },
    });
    const msgs = stepDrain(engine, 0, 6_000).map((a) => a.msg);
    expect(msgs.filter(isAlert)).toHaveLength(1);
    expect(msgs.filter(isClear)).toHaveLength(0);
    expect(engine.snapshot().units.find((u) => u.id === NAV_UNIT_ID)?.status).toBe(
      "amber",
    );
  });
});
