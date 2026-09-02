// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fleetMessageSchema,
  type AlertMessage,
  type DiagEventMessage,
  type FleetMessage,
} from "@/lib/schema";
import { WsTransport } from "@/lib/transport/wsTransport";
import { startSimServer, type SimServer } from "./server";
import { type DiagTimeline } from "./engine";

/**
 *, the wire half: a client that connects (or reconnects) mid-scan is
 * greeted with snapshot, alerts, then the scan-so-far diag_events — so the
 * incident store adopts the in-flight scan and the descent resumes coherently.
 * Ephemeral port (0) always: 8791 belongs to the live dev sim server.
 */

const TIMELINE = { onsetMs: 200, amberAtMs: 400, redAtMs: 600 };
/** Scan compressed to 2.4 s: walks 80..650, channels 800..1800 (knee_L 1200), flag 1260, verdict 2400. */
const DIAG: DiagTimeline = {
  walkStartMs: 80,
  walkStepMs: 30,
  channelStartMs: 800,
  channelStepMs: 200,
  flagDelayMs: 60,
  verdictAtMs: 2400,
};

const isDiag = (m: FleetMessage): m is DiagEventMessage => m.t === "diag_event";
const isAlert = (m: FleetMessage): m is AlertMessage => m.t === "alert";

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

describe("sim server — mid-scan reconnect replays the scan so far", () => {
  let server: SimServer;
  const transports: WsTransport[] = [];

  const connect = (received: FleetMessage[]): WsTransport => {
    const transport = new WsTransport({ url: `ws://127.0.0.1:${server.port}` });
    transport.connect((msg) => received.push(msg));
    transports.push(transport);
    return transport;
  };

  beforeAll(async () => {
    server = await startSimServer({
      port: 0, // NEVER the live dev sim port (8791) in tests
      timeline: TIMELINE,
      diagTimeline: DIAG,
      tickMs: 20,
      log: () => {},
    });
  });

  afterAll(async () => {
    for (const t of transports) t.disconnect();
    await server.close();
  });

  it(
    "greets a mid-scan joiner with snapshot, alerts, then the diag prefix; both clients end with identical streams",
    { timeout: 15_000 },
    async () => {
      const a: FleetMessage[] = [];
      const transportA = connect(a);

      // let the incident go red, then start the scan
      await waitFor(
        () => a.find((m) => isAlert(m) && m.alert.severity === "red"),
        5000,
        "red alert",
      );
      transportA.send({ c: "RUN_DIAGNOSTIC", unitId: "N-07" });

      // wait until the scan is visibly mid-flight (two channel events out)
      await waitFor(
        () =>
          a.filter((m) => isDiag(m) && m.ev.k === "channel").length >= 2
            ? true
            : undefined,
        5000,
        "two channel events on client A",
      );

      // B joins mid-scan
      const b: FleetMessage[] = [];
      connect(b);
      await waitFor(
        () => (b.some(isDiag) ? true : undefined),
        3000,
        "diag replay on client B",
      );

      // greeting order: snapshot first, both alerts before any diag event
      expect(b[0]!.t).toBe("fleet_snapshot");
      const firstDiagIdx = b.findIndex(isDiag);
      const alertsBefore = b.slice(0, firstDiagIdx).filter(isAlert);
      expect(alertsBefore.map((m) => m.alert.severity)).toEqual(["amber", "red"]);
      expect(b.slice(0, firstDiagIdx).filter(isDiag)).toHaveLength(0);
      const bDiagFirst = b[firstDiagIdx]!;
      expect(isDiag(bDiagFirst) && bDiagFirst.ev.k).toBe("scan_start");

      // both clients ride the scan to the verdict
      const verdictOn = (xs: FleetMessage[]) =>
        xs.some((m) => isDiag(m) && m.ev.k === "verdict") ? true : undefined;
      await waitFor(() => verdictOn(a), 5000, "verdict on client A");
      await waitFor(() => verdictOn(b), 5000, "verdict on client B");

      // replay + live tail must equal the stream a from-the-start client saw
      const diagA = a.filter(isDiag);
      const diagB = b.filter(isDiag);
      expect(JSON.stringify(diagB)).toEqual(JSON.stringify(diagA));
      expect(diagA).toHaveLength(1 + 20 + 6 + 1 + 1); // scan_start, walks, channels, flag, verdict
      for (const m of diagA) expect(() => fleetMessageSchema.parse(m)).not.toThrow();

      const kinds = diagA.map((m) => m.ev.k);
      expect(kinds[0]).toBe("scan_start");
      expect(kinds.at(-1)).toBe("verdict");
      expect(kinds).toContain("flag");

      const verdict = diagA.at(-1)!.ev;
      if (verdict.k !== "verdict") throw new Error("last diag event is not the verdict");
      expect(verdict.report).toMatchObject({
        unitId: "N-07",
        joint: "knee_L",
        component: "actuator_A07",
        anomaly: "gain",
      });
    },
  );

  it("sends no diag replay to a client that connects after the verdict", async () => {
    const c: FleetMessage[] = [];
    connect(c);
    // wait for the greeting plus a couple of telemetry ticks to be sure
    await waitFor(
      () => (c.filter((m) => m.t === "telemetry").length >= 3 ? true : undefined),
      3000,
      "telemetry on client C",
    );
    expect(c[0]!.t).toBe("fleet_snapshot");
    expect(c.filter(isDiag)).toHaveLength(0); // the scan is over; nothing to adopt
  });
});
