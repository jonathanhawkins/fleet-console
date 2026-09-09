// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  fleetMessageSchema,
  type AlertMessage,
  type FleetMessage,
  type TelemetryMessage,
} from "@/lib/schema";
import {
  BATCH_INTERVAL_MS,
  createSimEngine,
  DEFAULT_TIMELINE,
  FLEET_UNITS,
  INCIDENT_JOINT,
  INCIDENT_UNIT_ID,
  JOINTS,
  PREROLL_MS,
  prerollFor,
} from "./engine";

/** Compressed storyline so every test runs in milliseconds of sim time. */
const FAST = { onsetMs: 1000, amberAtMs: 1500, redAtMs: 2000 };

const isAlert = (m: FleetMessage): m is AlertMessage => m.t === "alert";
const isTelemetry = (m: FleetMessage): m is TelemetryMessage => m.t === "telemetry";

function kneeTemps(
  msgs: FleetMessage[],
  unitId: string,
  from: number,
  to: number,
): number[] {
  return msgs
    .filter(isTelemetry)
    .filter((m) => m.unitId === unitId && m.ts >= from && m.ts <= to)
    .flatMap((m) =>
      m.batch.filter((p) => p.joint === INCIDENT_JOINT).map((p) => p.tempC),
    );
}

describe("sim engine — fleet shape", () => {
  it("paces the incident against the moment the console starts watching, not zero", () => {
    // A run begins at PREROLL_MS with the history already handed over, so what
    // someone who just opened the page sees is the beat minus that.
    expect(DEFAULT_TIMELINE.onsetMs - PREROLL_MS).toBe(2_000);
    expect(DEFAULT_TIMELINE.amberAtMs - PREROLL_MS).toBe(15_000);
    expect(DEFAULT_TIMELINE.redAtMs - PREROLL_MS).toBe(25_000);
    expect(DEFAULT_TIMELINE.onsetMs).toBeLessThan(DEFAULT_TIMELINE.amberAtMs);
    expect(DEFAULT_TIMELINE.amberAtMs).toBeLessThan(DEFAULT_TIMELINE.redAtMs);
    expect(BATCH_INTERVAL_MS).toBe(100); // 10 Hz batches
  });

  it("holds the ramp rate that every number written about the climb depends on", () => {
    // Temperature rises a fixed 12 C across onset->amber, so that interval IS
    // the ramp rate: 12 C over 13 s is ~55 C/min, which is what makes the
    // trend watch's fit read ~18 C/min five seconds in. Move the beats all you
    // like; changing the gap between them silently rewrites the physics and
    // every figure quoted about it.
    expect(DEFAULT_TIMELINE.amberAtMs - DEFAULT_TIMELINE.onsetMs).toBe(13_000);
    expect(DEFAULT_TIMELINE.redAtMs - DEFAULT_TIMELINE.amberAtMs).toBe(10_000);
  });

  it("leaves room for the history it promises: the pre-roll never reaches the onset", () => {
    expect(prerollFor(PREROLL_MS, DEFAULT_TIMELINE.onsetMs)).toBe(PREROLL_MS);
    // A compressed storyline gets whatever calm it actually has, or none.
    expect(prerollFor(PREROLL_MS, 6_000)).toBe(4_000);
    expect(prerollFor(PREROLL_MS, 0)).toBe(0);
  });

  it("snapshots eight named nominal units before anything happens", () => {
    const snap = createSimEngine().snapshot();
    expect(snap.t).toBe("fleet_snapshot");
    expect(snap.units).toHaveLength(8);
    expect(snap.units.map((u) => u.id)).toEqual(FLEET_UNITS.map((u) => u.id));
    expect(snap.units.find((u) => u.id === "N-07")?.name).toBe("Elm House");
    for (const u of snap.units) {
      expect(u.status).toBe("nominal");
      expect(u.battery).toBeGreaterThanOrEqual(62);
      expect(u.battery).toBeLessThanOrEqual(96);
    }
  });

  it("emits 10 Hz batches per unit with one point per joint, all schema-valid", () => {
    const msgs = createSimEngine({ timeline: FAST }).advance(1000);
    for (const m of msgs) expect(() => fleetMessageSchema.parse(m)).not.toThrow();

    const telemetry = msgs.filter(isTelemetry);
    expect(telemetry).toHaveLength(8 * 10); // 8 units x 10 batches in 1 s
    for (const m of telemetry) {
      expect(m.batch).toHaveLength(JOINTS.length);
      expect(m.batch.map((p) => p.joint).sort()).toEqual([...JOINTS].sort());
    }
  });

  it("keeps nominal telemetry plausible: temps 28-44 C, positive current, sane torque", () => {
    const msgs = createSimEngine({ timeline: FAST }).advance(999); // pre-onset only
    for (const m of msgs.filter(isTelemetry)) {
      for (const p of m.batch) {
        expect(p.tempC).toBeGreaterThanOrEqual(28);
        expect(p.tempC).toBeLessThanOrEqual(44);
        expect(p.currentA).toBeGreaterThan(0);
        expect(Math.abs(p.torqueNm)).toBeLessThan(40);
        expect(p.battery).toBeGreaterThan(0);
        expect(p.battery).toBeLessThanOrEqual(100);
      }
    }
    expect(msgs.some(isAlert)).toBe(false);
  });

  it("drains battery slowly over a long run", () => {
    // 1 s slots so ten minutes stays cheap; advance in chunks under the catch-up cap.
    const engine = createSimEngine({ timeline: FAST, batchIntervalMs: 1000 });
    const start = engine.snapshot().units[0]!.battery;
    for (let t = 60_000; t <= 600_000; t += 60_000) engine.advance(t);
    const end = engine.snapshot().units[0]!.battery;
    expect(end).toBeLessThan(start);
    expect(start - end).toBeCloseTo(3.5, 0); // ~0.35 %/min for 10 min
  });
});

describe("sim engine — the scripted N-07 incident", () => {
  it("plays the beats in order at the configured times: calm, climb, amber, red", () => {
    const engine = createSimEngine({ timeline: FAST });
    const msgs = engine.advance(2500);

    const alerts = msgs.filter(isAlert);
    expect(alerts.map((a) => a.alert.severity)).toEqual(["amber", "red"]);
    expect(alerts.map((a) => a.alert.ts)).toEqual([FAST.amberAtMs, FAST.redAtMs]);
    expect(alerts.every((a) => a.alert.unitId === INCIDENT_UNIT_ID)).toBe(true);

    // beats interleave correctly with the telemetry stream
    const amberIdx = msgs.findIndex((m) => isAlert(m) && m.alert.severity === "amber");
    const redIdx = msgs.findIndex((m) => isAlert(m) && m.alert.severity === "red");
    expect(amberIdx).toBeGreaterThan(0);
    expect(amberIdx).toBeLessThan(redIdx);
    const lastPreAmberTelemetry = msgs.slice(0, amberIdx).filter(isTelemetry).at(-1);
    expect(lastPreAmberTelemetry!.ts).toBeLessThan(FAST.amberAtMs);

    // knee_L temperature has left the nominal band by red
    const calm = kneeTemps(msgs, INCIDENT_UNIT_ID, 0, FAST.onsetMs - 100);
    const hot = kneeTemps(msgs, INCIDENT_UNIT_ID, FAST.redAtMs, 2500);
    expect(Math.max(...calm)).toBeLessThanOrEqual(44);
    expect(Math.min(...hot)).toBeGreaterThan(44);

    // torque ripple: swing widens versus the calm window
    const torques = (from: number, to: number) =>
      msgs
        .filter(isTelemetry)
        .filter((m) => m.unitId === INCIDENT_UNIT_ID && m.ts >= from && m.ts <= to)
        .flatMap((m) =>
          m.batch.filter((p) => p.joint === INCIDENT_JOINT).map((p) => p.torqueNm),
        );
    const swing = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(swing(torques(FAST.redAtMs, 2500))).toBeGreaterThan(
      swing(torques(0, FAST.onsetMs)) * 0.9 + 2,
    );

    // the rest of the fleet never leaves the nominal band
    for (const u of FLEET_UNITS.filter((u) => u.id !== INCIDENT_UNIT_ID)) {
      expect(Math.max(...kneeTemps(msgs, u.id, 0, 2500))).toBeLessThanOrEqual(44);
    }

    // snapshot status tracked the alerts
    expect(engine.snapshot().units.find((u) => u.id === INCIDENT_UNIT_ID)?.status).toBe(
      "red",
    );
  });

  it("flips snapshot status amber before red", () => {
    const engine = createSimEngine({ timeline: FAST });
    engine.advance(1600);
    expect(engine.snapshot().units.find((u) => u.id === INCIDENT_UNIT_ID)?.status).toBe(
      "amber",
    );
    engine.advance(2100);
    expect(engine.snapshot().units.find((u) => u.id === INCIDENT_UNIT_ID)?.status).toBe(
      "red",
    );
  });

  it("honors alert beats even across a long catch-up gap", () => {
    const engine = createSimEngine({ timeline: FAST });
    const msgs = engine.advance(60_000); // 600 slots >> catch-up cap
    const alerts = msgs.filter(isAlert);
    expect(alerts.map((a) => a.alert.severity)).toEqual(["amber", "red"]);
    expect(engine.snapshot().units.find((u) => u.id === INCIDENT_UNIT_ID)?.status).toBe(
      "red",
    );
  });
});

describe("sim engine — determinism and reset", () => {
  it("produces identical streams for the same seed and command timing, different for another", () => {
    // Commands included: a SAFE SIT, a timed HALT_ROLLOUT, and a timed staged
    // ROLLBACK_COHORT issued at the same engine times must yield byte-identical
    // command_events and fleet_command_events (seq, ts, beats), identical
    // per-unit restatements/clears, and identical post-sit telemetry. Full
    // choreographies: safe-sit.test.ts and rollout.test.ts.
    const run = (seed: number) => {
      const engine = createSimEngine({
        seed,
        timeline: FAST,
        cohortTimeline: {
          onsetMs: 500,
          staggerMs: 100,
          pendingAtMs: 2_200,
          rollbackPerUnitMs: 150,
        },
      });
      const out = engine.advance(1200);
      out.push(...engine.handle({ c: "COMMAND_SAFE_SIT", unitId: "N-03" }));
      out.push(...engine.advance(1600));
      out.push(...engine.handle({ c: "HALT_ROLLOUT" })); // before the 2.2 s install
      out.push(...engine.advance(1800));
      out.push(...engine.handle({ c: "ROLLBACK_COHORT", fw: "2.4.1" }));
      out.push(...engine.advance(2500)); // rollback completes at 2.4 s
      return out;
    };
    expect(JSON.stringify(run(7))).toEqual(JSON.stringify(run(7)));
    expect(JSON.stringify(run(7))).not.toEqual(JSON.stringify(run(8)));
    expect(run(7).some((m) => m.t === "command_event")).toBe(true);
    expect(
      run(7).some((m) => m.t === "fleet_command_event" && m.ev.k === "complete"),
    ).toBe(true);
  });

  it("RESET_SIM restarts cleanly and replays the exact same storyline", () => {
    const fresh = createSimEngine({ timeline: FAST });
    const freshStream = fresh.advance(2500);

    const engine = createSimEngine({ timeline: FAST });
    engine.advance(2500); // run to red
    const resetOut = engine.handle({ c: "RESET_SIM" });
    expect(resetOut).toHaveLength(1);
    expect(resetOut[0]!.t).toBe("fleet_snapshot");
    const snap = engine.snapshot();
    expect(snap.units.every((u) => u.status === "nominal")).toBe(true);

    const replay = engine.advance(5000); // 2500 ms of storyline after reset
    const offset = (m: FleetMessage) =>
      JSON.parse(JSON.stringify(m)) as Record<string, unknown>;

    const normFresh = freshStream.map(offset);
    const normReplay = replay.map((m) => {
      const c = offset(m);
      if (m.t === "telemetry") (c as { ts: number }).ts = m.ts - 2500;
      if (m.t === "alert") {
        const a = (c as { alert: { ts: number; id: string } }).alert;
        a.ts = a.ts - 2500;
        a.id = "normalized"; // alert seq keeps counting across resets so ids stay unique
      }
      return c;
    });
    for (const m of normFresh)
      if (m.t === "alert") (m as { alert: { id: string } }).alert.id = "normalized";

    expect(normReplay).toEqual(normFresh);
  });

  it("exposes this run's alerts for late-joiner replay, cleared by reset", () => {
    const engine = createSimEngine({ timeline: FAST });
    expect(engine.activeAlerts()).toEqual([]);
    engine.advance(2500);
    const active = engine.activeAlerts();
    expect(active.map((a) => a.alert.severity)).toEqual(["amber", "red"]);
    engine.handle({ c: "RESET_SIM" });
    expect(engine.activeAlerts()).toEqual([]);
  });

  it("answers RUN_DIAGNOSTIC with scan_start synchronously (full choreography: diagnostics.test.ts)", () => {
    const engine = createSimEngine({ timeline: FAST });
    engine.advance(2500);
    expect(engine.handle({ c: "RUN_DIAGNOSTIC", unitId: INCIDENT_UNIT_ID })).toEqual([
      { t: "diag_event", unitId: INCIDENT_UNIT_ID, ev: { k: "scan_start" } },
    ]);
  });

  it("offsets every ts by startTimeMs so the server can emit wall-clock times", () => {
    const engine = createSimEngine({ timeline: FAST, startTimeMs: 1_700_000_000_000 });
    const msgs = engine.advance(1600);
    const first = msgs.find(isTelemetry)!;
    expect(first.ts).toBe(1_700_000_000_000 + 100);
    const amber = msgs.find(isAlert)!;
    expect(amber.alert.ts).toBe(1_700_000_000_000 + FAST.amberAtMs);
  });
});
