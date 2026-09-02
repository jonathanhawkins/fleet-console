// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  fleetMessageSchema,
  type DiagEvent,
  type DiagEventMessage,
  type FleetMessage,
  type TelemetryMessage,
} from "@/lib/schema";
import {
  CHANNEL_SAMPLES,
  createSimEngine,
  DIAG_WALK_PATHS,
  INCIDENT_UNIT_ID,
  JOINTS,
  scaleDiagTimeline,
  type DiagTimeline,
  type SimEngine,
} from "./engine";

/**
 * DoD: the full RUN_DIAGNOSTIC choreography over compressed time —
 * every event schema-valid, beats in order and on the clock, knee_L's wave
 * diverging from its reference while healthy joints hug theirs, cancellation
 * and late-joiner replay. Wire-level reconnect: server.diag.integration.test.ts.
 */

/** Incident beats compressed: onset 1 s, amber 1.5 s, red 2 s. */
const FAST = { onsetMs: 1000, amberAtMs: 1500, redAtMs: 2000 };

/**
 * Diag beats compressed, every due time a multiple of the 50 ms test step so
 * arrival times are exact: walks at +100..+1050, channels at +1300..+2800
 * (knee_L, JOINTS[2], at +1900), flag at +2000, verdict at +3400.
 */
const FAST_DIAG: DiagTimeline = {
  walkStartMs: 100,
  walkStepMs: 50,
  channelStartMs: 1300,
  channelStepMs: 300,
  flagDelayMs: 100,
  verdictAtMs: 3400,
};
const STEP_MS = 50;

type ChannelEvent = Extract<DiagEvent, { k: "channel" }>;

const isDiag = (m: FleetMessage): m is DiagEventMessage => m.t === "diag_event";
const isTelemetry = (m: FleetMessage): m is TelemetryMessage => m.t === "telemetry";

interface Arrival {
  t: number;
  msg: FleetMessage;
}

/** Advance the clock from fromMs to toMs in fixed steps, recording arrivals. */
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

/** Advance to cmdAtMs, send RUN_DIAGNOSTIC, then run the scan to completion. */
function runScan(
  engine: SimEngine,
  unitId: string,
  cmdAtMs: number,
  untilMs: number = cmdAtMs + FAST_DIAG.verdictAtMs,
): { immediate: FleetMessage[]; arrivals: Arrival[]; diag: DiagEventMessage[] } {
  engine.advance(cmdAtMs);
  const immediate = engine.handle({ c: "RUN_DIAGNOSTIC", unitId });
  const arrivals = stepDrain(engine, cmdAtMs, untilMs);
  const diag = [
    ...immediate.filter(isDiag),
    ...arrivals.map((a) => a.msg).filter(isDiag),
  ];
  return { immediate, arrivals, diag };
}

const kinds = (diag: DiagEventMessage[]) => diag.map((m) => m.ev.k);

const channelOf = (diag: DiagEventMessage[], joint: string): ChannelEvent => {
  const ev = diag
    .map((m) => m.ev)
    .find((e): e is ChannelEvent => e.k === "channel" && e.joint === joint);
  if (!ev) throw new Error(`no channel event for ${joint}`);
  return ev;
};

const rmsDelta = (wave: number[], ref: number[]) =>
  Math.sqrt(wave.reduce((s, w, i) => s + (w - ref[i]!) ** 2, 0) / wave.length);

const maxAbs = (xs: number[]) => Math.max(...xs.map(Math.abs));

/** Normalized cross-correlation — 1.0 means same shape (phase-consistent). */
function correlation(wave: number[], ref: number[]): number {
  let dot = 0;
  let ww = 0;
  let rr = 0;
  for (let i = 0; i < wave.length; i += 1) {
    dot += wave[i]! * ref[i]!;
    ww += wave[i]! ** 2;
    rr += ref[i]! ** 2;
  }
  return dot / Math.sqrt(ww * rr);
}

describe("diag choreography — failure path (N-07 with the incident live)", () => {
  const engine = createSimEngine({ timeline: FAST, diagTimeline: FAST_DIAG });
  const CMD_AT = 2500; // past red: the scripted failure
  const { immediate, arrivals, diag } = runScan(engine, INCIDENT_UNIT_ID, CMD_AT);

  it("emits scan_start synchronously with the command", () => {
    expect(immediate).toHaveLength(1);
    expect(immediate[0]).toEqual({
      t: "diag_event",
      unitId: INCIDENT_UNIT_ID,
      ev: { k: "scan_start" },
    });
  });

  it("streams the full sequence in beat order, every event schema-valid", () => {
    for (const m of diag) expect(() => fleetMessageSchema.parse(m)).not.toThrow();
    expect(diag.every((m) => m.unitId === INCIDENT_UNIT_ID)).toBe(true);

    expect(kinds(diag)).toEqual([
      "scan_start",
      ...Array<string>(DIAG_WALK_PATHS.length).fill("walk"),
      "channel", // hip_L
      "channel", // hip_R
      "channel", // knee_L
      "flag", //    right after the anomalous channel; the scan keeps going
      "channel", // knee_R
      "channel", // ankle_L
      "channel", // ankle_R
      "verdict",
    ]);

    const walks = diag.map((m) => m.ev).filter((e) => e.k === "walk");
    expect(walks.map((w) => w.path)).toEqual([...DIAG_WALK_PATHS]);

    const joints = diag
      .map((m) => m.ev)
      .flatMap((e) => (e.k === "channel" ? e.joint : []));
    expect(joints).toEqual([...JOINTS]);
  });

  it("flags knee_L actuator_A07 gain immediately after knee_L's channel", () => {
    const evs = diag.map((m) => m.ev);
    const kneeIdx = evs.findIndex((e) => e.k === "channel" && e.joint === "knee_L");
    expect(evs[kneeIdx + 1]).toEqual({
      k: "flag",
      joint: "knee_L",
      component: "actuator_A07",
      anomaly: "gain",
    });
  });

  it("hits every beat on the engine clock, not before", () => {
    const diagArrivals = arrivals.filter((a) => isDiag(a.msg)) as Array<{
      t: number;
      msg: DiagEventMessage;
    }>;
    const at = (k: string, n: number) =>
      diagArrivals.filter((a) => a.msg.ev.k === k)[n]!.t;

    for (let i = 0; i < DIAG_WALK_PATHS.length; i += 1) {
      expect(at("walk", i)).toBe(
        CMD_AT + FAST_DIAG.walkStartMs + i * FAST_DIAG.walkStepMs,
      );
    }
    for (let i = 0; i < JOINTS.length; i += 1) {
      expect(at("channel", i)).toBe(
        CMD_AT + FAST_DIAG.channelStartMs + i * FAST_DIAG.channelStepMs,
      );
    }
    expect(at("flag", 0)).toBe(
      CMD_AT +
        FAST_DIAG.channelStartMs +
        2 * FAST_DIAG.channelStepMs +
        FAST_DIAG.flagDelayMs,
    );
    expect(at("verdict", 0)).toBe(CMD_AT + FAST_DIAG.verdictAtMs);
  });

  it("keeps telemetry streaming while the scan runs (sparklines stay live)", () => {
    const firstChannelT = CMD_AT + FAST_DIAG.channelStartMs;
    const lastChannelT = CMD_AT + FAST_DIAG.channelStartMs + 5 * FAST_DIAG.channelStepMs;
    const during = arrivals.filter(
      (a) =>
        a.t > firstChannelT &&
        a.t < lastChannelT &&
        isTelemetry(a.msg) &&
        a.msg.unitId === INCIDENT_UNIT_ID,
    );
    expect(during.length).toBeGreaterThanOrEqual(10); // ~1.5 s of 10 Hz batches
  });

  it("diverges knee_L as a growing, phase-consistent gain error; healthy joints hug the reference", () => {
    for (const joint of JOINTS) {
      const { wave, ref } = channelOf(diag, joint);
      expect(wave).toHaveLength(CHANNEL_SAMPLES);
      expect(ref).toHaveLength(CHANNEL_SAMPLES);
      for (const v of [...wave, ...ref]) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }

      if (joint === "knee_L") {
        expect(rmsDelta(wave, ref)).toBeGreaterThan(0.12);
        // amplitude is wrong (~1.4-1.8x)…
        expect(maxAbs(wave) / maxAbs(ref)).toBeGreaterThan(1.3);
        expect(maxAbs(wave) / maxAbs(ref)).toBeLessThan(1.95);
        // …but the shape matches: it reads as GAIN, not noise or phase
        expect(correlation(wave, ref)).toBeGreaterThan(0.97);
        // and the error grows across the window
        const half = CHANNEL_SAMPLES / 2;
        const firstHalf = rmsDelta(wave.slice(0, half), ref.slice(0, half));
        const secondHalf = rmsDelta(wave.slice(half), ref.slice(half));
        expect(secondHalf).toBeGreaterThan(firstHalf * 1.2);
      } else {
        expect(rmsDelta(wave, ref)).toBeLessThan(0.05);
        expect(maxAbs(wave) / maxAbs(ref)).toBeGreaterThan(0.85);
        expect(maxAbs(wave) / maxAbs(ref)).toBeLessThan(1.15);
      }
    }
  });

  it("ends on the scripted verdict with the exact four recommendations, calibration first", () => {
    const last = diag.at(-1)!.ev;
    if (last.k !== "verdict") throw new Error("last event is not the verdict");
    expect(last.report).toMatchObject({
      unitId: INCIDENT_UNIT_ID,
      joint: "knee_L",
      component: "actuator_A07",
      anomaly: "gain",
    });
    expect(last.report.summary.length).toBeGreaterThan(0);
    // the least invasive response leads, the human escalation closes.
    // The card classifies by identity, so order here is voice, not wiring —
    // but it is still the order the report states its judgment in.
    expect(last.report.recommendations).toEqual([
      "Recalibrate joint",
      "Command safe sit",
      "Disable joint",
      "Dispatch service",
    ]);
    expect(last.report.ts).toBe(CMD_AT + FAST_DIAG.verdictAtMs); // startTimeMs 0
  });
});

describe("diag choreography — clean pass", () => {
  it("scans a healthy unit through the same beats: no flag, no-anomaly verdict", () => {
    const engine = createSimEngine({
      timeline: FAST,
      diagTimeline: FAST_DIAG,
      startTimeMs: 1_000_000,
    });
    const { diag } = runScan(engine, "N-03", 2500); // N-07's incident is live; N-03 is fine

    for (const m of diag) expect(() => fleetMessageSchema.parse(m)).not.toThrow();
    expect(kinds(diag)).toEqual([
      "scan_start",
      ...Array<string>(DIAG_WALK_PATHS.length).fill("walk"),
      ...Array<string>(JOINTS.length).fill("channel"),
      "verdict",
    ]);

    for (const joint of JOINTS) {
      const { wave, ref } = channelOf(diag, joint);
      expect(rmsDelta(wave, ref)).toBeLessThan(0.05);
    }

    const last = diag.at(-1)!.ev;
    if (last.k !== "verdict") throw new Error("last event is not the verdict");
    expect(last.report.unitId).toBe("N-03");
    expect(last.report.anomaly).toBe("none");
    expect(last.report.recommendations).toEqual(["No action required"]);
    expect(last.report.ts).toBe(1_000_000 + 2500 + FAST_DIAG.verdictAtMs);
  });

  it("scans N-07 clean before the incident onset", () => {
    const engine = createSimEngine({ timeline: FAST, diagTimeline: FAST_DIAG });
    const { diag } = runScan(engine, INCIDENT_UNIT_ID, 500); // storyline 500 < onset 1000
    expect(kinds(diag)).not.toContain("flag");
    const last = diag.at(-1)!.ev;
    if (last.k !== "verdict") throw new Error("last event is not the verdict");
    expect(last.report.anomaly).toBe("none");
  });

  it("fails N-07 as soon as the incident is live, before the amber alert", () => {
    const engine = createSimEngine({ timeline: FAST, diagTimeline: FAST_DIAG });
    const { diag } = runScan(engine, INCIDENT_UNIT_ID, 1100); // onset 1000 < 1100 < amber 1500
    expect(kinds(diag)).toContain("flag");
  });
});

describe("diag choreography — session rules", () => {
  it("ignores RUN_DIAGNOSTIC while a scan is active, for any unit; re-runnable after the verdict", () => {
    const engine = createSimEngine({ timeline: FAST, diagTimeline: FAST_DIAG });
    engine.advance(2500);
    engine.handle({ c: "RUN_DIAGNOSTIC", unitId: INCIDENT_UNIT_ID });

    // mid-scan repeats are dropped — same unit and any other
    expect(engine.handle({ c: "RUN_DIAGNOSTIC", unitId: INCIDENT_UNIT_ID })).toEqual([]);
    expect(engine.handle({ c: "RUN_DIAGNOSTIC", unitId: "N-03" })).toEqual([]);

    const arrivals = stepDrain(engine, 2500, 2500 + FAST_DIAG.verdictAtMs);
    const diag = arrivals.map((a) => a.msg).filter(isDiag);
    expect(diag.filter((m) => m.ev.k === "scan_start")).toHaveLength(0); // only the synchronous one existed
    expect(diag.filter((m) => m.ev.k === "verdict")).toHaveLength(1);

    // after the verdict the scanner is free again
    const again = engine.handle({ c: "RUN_DIAGNOSTIC", unitId: "N-03" });
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ t: "diag_event", unitId: "N-03" });
  });

  it("ignores a well-formed command for a unit not in the fleet", () => {
    const engine = createSimEngine({ timeline: FAST, diagTimeline: FAST_DIAG });
    engine.advance(1000);
    expect(engine.handle({ c: "RUN_DIAGNOSTIC", unitId: "N-99" })).toEqual([]);
    expect(engine.activeDiagEvents()).toEqual([]);
  });

  it("RESET_SIM mid-scan cancels cleanly: no further beats, replay state cleared, telemetry unbroken", () => {
    const engine = createSimEngine({ timeline: FAST, diagTimeline: FAST_DIAG });
    engine.advance(2500);
    engine.handle({ c: "RUN_DIAGNOSTIC", unitId: INCIDENT_UNIT_ID });
    stepDrain(engine, 2500, 4000); // walks done, one channel out
    expect(engine.activeDiagEvents().length).toBeGreaterThan(1);

    const resetOut = engine.handle({ c: "RESET_SIM" });
    expect(resetOut).toHaveLength(1);
    expect(resetOut[0]!.t).toBe("fleet_snapshot");
    expect(engine.activeDiagEvents()).toEqual([]);

    const after = stepDrain(engine, 4000, 2500 + FAST_DIAG.verdictAtMs + 1000);
    expect(after.map((a) => a.msg).filter(isDiag)).toHaveLength(0); // scan is dead
    expect(after.map((a) => a.msg).filter(isTelemetry).length).toBeGreaterThan(0);
  });

  it("exposes the emitted prefix for late-joiner replay, cleared once the verdict lands", () => {
    const engine = createSimEngine({ timeline: FAST, diagTimeline: FAST_DIAG });
    engine.advance(2500);
    const immediate = engine.handle({ c: "RUN_DIAGNOSTIC", unitId: INCIDENT_UNIT_ID });

    // mid-scan: walks all out (+1050), two channels out (+1300, +1600)
    const arrivals = stepDrain(engine, 2500, 2500 + 1700);
    const seen = [
      ...immediate.filter(isDiag),
      ...arrivals.map((a) => a.msg).filter(isDiag),
    ];
    expect(seen).toHaveLength(1 + DIAG_WALK_PATHS.length + 2);
    expect(engine.activeDiagEvents()).toEqual(seen); // a joiner now replays exactly this

    stepDrain(engine, 2500 + 1700, 2500 + FAST_DIAG.verdictAtMs);
    expect(engine.activeDiagEvents()).toEqual([]); // scan over, nothing to adopt
  });

  it("is deterministic: same seed and command timing → byte-identical streams; refs are seed-independent", () => {
    const run = (seed: number) => {
      const engine = createSimEngine({ seed, timeline: FAST, diagTimeline: FAST_DIAG });
      return runScan(engine, INCIDENT_UNIT_ID, 2500).diag;
    };
    expect(JSON.stringify(run(7))).toEqual(JSON.stringify(run(7)));

    const a = run(7);
    const b = run(8);
    const hipA = channelOf(a, "hip_L");
    const hipB = channelOf(b, "hip_L");
    expect(hipA.ref).toEqual(hipB.ref); // the factory reference is the factory reference
    expect(hipA.wave).not.toEqual(hipB.wave); // the live trace is this robot's
  });

  it("compresses uniformly via scaleDiagTimeline (the SIM_DIAG_SCALE mechanism)", () => {
    const scaled = scaleDiagTimeline(
      {
        walkStartMs: 1200,
        walkStepMs: 360,
        channelStartMs: 10_000,
        channelStepMs: 2200,
        flagDelayMs: 600,
        verdictAtMs: 25_000,
      },
      0.1,
    );
    expect(scaled).toEqual({
      walkStartMs: 120,
      walkStepMs: 36,
      channelStartMs: 1000,
      channelStepMs: 220,
      flagDelayMs: 60,
      verdictAtMs: 2500,
    });

    const engine = createSimEngine({ timeline: FAST, diagTimeline: scaled });
    const { diag } = runScan(
      engine,
      INCIDENT_UNIT_ID,
      2500,
      2500 + scaled.verdictAtMs + STEP_MS,
    );
    expect(kinds(diag).at(-1)).toBe("verdict"); // whole scan fits in 2.5 s
    expect(diag).toHaveLength(1 + DIAG_WALK_PATHS.length + JOINTS.length + 1 + 1);
  });
});
