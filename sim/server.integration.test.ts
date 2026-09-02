// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AlertMessage,
  type CommandEventMessage,
  type FleetCommandEventMessage,
  type FleetMessage,
  type FleetSnapshotMessage,
  type TelemetryMessage,
  type UnitUpdateMessage,
} from "@/lib/schema";
import { WsTransport } from "@/lib/transport/wsTransport";
import { startSimServer, type SimServer } from "./server";

/**
 * End-to-end smoke (machine-checkable proof for): the real ws server
 * hosting the real engine, spoken to by the real WsTransport over Node 22's
 * native WebSocket. Timeline compressed so the "15 s" storyline lands in ~1 s.
 */

const TIMELINE = { onsetMs: 300, amberAtMs: 900, redAtMs: 1400 };

function waitFor<T>(
  check: () => T | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const value = check();
      if (value !== undefined) {
        clearInterval(poll);
        resolve(value);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 10);
  });
}

describe("sim server + WsTransport over a real socket", () => {
  let server: SimServer;
  let transport: WsTransport;
  const received: FleetMessage[] = [];

  beforeAll(async () => {
    server = await startSimServer({
      port: 0, // ephemeral; the pnpm sim default is 8791
      timeline: TIMELINE,
      tickMs: 20,
      log: () => {},
    });
    transport = new WsTransport({ url: `ws://127.0.0.1:${server.port}` });
    transport.connect((msg) => received.push(msg));
  });

  afterAll(async () => {
    transport.disconnect();
    await server.close();
  });

  it("delivers snapshot, then 10 Hz telemetry, then the scripted amber and red alerts", async () => {
    const snapshot = await waitFor(
      () => received.find((m): m is FleetSnapshotMessage => m.t === "fleet_snapshot"),
      2000,
      "fleet_snapshot",
    );
    expect(received[0]!.t).toBe("fleet_snapshot"); // snapshot greets the connection
    expect(snapshot.units).toHaveLength(8);
    expect(snapshot.units.map((u) => u.id)).toContain("N-07");

    const telemetry = await waitFor(
      () => received.find((m): m is TelemetryMessage => m.t === "telemetry"),
      2000,
      "first telemetry batch",
    );
    expect(telemetry.batch.length).toBe(6);

    const amber = await waitFor(
      () =>
        received.find(
          (m): m is AlertMessage => m.t === "alert" && m.alert.severity === "amber",
        ),
      3000,
      "amber alert",
    );
    expect(amber.alert.unitId).toBe("N-07");

    const red = await waitFor(
      () =>
        received.find(
          (m): m is AlertMessage => m.t === "alert" && m.alert.severity === "red",
        ),
      3000,
      "red alert",
    );
    expect(red.alert.unitId).toBe("N-07");
    expect(received.indexOf(amber)).toBeLessThan(received.indexOf(red));
    expect(amber.alert.ts).toBeLessThan(red.alert.ts);
  });

  it("replays the incident's alerts to a client that connects mid-storyline", async () => {
    // by now the first test has driven the storyline past red
    const late: FleetMessage[] = [];
    const lateTransport = new WsTransport({ url: `ws://127.0.0.1:${server.port}` });
    lateTransport.connect((msg) => late.push(msg));
    await waitFor(
      () => (late.filter((m) => m.t === "alert").length >= 2 ? true : undefined),
      2000,
      "replayed alerts on connect",
    );
    expect(late[0]!.t).toBe("fleet_snapshot");
    const severities = late
      .filter((m): m is AlertMessage => m.t === "alert")
      .map((m) => m.alert.severity);
    expect(severities).toEqual(["amber", "red"]);
    lateTransport.disconnect();
  });

  it("survives a garbage client frame and answers RESET_SIM with a nominal snapshot", async () => {
    // a rude second client sends garbage; the server must not crash
    const rude = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve) => {
      rude.onopen = () => resolve();
    });
    rude.send("garbage{{{");
    rude.send(JSON.stringify({ c: "SELF_DESTRUCT" }));

    const before = received.length;
    transport.send({ c: "RESET_SIM" });
    const freshSnapshot = await waitFor(
      () =>
        received
          .slice(before)
          .find((m): m is FleetSnapshotMessage => m.t === "fleet_snapshot"),
      2000,
      "post-reset snapshot",
    );
    expect(freshSnapshot.units.every((u) => u.status === "nominal")).toBe(true);

    // telemetry keeps flowing after the garbage + reset
    const after = received.length;
    await waitFor(
      () => (received.length > after ? true : undefined),
      2000,
      "telemetry after reset",
    );
    rude.close();
  });
});

describe("SAFE SIT + fleet scale over a real socket (Phase 10 parity)", () => {
  it("sizes the fleet by `units`, executes the sit, and replays it to a late joiner", async () => {
    const server = await startSimServer({
      port: 0,
      units: 20,
      timeline: TIMELINE,
      // fast ramp so the maneuver settles in the test; complete far out so the
      // late joiner reliably lands mid-sit and gets the replay
      sitTimeline: { rampMs: 400, completeAtMs: 8_000 },
      tickMs: 20,
      log: () => {},
    });
    const received: FleetMessage[] = [];
    const transport = new WsTransport({ url: `ws://127.0.0.1:${server.port}` });
    transport.connect((msg) => received.push(msg));
    const lateTransport = new WsTransport({ url: `ws://127.0.0.1:${server.port}` });

    try {
      const snapshot = await waitFor(
        () => received.find((m): m is FleetSnapshotMessage => m.t === "fleet_snapshot"),
        2000,
        "sized fleet_snapshot",
      );
      expect(snapshot.units).toHaveLength(20); // SIM_UNITS parity on the wire
      expect(snapshot.units.at(-1)!.id).toBe("N-20");
      expect(snapshot.units.every((u) => u.posture === "walking")).toBe(true);

      transport.send({ c: "COMMAND_SAFE_SIT", unitId: "N-03" });
      const commandEvents = () =>
        received.filter((m): m is CommandEventMessage => m.t === "command_event");
      await waitFor(
        () => commandEvents().find((m) => m.ev.k === "accepted"),
        2000,
        "accepted command_event",
      );
      await waitFor(
        () =>
          commandEvents().filter((m) => m.ev.k === "progress").length >= 4
            ? true
            : undefined,
        3000,
        "the four progress beats",
      );

      // the settle beat restates the unit to the LIVE client — this
      // connection never drops, and still sees the posture flip on the wire
      const settled = await waitFor(
        () =>
          received.find(
            (m): m is UnitUpdateMessage => m.t === "unit_update" && m.unit.id === "N-03",
          ),
        2000,
        "settle-beat unit_update",
      );
      expect(settled.unit.posture).toBe("sitting");

      // a client joining mid-maneuver gets snapshot (posture already settled)
      // then the replayed accepted + progress prefix
      const late: FleetMessage[] = [];
      lateTransport.connect((msg) => late.push(msg));
      await waitFor(
        () => late.find((m) => m.t === "command_event"),
        2000,
        "replayed command_events on connect",
      );
      const lateSnap = late[0]!;
      if (lateSnap.t !== "fleet_snapshot") throw new Error("greeting must be a snapshot");
      expect(lateSnap.units.find((u) => u.id === "N-03")?.posture).toBe("sitting");
      const lateEvents = late.filter(
        (m): m is CommandEventMessage => m.t === "command_event",
      );
      expect(lateEvents[0]!.ev.k).toBe("accepted");
      expect(lateEvents.map((m) => m.seq)).toEqual(
        commandEvents()
          .slice(0, lateEvents.length)
          .map((m) => m.seq),
      );
    } finally {
      lateTransport.disconnect();
      transport.disconnect();
      await server.close();
    }
  });
});

describe("firmware cohort over a real socket (Phase 11 parity)", () => {
  it("streams the staggered signature, executes a staged rollback, and replays it to a mid-flight joiner", async () => {
    const server = await startSimServer({
      port: 0,
      // N-07 parked far out; cohort compressed; queued install parked far out
      // (the halt path is engine-tested — this test is about the wire); each
      // rollback stage 800 ms so the late joiner reliably lands mid-flight.
      timeline: { onsetMs: 60_000, amberAtMs: 70_000, redAtMs: 80_000 },
      cohortTimeline: {
        onsetMs: 100,
        staggerMs: 100,
        pendingAtMs: 60_000,
        rollbackPerUnitMs: 800,
      },
      tickMs: 20,
      log: () => {},
    });
    const received: FleetMessage[] = [];
    const transport = new WsTransport({ url: `ws://127.0.0.1:${server.port}` });
    transport.connect((msg) => received.push(msg));
    const lateTransport = new WsTransport({ url: `ws://127.0.0.1:${server.port}` });

    try {
      // the four identical ambers arrive on the wire
      await waitFor(
        () => (received.filter((m) => m.t === "alert").length >= 4 ? true : undefined),
        3000,
        "the four cohort ambers",
      );
      const raises = received.filter((m): m is AlertMessage => m.t === "alert");
      expect(new Set(raises.map((m) => m.alert.message)).size).toBe(1);
      expect(raises.map((m) => m.alert.unitId).sort()).toEqual([
        "N-02",
        "N-04",
        "N-06",
        "N-08",
      ]);

      transport.send({ c: "ROLLBACK_COHORT", fw: "2.4.1" });
      const fleetEvents = () =>
        received.filter(
          (m): m is FleetCommandEventMessage => m.t === "fleet_command_event",
        );
      await waitFor(
        () => fleetEvents().find((m) => m.ev.k === "accepted"),
        2000,
        "accepted fleet_command_event",
      );

      // a client joining mid-rollback: snapshot (some units already restored),
      // the still-active alerts, then the replayed fleet lifecycle so far
      const late: FleetMessage[] = [];
      lateTransport.connect((msg) => late.push(msg));
      await waitFor(
        () => late.find((m) => m.t === "fleet_command_event"),
        2000,
        "replayed fleet_command_events on connect",
      );
      expect(late[0]!.t).toBe("fleet_snapshot");
      const lateFleetEvents = late.filter(
        (m): m is FleetCommandEventMessage => m.t === "fleet_command_event",
      );
      expect(lateFleetEvents[0]!.ev.k).toBe("accepted");
      expect(lateFleetEvents.map((m) => m.seq)).toEqual(
        fleetEvents()
          .slice(0, lateFleetEvents.length)
          .map((m) => m.seq),
      );

      // the staged restoration finishes on both connections
      await waitFor(
        () => fleetEvents().find((m) => m.ev.k === "complete"),
        6000,
        "rollback complete",
      );
      const clears = received.filter((m) => m.t === "alert_clear");
      expect(clears).toHaveLength(4);
      expect(clears.every((m) => m.t === "alert_clear" && m.via === "rollback")).toBe(
        true,
      );
      await waitFor(
        () =>
          late.find(
            (m): m is FleetCommandEventMessage =>
              m.t === "fleet_command_event" && m.ev.k === "complete",
          ),
        3000,
        "late client sees the complete",
      );
    } finally {
      lateTransport.disconnect();
      transport.disconnect();
      await server.close();
    }
  });
});
