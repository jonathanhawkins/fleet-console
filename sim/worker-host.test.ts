// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fleetMessageSchema,
  type AlertMessage,
  type CommandEventMessage,
  type DiagEventMessage,
  type FleetMessage,
  type OperatorCommand,
  type TelemetryMessage,
} from "@/lib/schema";
import { createSimEngine, FLEET_UNITS, JOINTS } from "./engine";
import { startSimWorkerHost, type SimWorkerPort } from "./worker-host";

/**
 * The host is driven in-process: a FakePort stands in for
 * DedicatedWorkerGlobalScope, fake timers stand in for the worker's clock
 * (vitest fakes Date.now together with setInterval, so `now() - startedAt`
 * advances in lockstep with the ticks — exactly like real time in a worker).
 */
class FakePort implements SimWorkerPort {
  /** Everything the host posted, in order (worker -> client). */
  out: unknown[] = [];
  private listeners: Array<(ev: { data: unknown }) => void> = [];

  postMessage(message: unknown): void {
    this.out.push(message);
  }

  addEventListener(_type: "message", listener: (ev: { data: unknown }) => void): void {
    this.listeners.push(listener);
  }

  /** Client -> worker. */
  emit(data: unknown): void {
    for (const l of this.listeners) l({ data });
  }
}

/** Compressed storyline: onset immediately, amber at 200 ms, red at 400 ms. */
const FAST_TIMELINE = { onsetMs: 0, amberAtMs: 200, redAtMs: 400 };
/** 50x-compressed scan: walks 24→157 ms, channels from 200 ms, verdict at 500 ms. */
const FAST_DIAG_SCALE = 0.02;

const cmd = (port: FakePort, c: OperatorCommand): void =>
  port.emit({ type: "cmd", cmd: c });

const diagEvents = (out: unknown[]): DiagEventMessage[] =>
  (out as FleetMessage[]).filter((m): m is DiagEventMessage => m.t === "diag_event");

const alertsOf = (out: unknown[]): AlertMessage[] =>
  (out as FleetMessage[]).filter((m): m is AlertMessage => m.t === "alert");

const telemetryFor = (out: unknown[], unitId: string): TelemetryMessage[] =>
  (out as FleetMessage[]).filter(
    (m): m is TelemetryMessage => m.t === "telemetry" && m.unitId === unitId,
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("worker host — init and telemetry cadence", () => {
  it("stays silent until init, then greets with a snapshot and ticks 10 Hz batches", () => {
    const port = new FakePort();
    startSimWorkerHost(port);

    vi.advanceTimersByTime(1_000);
    expect(port.out).toHaveLength(0); // no engine, no ticks, no output

    vi.setSystemTime(0); // re-pin the epoch so emitted ts read as storyline ms
    port.emit({ type: "init", seed: 42 });
    expect(port.out).toHaveLength(1); // the greeting, synchronously
    const snap = fleetMessageSchema.parse(port.out[0]);
    if (snap.t !== "fleet_snapshot") throw new Error("greeting must be a snapshot");
    expect(snap.units).toHaveLength(FLEET_UNITS.length);
    expect(snap.units.every((u) => u.status === "nominal")).toBe(true);

    vi.advanceTimersByTime(1_000);
    const rest = port.out.slice(1) as FleetMessage[];
    // 10 ticks x 8 units, every message schema-valid at the boundary contract
    expect(rest).toHaveLength(10 * FLEET_UNITS.length);
    for (const m of rest) fleetMessageSchema.parse(m);
    const n07 = telemetryFor(rest, "N-07");
    expect(n07).toHaveLength(10);
    expect(n07.map((m) => m.ts)).toEqual([
      100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    ]);
    expect(n07[0]!.batch).toHaveLength(JOINTS.length);
  });

  it("emits the exact stream the ws server would: byte-identical to a directly driven engine", () => {
    const port = new FakePort();
    startSimWorkerHost(port);
    port.emit({ type: "init", seed: 1234, timeline: FAST_TIMELINE });
    vi.advanceTimersByTime(2_000);

    // sim/server.ts shape: create engine, greet with snapshot, advance on a
    // 100 ms clock. Same seed, same clock -> the worker host must match it
    // byte for byte (alerts included: amber at 200 ms, red at 400 ms).
    const engine = createSimEngine({
      seed: 1234,
      timeline: FAST_TIMELINE,
      startTimeMs: 0,
    });
    const direct: FleetMessage[] = [engine.snapshot()];
    for (let t = 100; t <= 2_000; t += 100) direct.push(...engine.advance(t));

    expect((port.out as FleetMessage[]).some((m) => m.t === "alert")).toBe(true);
    expect(JSON.stringify(port.out)).toBe(JSON.stringify(direct));
  });

  it("stop() halts the tick loop", () => {
    const port = new FakePort();
    const host = startSimWorkerHost(port);
    port.emit({ type: "init", seed: 42 });
    vi.advanceTimersByTime(300);
    const emitted = port.out.length;
    host.stop();
    vi.advanceTimersByTime(2_000);
    expect(port.out).toHaveLength(emitted);
  });

  it("repins the N-03 self-recovery storyline via init.nav (the SIM_N03_* twin)", () => {
    const port = new FakePort();
    startSimWorkerHost(port);
    // N-07 parked late; N-03 blocked at 300 ms, self-recovered at 600 ms.
    port.emit({
      type: "init",
      seed: 42,
      timeline: { onsetMs: 60_000, amberAtMs: 70_000, redAtMs: 80_000 },
      nav: { blockAtMs: 300, clearAtMs: 600 },
    });
    vi.advanceTimersByTime(1_000);

    const out = port.out as FleetMessage[];
    for (const m of out) fleetMessageSchema.parse(m);
    const raises = alertsOf(out);
    expect(raises).toHaveLength(1);
    expect(raises[0]!.alert).toMatchObject({ unitId: "N-03", severity: "amber" });
    const clearIdx = out.findIndex((m) => m.t === "alert_clear");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(out[clearIdx]).toMatchObject({
      t: "alert_clear",
      alertId: raises[0]!.alert.id,
      unitId: "N-03",
      via: "self-recovery",
    });
    // The nominal restatement rides right behind the fact.
    expect(out[clearIdx + 1]).toMatchObject({
      t: "unit_update",
      unit: { id: "N-03", status: "nominal", posture: "walking" },
    });
  });
});

describe("worker host — commands", () => {
  it("RUN_DIAGNOSTIC streams the full choreography: scan_start, walks, channels, flag, verdict", () => {
    const port = new FakePort();
    startSimWorkerHost(port);
    port.emit({
      type: "init",
      seed: 42,
      timeline: FAST_TIMELINE,
      diagScale: FAST_DIAG_SCALE,
    });

    vi.advanceTimersByTime(500); // incident live (past red)
    cmd(port, { c: "RUN_DIAGNOSTIC", unitId: "N-07" });
    // scan_start answers the command synchronously, like the server broadcast
    const last = port.out.at(-1) as DiagEventMessage;
    expect(last).toMatchObject({
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "scan_start" },
    });

    vi.advanceTimersByTime(600); // scaled verdict lands at +500 ms
    const kinds = diagEvents(port.out).map((m) => m.ev.k);
    expect(kinds[0]).toBe("scan_start");
    expect(kinds.filter((k) => k === "walk")).toHaveLength(20);
    expect(kinds.filter((k) => k === "channel")).toHaveLength(6);
    expect(kinds.filter((k) => k === "flag")).toHaveLength(1);
    expect(kinds.at(-1)).toBe("verdict");
    // beat order: all walks before the first channel; flag right after knee_L
    expect(kinds.lastIndexOf("walk")).toBeLessThan(kinds.indexOf("channel"));
    const events = diagEvents(port.out);
    const flagIdx = events.findIndex((m) => m.ev.k === "flag");
    const before = events[flagIdx - 1]!.ev;
    expect(before).toMatchObject({ k: "channel", joint: "knee_L" });
    const verdict = events.at(-1)!.ev;
    if (verdict.k !== "verdict") throw new Error("last diag event must be the verdict");
    expect(verdict.report).toMatchObject({
      unitId: "N-07",
      joint: "knee_L",
      component: "actuator_A07",
      anomaly: "gain",
    });
  });

  it("RESET_SIM broadcasts a fresh nominal snapshot and replays the storyline", () => {
    const port = new FakePort();
    startSimWorkerHost(port);
    port.emit({ type: "init", seed: 42, timeline: FAST_TIMELINE });

    vi.advanceTimersByTime(400); // amber + red both fired
    expect(alertsOf(port.out).map((m) => m.alert.severity)).toEqual(["amber", "red"]);

    const mark = port.out.length;
    cmd(port, { c: "RESET_SIM" });
    const snap = port.out[mark] as FleetMessage;
    if (snap.t !== "fleet_snapshot")
      throw new Error("RESET_SIM must answer with a snapshot");
    expect(snap.units.every((u) => u.status === "nominal")).toBe(true);

    vi.advanceTimersByTime(250); // storyline restarted: amber again at +200 ms
    const alertsAfter = alertsOf(port.out.slice(mark));
    expect(alertsAfter.map((m) => m.alert.severity)).toEqual(["amber"]);
  });
});

describe("worker host — determinism (Playwright's contract)", () => {
  it("two hosts, same seed and command timing: identical streams; another seed diverges", () => {
    const a = new FakePort();
    const b = new FakePort();
    const c = new FakePort();
    startSimWorkerHost(a);
    startSimWorkerHost(b);
    startSimWorkerHost(c);
    const init = {
      type: "init",
      seed: 7,
      timeline: FAST_TIMELINE,
      diagScale: 0.05,
    };
    a.emit(init);
    b.emit(init);
    c.emit({ ...init, seed: 8 });

    vi.advanceTimersByTime(1_000);
    for (const port of [a, b, c]) cmd(port, { c: "RUN_DIAGNOSTIC", unitId: "N-07" });
    vi.advanceTimersByTime(1_500); // scaled verdict at +1250 ms

    expect(a.out.length).toBeGreaterThan(200); // snapshot + 25 s.. batches + 29 diag beats
    expect(diagEvents(a.out).at(-1)!.ev.k).toBe("verdict");
    expect(JSON.stringify(a.out)).toBe(JSON.stringify(b.out));
    expect(JSON.stringify(a.out)).not.toBe(JSON.stringify(c.out));
  });
});

describe("worker host — parity with the ws server (units knob + SAFE SIT)", () => {
  it("honors the units init knob — the NEXT_PUBLIC_SIM_UNITS twin of SIM_UNITS", () => {
    const port = new FakePort();
    startSimWorkerHost(port);
    port.emit({ type: "init", seed: 42, units: 500 });

    const snap = fleetMessageSchema.parse(port.out[0]);
    if (snap.t !== "fleet_snapshot") throw new Error("greeting must be a snapshot");
    expect(snap.units).toHaveLength(500);
    expect(snap.units[6]!.id).toBe("N-07"); // storyline unit survives the scale-up
    expect(snap.units[8]!.id).toBe("N-009");
    expect(snap.units.every((u) => u.posture === "walking")).toBe(true);

    vi.advanceTimersByTime(100);
    expect(port.out).toHaveLength(1 + 500); // one tick: a batch per unit
  });

  it("executes COMMAND_SAFE_SIT over the port: accepted synchronously, beats stream, refusal parity", () => {
    const port = new FakePort();
    startSimWorkerHost(port);
    port.emit({ type: "init", seed: 42, timeline: FAST_TIMELINE });

    vi.advanceTimersByTime(500); // incident live (past red)
    cmd(port, { c: "COMMAND_SAFE_SIT", unitId: "N-07" });
    expect(port.out.at(-1)).toMatchObject({
      t: "command_event",
      unitId: "N-07",
      cmd: "COMMAND_SAFE_SIT",
      ev: { k: "accepted" },
    });

    vi.advanceTimersByTime(4_000); // DEFAULT_SIT_TIMELINE.completeAtMs
    const events = (port.out as FleetMessage[]).filter(
      (m): m is CommandEventMessage => m.t === "command_event",
    );
    expect(events.map((m) => m.ev.k)).toEqual([
      "accepted",
      "progress",
      "progress",
      "progress",
      "progress",
      "complete",
    ]);
    for (const m of events) fleetMessageSchema.parse(m);

    // the settle beat restates the unit over the port too — exactly
    // one unit_update, right after the POSTURE SETTLED narration beat
    const stream = port.out as FleetMessage[];
    const updates = stream.filter((m) => m.t === "unit_update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      t: "unit_update",
      unit: { id: "N-07", posture: "sitting", status: "red" },
    });
    fleetMessageSchema.parse(updates[0]);
    const settleIdx = stream.findIndex(
      (m) =>
        m.t === "command_event" &&
        m.ev.k === "progress" &&
        m.ev.note === "POSTURE SETTLED",
    );
    expect(stream.indexOf(updates[0]!)).toBe(settleIdx + 1);

    // seated now: a repeat refuses with the machine-voice reason, over the port
    cmd(port, { c: "COMMAND_SAFE_SIT", unitId: "N-07" });
    const refusal = port.out.at(-1) as CommandEventMessage;
    expect(refusal.ev).toEqual({ k: "failed", reason: "ALREADY SITTING" });
  });
});

describe("worker host — parity with the ws server (firmware cohort)", () => {
  it("repins the cohort via init.cohort (the SIM_COHORT_* twins): distribution, staggered signature, halt receipt, staged rollback", () => {
    const port = new FakePort();
    startSimWorkerHost(port);
    port.emit({
      type: "init",
      seed: 42,
      timeline: { onsetMs: 60_000, amberAtMs: 70_000, redAtMs: 80_000 }, // N-07 parked
      cohort: {
        onsetMs: 200,
        staggerMs: 100,
        pendingAtMs: 2_000,
        rollbackPerUnitMs: 200,
      },
    });

    // the greeting snapshot carries the firmware distribution
    const snap = fleetMessageSchema.parse(port.out[0]);
    if (snap.t !== "fleet_snapshot") throw new Error("greeting must be a snapshot");
    const rolled = snap.units.filter((u) => u.fw === "2.4.1").map((u) => u.id);
    expect(rolled).toEqual(["N-02", "N-04", "N-06", "N-08"]);
    expect(snap.units.find((u) => u.id === "N-05")).toMatchObject({
      fw: "2.3.7",
      fwPending: "2.4.1",
    });

    vi.advanceTimersByTime(600); // raises at 200/300/400/500
    const raises = alertsOf(port.out);
    expect(raises).toHaveLength(4);
    expect(new Set(raises.map((m) => m.alert.message)).size).toBe(1); // byte-identical signature
    expect(raises.map((m) => m.alert.ts)).toEqual([200, 300, 400, 500]);

    // HALT_ROLLOUT answers synchronously over the port, receipt included
    cmd(port, { c: "HALT_ROLLOUT" });
    const haltTail = port.out.slice(-4) as FleetMessage[];
    for (const m of haltTail) fleetMessageSchema.parse(m);
    expect(haltTail.map((m) => m.t)).toEqual([
      "fleet_command_event",
      "fleet_command_event",
      "unit_update",
      "fleet_command_event",
    ]);
    expect(haltTail[2]).toMatchObject({
      t: "unit_update",
      unit: { id: "N-05", fw: "2.3.7" },
    });

    // the staged rollback restores one unit per window and completes
    cmd(port, { c: "ROLLBACK_COHORT", fw: "2.4.1" });
    vi.advanceTimersByTime(1_000); // 4 units x 200 ms, plus slack
    const stream = port.out as FleetMessage[];
    for (const m of stream) fleetMessageSchema.parse(m);
    const fleetEvents = stream.filter((m) => m.t === "fleet_command_event");
    expect(fleetEvents.at(-1)!.ev.k).toBe("complete");
    const clears = stream.filter((m) => m.t === "alert_clear");
    expect(clears).toHaveLength(4);
    expect(clears.every((m) => m.t === "alert_clear" && m.via === "rollback")).toBe(true);
    const restored = stream.filter(
      (m) => m.t === "unit_update" && m.unit.fw === "2.3.7" && m.unit.id !== "N-05",
    );
    expect(restored).toHaveLength(4); // every rollout unit restated onto the baseline
  });
});

describe("worker host — boundary hygiene", () => {
  it("drops malformed messages and pre-init commands with a dev warning, then still inits", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = new FakePort();
    startSimWorkerHost(port);

    port.emit("not even an object");
    port.emit({ type: "mystery" });
    port.emit({ type: "cmd", cmd: { c: "RUN_DIAGNOSTIC" } }); // missing unitId
    port.emit({ type: "cmd", cmd: { c: "RESET_SIM" } }); // valid shape, but before init
    expect(port.out).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(4);

    port.emit({ type: "init", seed: 42 });
    vi.advanceTimersByTime(100);
    expect(port.out.length).toBe(1 + FLEET_UNITS.length);
  });

  it("a second init replaces the run: fresh snapshot, restarted clock", () => {
    const port = new FakePort();
    startSimWorkerHost(port);
    port.emit({ type: "init", seed: 42, timeline: FAST_TIMELINE });
    vi.advanceTimersByTime(400); // amber + red fired, statuses flipped

    const mark = port.out.length;
    port.emit({ type: "init", seed: 42, timeline: FAST_TIMELINE });
    const snap = port.out[mark] as FleetMessage;
    if (snap.t !== "fleet_snapshot")
      throw new Error("re-init must greet with a snapshot");
    expect(snap.units.every((u) => u.status === "nominal")).toBe(true);

    vi.advanceTimersByTime(100); // exactly one tick's worth on the new clock
    expect(port.out.length).toBe(mark + 1 + FLEET_UNITS.length);
  });
});
