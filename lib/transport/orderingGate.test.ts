// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type CommandEventMessage, type FleetMessage } from "@/lib/schema";
import { createOrderingGate } from "./orderingGate";

/**
 * (e): the out-of-order policy, enforced where both transports
 * deliver. Stale telemetry drops by per-unit ts; command_events order by seq;
 * a fleet_snapshot resets the gates so post-snapshot replays pass.
 */

const telemetry = (unitId: string, ts: number): FleetMessage => ({
  t: "telemetry",
  unitId,
  ts,
  batch: [{ joint: "knee_L", tempC: 33, torqueNm: 12, currentA: 1.5, battery: 70 }],
});

const commandEvent = (
  unitId: string,
  seq: number,
  ev: CommandEventMessage["ev"] = { k: "accepted" },
): FleetMessage => ({
  t: "command_event",
  unitId,
  cmd: "COMMAND_SAFE_SIT",
  seq,
  ts: seq * 100,
  ev,
});

const snapshot: FleetMessage = { t: "fleet_snapshot", units: [] };

function gateWithLog() {
  const passed: FleetMessage[] = [];
  const dropped: FleetMessage[] = [];
  const gate = createOrderingGate(
    (m) => passed.push(m),
    (m) => dropped.push(m),
  );
  return { gate, passed, dropped };
}

describe("createOrderingGate — telemetry", () => {
  it("passes strictly newer batches and drops ts <= last, per unit", () => {
    const { gate, passed, dropped } = gateWithLog();
    gate(telemetry("N-07", 100));
    gate(telemetry("N-07", 200));
    gate(telemetry("N-07", 200)); // duplicate ts: stale
    gate(telemetry("N-07", 150)); // older: stale
    gate(telemetry("N-07", 300));
    expect(passed.map((m) => (m.t === "telemetry" ? m.ts : -1))).toEqual([100, 200, 300]);
    expect(dropped).toHaveLength(2);
  });

  it("gates each unit independently", () => {
    const { gate, passed } = gateWithLog();
    gate(telemetry("N-07", 500));
    gate(telemetry("N-03", 100)); // older than N-07's, but N-03's first: passes
    gate(telemetry("N-03", 90)); // stale for N-03
    expect(passed).toHaveLength(2);
  });
});

describe("createOrderingGate — command_events", () => {
  it("orders by seq: drops seq <= last per unit, whatever the arrival order", () => {
    const { gate, passed, dropped } = gateWithLog();
    gate(commandEvent("N-07", 1));
    gate(commandEvent("N-07", 3, { k: "progress", pct: 45, note: "CROUCH PHASE" }));
    gate(commandEvent("N-07", 2, { k: "progress", pct: 20, note: "GAIT ARRESTED" })); // late: dropped
    gate(commandEvent("N-07", 1)); // duplicate: dropped
    gate(commandEvent("N-07", 4, { k: "complete" }));
    expect(passed.map((m) => (m.t === "command_event" ? m.seq : -1))).toEqual([1, 3, 4]);
    expect(dropped).toHaveLength(2);
  });

  it("does not let one unit's seqs gate another's", () => {
    const { gate, passed } = gateWithLog();
    gate(commandEvent("N-07", 5));
    gate(commandEvent("N-03", 1)); // its own lifecycle
    expect(passed).toHaveLength(2);
  });
});

describe("createOrderingGate — fleet_command_events", () => {
  const fleetEvent = (
    seq: number,
    ev: CommandEventMessage["ev"] = { k: "accepted" },
  ): FleetMessage => ({
    t: "fleet_command_event",
    cmd: "ROLLBACK_COHORT",
    fw: "2.4.1",
    seq,
    ts: seq * 100,
    ev,
  });

  it("orders the single fleet lane by seq: drops seq <= last, whatever the arrival order", () => {
    const { gate, passed, dropped } = gateWithLog();
    gate(fleetEvent(1));
    gate(
      fleetEvent(3, { k: "progress", pct: 25, note: "ROLLING BACK N-04 2.4.1->2.3.7" }),
    );
    gate(
      fleetEvent(2, { k: "progress", pct: 0, note: "ROLLING BACK N-02 2.4.1->2.3.7" }),
    ); // late
    gate(fleetEvent(1)); // duplicate
    gate(fleetEvent(4, { k: "complete" }));
    expect(passed.map((m) => (m.t === "fleet_command_event" ? m.seq : -1))).toEqual([
      1, 3, 4,
    ]);
    expect(dropped).toHaveLength(2);
  });

  it("keeps the fleet lane independent of every per-unit lane, and resets it on snapshot", () => {
    const { gate, passed, dropped } = gateWithLog();
    gate(commandEvent("N-07", 9)); // a unit deep into its own lifecycle
    gate(fleetEvent(2)); //           lower seq, different lane: passes
    gate(commandEvent("N-03", 1)); // and the fleet lane gates no unit
    expect(passed).toHaveLength(3);
    expect(dropped).toHaveLength(0);

    gate(snapshot); // reconnect: the host replays the in-flight rollback prefix
    gate(fleetEvent(2)); // the replayed accepted must pass
    expect(passed).toHaveLength(5);
    expect(dropped).toHaveLength(0);
  });
});

describe("createOrderingGate — snapshot reset and passthrough", () => {
  it("resets both gates on fleet_snapshot so post-snapshot replays pass", () => {
    const { gate, passed } = gateWithLog();
    gate(telemetry("N-07", 500));
    gate(commandEvent("N-07", 9));
    gate(snapshot); // reconnect / RESET_SIM: the world restates
    gate(telemetry("N-07", 400)); // would be stale pre-snapshot; now the new truth
    gate(commandEvent("N-07", 3)); // replayed in-flight sit prefix
    expect(passed).toHaveLength(5);
  });

  it("passes alerts and diag_events untouched (their reducers dedupe by identity)", () => {
    const { gate, passed, dropped } = gateWithLog();
    const alert: FleetMessage = {
      t: "alert",
      alert: { id: "al-001", unitId: "N-07", severity: "amber", message: "hot", ts: 1 },
    };
    const diag: FleetMessage = {
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "scan_start" },
    };
    gate(alert);
    gate(alert);
    gate(diag);
    expect(passed).toEqual([alert, alert, diag]);
    expect(dropped).toHaveLength(0);
  });

  it("passes unit_update untouched — around engaged gates, after snapshots, duplicates included", () => {
    const { gate, passed, dropped } = gateWithLog();
    const update: FleetMessage = {
      t: "unit_update",
      unit: {
        id: "N-03",
        name: "Mill Street",
        status: "nominal",
        battery: 70,
        pos: { lat: 44.05, lng: -121.31 },
        posture: "sitting",
      },
    };
    gate(telemetry("N-03", 500)); // engage the unit's telemetry gate
    gate(commandEvent("N-03", 9)); // and its command gate
    gate(update); //                the settle-beat restatement passes
    gate(update); //                a duplicate passes too (reducer is idempotent)
    gate(snapshot); //              and a snapshot does not start gating it
    gate(update);
    expect(passed.filter((m) => m.t === "unit_update")).toEqual([update, update, update]);
    expect(dropped).toHaveLength(0);
  });
});
