// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  type CommandEventMessage,
  type ExecutedCommand,
  type FleetCommand,
  type FleetCommandEventMessage,
} from "@/lib/schema";
import { FLEET_AUDIT_SCOPE, useAuditStore } from "./auditStore";
import {
  selectFleetCommand,
  selectUnitCommand,
  selectUnitLiveCommand,
  useCommandStore,
} from "./commandStore";

const SIT = "COMMAND_SAFE_SIT" as const;
const RECAL = "RECALIBRATE_JOINT" as const;

const ev = (
  unitId: string,
  seq: number,
  e: CommandEventMessage["ev"],
  ts = seq * 100,
  cmd: ExecutedCommand = SIT,
): CommandEventMessage => ({
  t: "command_event",
  unitId,
  cmd,
  seq,
  ts,
  ev: e,
});

const fleetEv = (
  cmd: FleetCommand,
  seq: number,
  e: CommandEventMessage["ev"],
  fw: string | undefined = "2.4.1",
  ts = seq * 100,
): FleetCommandEventMessage => ({
  t: "fleet_command_event",
  cmd,
  ...(fw !== undefined ? { fw } : {}),
  seq,
  ts,
  ev: e,
});

beforeEach(() => {
  useCommandStore.getState().reset();
  useAuditStore.getState().reset();
});

describe("command store — the per-unit state machine", () => {
  it("walks accepted → progress → complete, carrying pct and the latest note", () => {
    const s = () => useCommandStore.getState();
    s().applyCommandEvent(ev("N-07", 1, { k: "accepted" }));
    expect(selectUnitCommand("N-07", SIT)(s())).toMatchObject({
      cmd: "COMMAND_SAFE_SIT",
      phase: "pending",
      pct: 0,
      note: null,
      seq: 1,
      updatedAt: 100,
    });

    s().applyCommandEvent(
      ev("N-07", 2, { k: "progress", pct: 20, note: "GAIT ARRESTED" }),
    );
    s().applyCommandEvent(
      ev("N-07", 3, { k: "progress", pct: 70, note: "TORQUE RAMP-DOWN" }),
    );
    expect(selectUnitCommand("N-07", SIT)(s())).toMatchObject({
      phase: "progress",
      pct: 70,
      note: "TORQUE RAMP-DOWN",
    });

    s().applyCommandEvent(ev("N-07", 4, { k: "complete" }));
    expect(selectUnitCommand("N-07", SIT)(s())).toMatchObject({
      phase: "complete",
      pct: 100,
      note: "TORQUE RAMP-DOWN", // the last thing the machine said stays visible
      seq: 4,
    });
  });

  it("lands failed with the verbatim machine reason", () => {
    const s = () => useCommandStore.getState();
    s().applyCommandEvent(ev("N-07", 1, { k: "failed", reason: "ALREADY SITTING" }));
    expect(selectUnitCommand("N-07", SIT)(s())).toMatchObject({
      phase: "failed",
      reason: "ALREADY SITTING",
    });
  });

  it("drops out-of-order and replayed events: seq is the authority (README policy)", () => {
    const s = () => useCommandStore.getState();
    s().applyCommandEvent(ev("N-07", 1, { k: "accepted" }));
    s().applyCommandEvent(
      ev("N-07", 3, { k: "progress", pct: 45, note: "CROUCH PHASE" }),
    );
    const before = selectUnitCommand("N-07", SIT)(s());

    s().applyCommandEvent(
      ev("N-07", 2, { k: "progress", pct: 20, note: "GAIT ARRESTED" }),
    );
    s().applyCommandEvent(
      ev("N-07", 3, { k: "progress", pct: 45, note: "CROUCH PHASE" }),
    );
    expect(selectUnitCommand("N-07", SIT)(useCommandStore.getState())).toBe(before); // identity: zero re-renders

    // units gate independently
    s().applyCommandEvent(ev("N-03", 2, { k: "accepted" }));
    expect(selectUnitCommand("N-03", SIT)(s())).toMatchObject({ phase: "pending" });
  });

  it("lets a re-issued command (higher seq) replace a terminal state", () => {
    const s = () => useCommandStore.getState();
    s().applyCommandEvent(ev("N-07", 1, { k: "failed", reason: "SCAN IN PROGRESS" }));
    s().applyCommandEvent(ev("N-07", 2, { k: "accepted" }));
    expect(selectUnitCommand("N-07", SIT)(s())).toMatchObject({
      phase: "pending",
      seq: 2,
    });
  });

  it("clears on snapshot (world restated) and rebuilds from the host's replay", () => {
    const s = () => useCommandStore.getState();
    s().applyCommandEvent(ev("N-07", 1, { k: "accepted" }));
    s().applyCommandEvent(
      ev("N-07", 2, { k: "progress", pct: 20, note: "GAIT ARRESTED" }),
    );
    s().applySnapshot();
    expect(selectUnitCommand("N-07", SIT)(s())).toBeUndefined();

    // reconnect replay re-sends the emitted prefix — seqs the session already
    // saw must apply again, because the snapshot cleared the gate with the state
    s().applyCommandEvent(ev("N-07", 1, { k: "accepted" }));
    s().applyCommandEvent(
      ev("N-07", 2, { k: "progress", pct: 20, note: "GAIT ARRESTED" }),
    );
    expect(selectUnitCommand("N-07", SIT)(s())).toMatchObject({
      phase: "progress",
      pct: 20,
    });
  });

  it("dismisses only terminal commands", () => {
    const s = () => useCommandStore.getState();
    s().applyCommandEvent(ev("N-07", 1, { k: "accepted" }));
    s().dismissCommand("N-07", SIT);
    expect(selectUnitCommand("N-07", SIT)(s())).toBeDefined(); // mid-flight: not dismissable

    s().applyCommandEvent(ev("N-07", 2, { k: "complete" }));
    s().dismissCommand("N-07", SIT);
    expect(selectUnitCommand("N-07", SIT)(s())).toBeUndefined();
  });
});

/**
 * Two executed commands share a unit, and for one release they shared
 * its slot. These are the two ways that lost — both reachable in the demo, both
 * with a robot on the floor at the end of them.
 */
describe("command store — two commands, one unit", () => {
  const s = () => useCommandStore.getState();

  /**
   * The sim allocates every beat of an accepted maneuver at accept time
   * (sim/engine.ts), so seqs interleave in ISSUE order and arrive in CLOCK
   * order. A recalibration pressed after the settle beat is refused at once
   * with a seq the sit's own `complete` — still two seconds out — is below.
   */
  it("does not let one command's refusal swallow the other's completion", () => {
    s().applyCommandEvent(ev("N-07", 1, { k: "accepted" }, 1000));
    s().applyCommandEvent(
      ev("N-07", 5, { k: "progress", pct: 90, note: "POSTURE SETTLED" }, 3000),
    );
    // Posture reads `sitting` at the settle beat, so RECALIBRATE is pressable
    // and the sim answers SIT IN PROGRESS — issued later, seq 7, ts 3100.
    s().applyCommandEvent(
      ev("N-07", 7, { k: "failed", reason: "SIT IN PROGRESS" }, 3100, RECAL),
    );
    // The sit's complete, allocated at accept time: LOWER seq, LATER clock.
    s().applyCommandEvent(ev("N-07", 6, { k: "complete" }, 5000));

    expect(selectUnitCommand("N-07", SIT)(s())).toMatchObject({
      phase: "complete",
      pct: 100,
    });
    expect(selectUnitCommand("N-07", RECAL)(s())).toMatchObject({
      phase: "failed",
      reason: "SIT IN PROGRESS",
    });
    // The receipt the operator's incident is filed against: a robot that is in
    // fact sitting must have a `command-complete` on the audit trail.
    const entries = useAuditStore.getState().entries;
    expect(entries.filter((e) => e.kind === "command-complete")).toHaveLength(1);
    expect(entries.find((e) => e.kind === "command-complete")).toMatchObject({
      summary: "SAFE SIT complete",
      ref: "COMMAND_SAFE_SIT#6",
    });
  });

  it("keeps each command's receipt until its own DISMISS", () => {
    s().applyCommandEvent(ev("N-07", 1, { k: "accepted" }));
    s().applyCommandEvent(ev("N-07", 2, { k: "complete" }));
    // The next rung on the ladder, on the same robot, while the sit's receipt
    // is still on screen with a DISMISS under it.
    s().applyCommandEvent(ev("N-07", 3, { k: "accepted" }, 300, RECAL));

    expect(selectUnitCommand("N-07", SIT)(s())).toMatchObject({ phase: "complete" });
    expect(selectUnitCommand("N-07", RECAL)(s())).toMatchObject({ phase: "pending" });

    s().dismissCommand("N-07", SIT);
    expect(selectUnitCommand("N-07", SIT)(s())).toBeUndefined();
    expect(selectUnitCommand("N-07", RECAL)(s())).toBeDefined(); // untouched
  });

  it("narrates the live command in the status rule, then the machine's last word", () => {
    // Nothing on file, nothing to say.
    expect(selectUnitLiveCommand("N-07")(s())).toBeUndefined();

    s().applyCommandEvent(ev("N-07", 1, { k: "accepted" }, 1000));
    s().applyCommandEvent(
      ev("N-07", 5, { k: "progress", pct: 90, note: "POSTURE SETTLED" }, 3000),
    );
    s().applyCommandEvent(
      ev("N-07", 7, { k: "failed", reason: "SIT IN PROGRESS" }, 3100, RECAL),
    );
    // A refusal does not take the rule off a maneuver the robot is performing.
    expect(selectUnitLiveCommand("N-07")(s())).toMatchObject({
      cmd: SIT,
      phase: "progress",
    });

    s().applyCommandEvent(ev("N-07", 6, { k: "complete" }, 5000));
    // Both terminal now: the rule says the later EVENT, not the higher seq —
    // seq is allocation order, and the completion happened last.
    expect(selectUnitLiveCommand("N-07")(s())).toMatchObject({
      cmd: SIT,
      phase: "complete",
    });

    // And it minds its own unit.
    expect(selectUnitLiveCommand("N-03")(s())).toBeUndefined();
  });
});

describe("command store — audit trail", () => {
  it("logs accepted, complete, and failed — never progress", () => {
    const s = () => useCommandStore.getState();
    s().applyCommandEvent(ev("N-07", 1, { k: "accepted" }));
    s().applyCommandEvent(
      ev("N-07", 2, { k: "progress", pct: 20, note: "GAIT ARRESTED" }),
    );
    s().applyCommandEvent(
      ev("N-07", 3, { k: "progress", pct: 90, note: "POSTURE SETTLED" }),
    );
    s().applyCommandEvent(ev("N-07", 4, { k: "complete" }));
    s().applyCommandEvent(ev("N-03", 5, { k: "failed", reason: "ALREADY SITTING" }));

    const entries = useAuditStore.getState().entries;
    expect(entries.map((e) => e.kind)).toEqual([
      "command-failed",
      "command-complete",
      "command-accepted",
    ]);
    expect(entries.map((e) => e.unitId)).toEqual(["N-03", "N-07", "N-07"]);
    expect(entries[0]).toMatchObject({
      summary: "SAFE SIT failed: ALREADY SITTING",
      ref: "COMMAND_SAFE_SIT#5",
      ts: 500,
    });
    expect(entries[1]!.summary).toBe("SAFE SIT complete");
    expect(entries[2]!.summary).toBe("SAFE SIT accepted");
  });

  it("does not double-log a replayed lifecycle after a snapshot cleared the gates", () => {
    const s = () => useCommandStore.getState();
    s().applyCommandEvent(ev("N-07", 1, { k: "accepted" }));
    s().applySnapshot();
    s().applyCommandEvent(ev("N-07", 1, { k: "accepted" })); // host replay
    const entries = useAuditStore.getState().entries;
    expect(entries.filter((e) => e.kind === "command-accepted")).toHaveLength(1);
  });
});

describe("command store — the fleet slice", () => {
  it("walks a staged rollback: accepted → per-unit notes → complete, keyed by command name", () => {
    const s = () => useCommandStore.getState();
    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 1, { k: "accepted" }));
    expect(selectFleetCommand("ROLLBACK_COHORT")(s())).toMatchObject({
      cmd: "ROLLBACK_COHORT",
      fw: "2.4.1",
      phase: "pending",
      pct: 0,
      seq: 1,
    });

    s().applyFleetCommandEvent(
      fleetEv("ROLLBACK_COHORT", 2, {
        k: "progress",
        pct: 0,
        note: "ROLLING BACK N-02 2.4.1->2.3.7",
      }),
    );
    s().applyFleetCommandEvent(
      fleetEv("ROLLBACK_COHORT", 3, {
        k: "progress",
        pct: 25,
        note: "ROLLING BACK N-04 2.4.1->2.3.7",
      }),
    );
    expect(selectFleetCommand("ROLLBACK_COHORT")(s())).toMatchObject({
      phase: "progress",
      pct: 25,
      note: "ROLLING BACK N-04 2.4.1->2.3.7",
    });

    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 4, { k: "complete" }));
    expect(selectFleetCommand("ROLLBACK_COHORT")(s())).toMatchObject({
      phase: "complete",
      pct: 100,
      note: "ROLLING BACK N-04 2.4.1->2.3.7", // the last narration stays visible
    });
  });

  it("keeps command lifecycles separate: a HALT refusal cannot clobber the running rollback", () => {
    const s = () => useCommandStore.getState();
    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 1, { k: "accepted" }));
    s().applyFleetCommandEvent(
      fleetEv("HALT_ROLLOUT", 2, { k: "failed", reason: "NO ROLLOUT ACTIVE" }),
    );
    expect(selectFleetCommand("ROLLBACK_COHORT")(s())).toMatchObject({
      phase: "pending",
    });
    expect(selectFleetCommand("HALT_ROLLOUT")(s())).toMatchObject({
      phase: "failed",
      reason: "NO ROLLOUT ACTIVE",
    });
  });

  it("drops stale and replayed fleet events by seq, per entry", () => {
    const s = () => useCommandStore.getState();
    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 5, { k: "accepted" }));
    const before = selectFleetCommand("ROLLBACK_COHORT")(s());
    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 5, { k: "accepted" }));
    s().applyFleetCommandEvent(
      fleetEv("ROLLBACK_COHORT", 4, { k: "progress", pct: 0, note: "STALE" }),
    );
    expect(selectFleetCommand("ROLLBACK_COHORT")(useCommandStore.getState())).toBe(
      before,
    );
  });

  it("clears on snapshot and rebuilds from the host's replay; dismisses only terminal lifecycles", () => {
    const s = () => useCommandStore.getState();
    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 1, { k: "accepted" }));
    s().applySnapshot();
    expect(selectFleetCommand("ROLLBACK_COHORT")(s())).toBeUndefined();

    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 1, { k: "accepted" }));
    expect(selectFleetCommand("ROLLBACK_COHORT")(s())).toMatchObject({ seq: 1 });

    s().dismissFleetCommand("ROLLBACK_COHORT");
    expect(selectFleetCommand("ROLLBACK_COHORT")(s())).toBeDefined(); // mid-flight

    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 2, { k: "complete" }));
    s().dismissFleetCommand("ROLLBACK_COHORT");
    expect(selectFleetCommand("ROLLBACK_COHORT")(s())).toBeUndefined();
  });

  it("audits the Phase 11 kinds: rollback-started/complete, rollout-halted (the receipt note), command-failed", () => {
    const s = () => useCommandStore.getState();
    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 1, { k: "accepted" }));
    s().applyFleetCommandEvent(
      fleetEv("ROLLBACK_COHORT", 2, {
        k: "progress",
        pct: 0,
        note: "ROLLING BACK N-02 2.4.1->2.3.7",
      }),
    );
    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 3, { k: "complete" }));

    s().applyFleetCommandEvent(fleetEv("HALT_ROLLOUT", 4, { k: "accepted" }));
    s().applyFleetCommandEvent(
      fleetEv("HALT_ROLLOUT", 5, {
        k: "progress",
        pct: 100,
        note: "ROLLOUT HALTED — N-05 REMAINS ON 2.3.7",
      }),
    );
    s().applyFleetCommandEvent(fleetEv("HALT_ROLLOUT", 6, { k: "complete" }));

    s().applyFleetCommandEvent(
      fleetEv("ROLLBACK_COHORT", 7, { k: "failed", reason: "ROLLBACK IN PROGRESS" }),
    );

    const entries = useAuditStore.getState().entries; // newest first
    expect(entries.map((e) => e.kind)).toEqual([
      "command-failed",
      "rollout-halted",
      "rollback-complete",
      "rollback-started",
    ]);
    expect(entries.every((e) => e.unitId === FLEET_AUDIT_SCOPE)).toBe(true);
    expect(entries[0]).toMatchObject({
      summary: "ROLLBACK COHORT failed: ROLLBACK IN PROGRESS",
      ref: "ROLLBACK_COHORT#7",
    });
    // the halt's audit line IS the engine's receipt, verbatim
    expect(entries[1]).toMatchObject({
      summary: "ROLLOUT HALTED — N-05 REMAINS ON 2.3.7",
      ref: "HALT_ROLLOUT#6",
    });
    expect(entries[2]!.summary).toBe("Staged rollback of 2.4.1 complete");
    expect(entries[3]!.summary).toBe("Staged rollback of 2.4.1 started");
    // progress beats are narration, not record: no entries beyond these four
    expect(entries).toHaveLength(4);
  });

  it("does not double-log a replayed rollback lifecycle after a snapshot", () => {
    const s = () => useCommandStore.getState();
    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 1, { k: "accepted" }));
    s().applySnapshot();
    s().applyFleetCommandEvent(fleetEv("ROLLBACK_COHORT", 1, { k: "accepted" })); // replay
    const entries = useAuditStore.getState().entries;
    expect(entries.filter((e) => e.kind === "rollback-started")).toHaveLength(1);
  });
});
