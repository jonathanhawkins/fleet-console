// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { type FleetMessage, type OperatorCommand } from "@/lib/schema";
import {
  type ConnectionStatus,
  type ConnectionStatusSource,
  type TelemetryTransport,
} from "@/lib/transport/types";
import { useAuditStore } from "./auditStore";
import { bindTransport } from "./bindTransport";
import { resetCohortDerivation } from "./cohortStore";
import { commandKey, useCommandStore } from "./commandStore";
import { useFleetStore } from "./fleetStore";
import { useIncidentStore } from "./incidentStore";
import { getUnitTelemetryVersion } from "./telemetryChannel";

/** The per-unit slice is keyed by (unit, command) since */
const SIT_KEY = commandKey("N-07", "COMMAND_SAFE_SIT");

class FakeTransport implements TelemetryTransport, ConnectionStatusSource {
  onMessage: ((msg: FleetMessage) => void) | null = null;
  sent: OperatorCommand[] = [];
  disconnected = false;
  private status: ConnectionStatus = "idle";
  private listeners = new Set<(s: ConnectionStatus) => void>();

  connect(onMessage: (msg: FleetMessage) => void): void {
    this.onMessage = onMessage;
  }
  send(cmd: OperatorCommand): void {
    this.sent.push(cmd);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  getStatus(): ConnectionStatus {
    return this.status;
  }
  onStatus(listener: (s: ConnectionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setStatus(s: ConnectionStatus): void {
    this.status = s;
    for (const l of this.listeners) l(s);
  }
}

beforeEach(() => {
  useFleetStore.getState().reset();
  useIncidentStore.getState().reset();
  useCommandStore.getState().reset();
  useAuditStore.getState().reset();
  resetCohortDerivation();
});

describe("bindTransport", () => {
  it("routes each message kind to the right store and mirrors connection status", () => {
    const transport = new FakeTransport();
    const unbind = bindTransport(transport);

    transport.setStatus("open");
    expect(useFleetStore.getState().connection).toBe("open");

    transport.onMessage!({
      t: "fleet_snapshot",
      units: [
        {
          id: "N-07",
          name: "Sagebrush House",
          status: "nominal",
          battery: 70,
          pos: { lat: 44, lng: -121 },
        },
      ],
    });
    expect(useFleetStore.getState().unitIds).toEqual(["N-07"]);

    transport.onMessage!({
      t: "telemetry",
      unitId: "N-07",
      ts: 100,
      batch: [{ joint: "knee_L", tempC: 33, torqueNm: 12, currentA: 1.5, battery: 70 }],
    });
    expect(getUnitTelemetryVersion("N-07")).toBe(1);

    transport.onMessage!({
      t: "alert",
      alert: { id: "al-001", unitId: "N-07", severity: "amber", message: "hot", ts: 1 },
    });
    expect(useFleetStore.getState().alerts).toHaveLength(1);

    transport.onMessage!({
      t: "unit_update",
      unit: {
        id: "N-07",
        name: "Sagebrush House",
        status: "amber",
        battery: 70,
        pos: { lat: 44, lng: -121 },
        posture: "sitting",
      },
    });
    expect(useFleetStore.getState().units["N-07"]?.posture).toBe("sitting");

    useIncidentStore.getState().beginDescent("N-07");
    transport.onMessage!({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    expect(useIncidentStore.getState().phase).toBe("scanning");

    transport.onMessage!({
      t: "command_event",
      unitId: "N-07",
      cmd: "COMMAND_SAFE_SIT",
      seq: 1,
      ts: 200,
      ev: { k: "accepted" },
    });
    expect(useCommandStore.getState().commands[SIT_KEY]).toMatchObject({
      phase: "pending",
    });

    unbind();
    expect(transport.disconnected).toBe(true);
    transport.setStatus("closed");
    expect(useFleetStore.getState().connection).toBe("open"); // detached after unbind
  });

  it("works with a transport that has no status source", () => {
    const bare: TelemetryTransport = {
      connect: () => {},
      send: () => {},
      disconnect: () => {},
    };
    const unbind = bindTransport(bare);
    expect(useFleetStore.getState().connection).toBe("idle");
    unbind();
  });

  it("a live client sees the sit settle without reconnecting, and RESET stands it back up", () => {
    const transport = new FakeTransport();
    const unbind = bindTransport(transport);
    const unit = {
      id: "N-07",
      name: "Sagebrush House",
      status: "red",
      battery: 70,
      pos: { lat: 44, lng: -121 },
    } as const;

    // connect: the greeting snapshot says walking
    transport.onMessage!({
      t: "fleet_snapshot",
      units: [{ ...unit, posture: "walking" }],
    });
    expect(useFleetStore.getState().units["N-07"]?.posture).toBe("walking");

    // the settle beat's unit_update lands on the SAME connection (// this is the statement that used to exist only in the next snapshot)
    transport.onMessage!({ t: "unit_update", unit: { ...unit, posture: "sitting" } });
    expect(useFleetStore.getState().units["N-07"]?.posture).toBe("sitting");

    // RESET_SIM's snapshot restates the world: the unit stands back up
    transport.onMessage!({
      t: "fleet_snapshot",
      units: [{ ...unit, status: "nominal", posture: "walking" }],
    });
    expect(useFleetStore.getState().units["N-07"]?.posture).toBe("walking");
    unbind();
  });

  it("routes alert_clear to the alert lifecycle: resolved via self-recovery, audited once", () => {
    const transport = new FakeTransport();
    const unbind = bindTransport(transport);

    transport.onMessage!({
      t: "alert",
      alert: {
        id: "al-002",
        unitId: "N-03",
        severity: "amber",
        message: "Mill Street: navigation blocked — replanning around obstruction",
        ts: 120_000,
      },
    });
    expect(useFleetStore.getState().alertMeta["al-002"]).toBeUndefined();
    expect(useFleetStore.getState().kpiAlerts).toBe(1); // N-03 is alerting

    transport.onMessage!({
      t: "alert_clear",
      alertId: "al-002",
      unitId: "N-03",
      via: "self-recovery",
      ts: 160_000,
    });

    // The alert STAYS in the feed; the lifecycle metadata marks it resolved,
    // exactly as an operator's resolution would — authored by the robot.
    expect(useFleetStore.getState().alerts).toHaveLength(1);
    // ... and the header KPI stopped counting the unit the moment the robot
    // cleared its own alert (the alert_clear path recomputes too).
    expect(useFleetStore.getState().kpiAlerts).toBe(0);
    const meta = useFleetStore.getState().alertMeta["al-002"];
    expect(meta?.resolution).toEqual({ via: "self-recovery" });
    expect(meta?.resolvedAt).toBeDefined();

    // Audited in the robot's favor, once (resolveAlert is idempotent).
    transport.onMessage!({
      t: "alert_clear",
      alertId: "al-002",
      unitId: "N-03",
      via: "self-recovery",
      ts: 160_001,
    });
    const resolutions = useAuditStore
      .getState()
      .entries.filter((e) => e.kind === "resolution");
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      unitId: "N-03",
      summary: "Resolved — self-recovered",
      ref: "al-002",
    });
    unbind();
  });

  it("drops an alert_clear for an alert the feed does not hold — nothing to resolve", () => {
    const transport = new FakeTransport();
    const unbind = bindTransport(transport);
    transport.onMessage!({
      t: "alert_clear",
      alertId: "al-999",
      unitId: "N-03",
      via: "self-recovery",
      ts: 1,
    });
    expect(useFleetStore.getState().alertMeta["al-999"]).toBeUndefined();
    expect(useAuditStore.getState().entries).toHaveLength(0);
    unbind();
  });

  it("routes fleet_command_events to the command store's fleet slice", () => {
    const transport = new FakeTransport();
    const unbind = bindTransport(transport);

    transport.onMessage!({
      t: "fleet_command_event",
      cmd: "ROLLBACK_COHORT",
      fw: "2.4.1",
      seq: 7,
      ts: 300,
      ev: { k: "accepted" },
    });
    expect(useCommandStore.getState().fleetCommands["ROLLBACK_COHORT"]).toMatchObject({
      phase: "pending",
      fw: "2.4.1",
      seq: 7,
    });
    // and the snapshot restates the fleet slice with the per-unit one
    transport.onMessage!({ t: "fleet_snapshot", units: [] });
    expect(useCommandStore.getState().fleetCommands).toEqual({});
    unbind();
  });

  it("routes a rollback alert_clear through the same lifecycle: resolved via rollback, audited once", () => {
    const transport = new FakeTransport();
    const unbind = bindTransport(transport);

    transport.onMessage!({
      t: "alert",
      alert: {
        id: "al-010",
        unitId: "N-02",
        severity: "amber",
        message: "Balance reflex latency above threshold",
        ts: 180_000,
      },
    });
    transport.onMessage!({
      t: "alert_clear",
      alertId: "al-010",
      unitId: "N-02",
      via: "rollback",
      ts: 200_000,
    });

    const meta = useFleetStore.getState().alertMeta["al-010"];
    expect(meta?.resolution).toEqual({ via: "rollback" });
    const resolutions = useAuditStore
      .getState()
      .entries.filter((e) => e.kind === "resolution");
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      unitId: "N-02",
      summary: "Resolved — firmware rolled back",
      ref: "al-010",
    });
    unbind();
  });

  it("runs cohort detection on the alert path: the third identical raise audits cohort-detected once", () => {
    const transport = new FakeTransport();
    const unbind = bindTransport(transport);
    const fwUnit = (id: string) => ({
      id,
      name: `House ${id}`,
      status: "nominal" as const,
      battery: 70,
      pos: { lat: 44, lng: -121 },
      fw: "2.4.1",
    });
    transport.onMessage!({
      t: "fleet_snapshot",
      units: [fwUnit("N-02"), fwUnit("N-04"), fwUnit("N-06")],
    });

    const signature = "Balance reflex latency above threshold";
    const raise = (id: string, unitId: string, ts: number) =>
      transport.onMessage!({
        t: "alert",
        alert: { id, unitId, severity: "amber", message: signature, ts },
      });
    raise("al-020", "N-02", 1_000);
    raise("al-021", "N-04", 1_200);
    const detected = () =>
      useAuditStore.getState().entries.filter((e) => e.kind === "cohort-detected");
    expect(detected()).toHaveLength(0); // two is a coincidence, not a cohort

    raise("al-022", "N-06", 1_400);
    expect(detected()).toHaveLength(1);
    expect(detected()[0]).toMatchObject({ unitId: "fleet", ts: 1_400 });

    raise("al-023", "N-02", 1_600); // growth re-checks but never re-logs
    expect(detected()).toHaveLength(1);
    unbind();
  });

  it("a fleet_snapshot restates the command slice too, ready for the host's replay", () => {
    const transport = new FakeTransport();
    const unbind = bindTransport(transport);

    transport.onMessage!({
      t: "command_event",
      unitId: "N-07",
      cmd: "COMMAND_SAFE_SIT",
      seq: 3,
      ts: 200,
      ev: { k: "accepted" },
    });
    expect(useCommandStore.getState().commands[SIT_KEY]).toBeDefined();

    transport.onMessage!({ t: "fleet_snapshot", units: [] });
    expect(useCommandStore.getState().commands).toEqual({});

    // the replayed in-flight prefix (same seqs) must apply on the fresh slice
    transport.onMessage!({
      t: "command_event",
      unitId: "N-07",
      cmd: "COMMAND_SAFE_SIT",
      seq: 3,
      ts: 200,
      ev: { k: "accepted" },
    });
    expect(useCommandStore.getState().commands[SIT_KEY]).toMatchObject({
      phase: "pending",
      seq: 3,
    });
    unbind();
  });
});
