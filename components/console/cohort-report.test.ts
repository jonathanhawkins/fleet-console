import { describe, expect, it } from "vitest";
import { type Alert, type UnitSummary } from "@/lib/schema";
import {
  FLEET_AUDIT_SCOPE,
  type AlertMeta,
  type AuditEntry,
  type CohortIncident,
} from "@/lib/stores";
import {
  cohortActions,
  cohortLog,
  cohortSpans,
  cohortTimes,
  cohortUnits,
  haltRefusal,
  preventedUpdates,
  rollbackChronology,
} from "./cohort-report";

/**
 * The fleet report is a join, like the unit report's, and these tests pin the
 * same two properties: what it is allowed to conclude, and — harder here —
 * what it must refuse to conclude. The fleet incident's most important fact is
 * an update that did not happen, and the only honest evidence for it is the
 * halt's own receipt.
 */

const DETECTED = 1_700_000_180_000;
const HALTED = DETECTED + 22_000;
const ORDERED = DETECTED + 40_000;
const FW = "2.4.1";
const STABLE = "2.3.7";
const MEMBERS = ["N-02", "N-04", "N-06", "N-08"];

const cohort: CohortIncident = {
  id: `cohort-${FW}-${DETECTED}`,
  signature: "Balance reflex latency above threshold",
  fw: FW,
  unitIds: [...MEMBERS],
  alertIds: MEMBERS.map((_, i) => `al-${i + 1}`),
  detectedAt: DETECTED,
  canary: [
    { fw: FW, affected: 4, total: 4 },
    { fw: STABLE, affected: 0, total: 4 },
  ],
};

/** Raised on the 10 s stagger the sim uses, oldest first. */
const ALERTS: Alert[] = MEMBERS.map((unitId, i) => ({
  id: `al-${i + 1}`,
  unitId,
  severity: "amber" as const,
  message: cohort.signature,
  ts: DETECTED - 20_000 + i * 10_000,
}));

/** Every member cleared by the staged rollback, 4 s apart in roster order. */
const META: Record<string, AlertMeta> = Object.fromEntries(
  MEMBERS.map((_, i) => [
    `al-${i + 1}`,
    { resolvedAt: ORDERED + (i + 1) * 4_000, resolution: { via: "rollback" as const } },
  ]),
);

const unit = (id: string, fw: string): UnitSummary => ({
  id,
  name: `${id} House`,
  status: "amber",
  battery: 70,
  pos: { lat: 44, lng: -121 },
  fw,
});

/** After the rollback: every member back on the baseline. */
const RESTORED: Record<string, UnitSummary> = Object.fromEntries(
  MEMBERS.map((id) => [id, unit(id, STABLE)]),
);
/** Mid-incident: every member still on the suspect build. */
const AFFECTED: Record<string, UnitSummary> = Object.fromEntries(
  MEMBERS.map((id) => [id, unit(id, FW)]),
);

const fleetEntry = (
  id: string,
  ts: number,
  kind: AuditEntry["kind"],
  summary: string,
  ref?: string,
): AuditEntry => ({ id, ts, kind, unitId: FLEET_AUDIT_SCOPE, summary, ref });

/** Newest first, as the store keeps them. */
const LOG: AuditEntry[] = [
  fleetEntry("a5", ORDERED + 16_000, "rollback-complete", `Staged rollback of ${FW} complete`, "ROLLBACK_COHORT#4"),
  fleetEntry("a4", ORDERED, "rollback-started", `Staged rollback of ${FW} started`, "ROLLBACK_COHORT#3"),
  fleetEntry("a3", HALTED, "rollout-halted", `ROLLOUT HALTED — N-05 REMAINS ON ${STABLE}`, "HALT_ROLLOUT#2"),
  fleetEntry("a1", DETECTED, "cohort-detected", `Cohort detected — 4 units on ${FW}`, cohort.id),
];

describe("cohortUnits", () => {
  it("reads each member's raise and clear off its own alert", () => {
    const rows = cohortUnits(cohort, ALERTS, META, RESTORED);
    expect(rows.map((r) => r.unitId)).toEqual(MEMBERS);
    expect(rows[0]?.raised).toBe(DETECTED - 20_000);
    expect(rows[0]?.cleared).toBe(ORDERED + 4_000);
    expect(rows[0]?.openFor).toBe(ORDERED + 4_000 - (DETECTED - 20_000));
  });

  /**
   * The before/after pair is the point of the table: `fwBefore` is the cohort's
   * own build — that is what membership means — and `fwAfter` is read live, so
   * the column is a record of the remediation rather than a restatement of the
   * incident.
   */
  it("puts the suspect build against what the unit is running now", () => {
    const rows = cohortUnits(cohort, ALERTS, META, RESTORED);
    expect(rows.every((r) => r.fwBefore === FW)).toBe(true);
    expect(rows.every((r) => r.fwAfter === STABLE)).toBe(true);
    expect(rows.every((r) => r.restored)).toBe(true);
  });

  it("calls a unit still on the suspect build exactly that", () => {
    const rows = cohortUnits(cohort, ALERTS, {}, AFFECTED);
    expect(rows.every((r) => r.restored)).toBe(false);
    expect(rows[0]?.cleared).toBeUndefined();
    expect(rows[0]?.openFor).toBeUndefined();
  });

  it("leaves a member undated rather than inventing a time for it", () => {
    const rows = cohortUnits(cohort, [], {}, {});
    expect(rows).toHaveLength(4);
    expect(rows[0]?.raised).toBeUndefined();
    expect(rows[0]?.fwAfter).toBeUndefined();
    expect(rows[0]?.restored).toBe(false);
  });
});

describe("cohortTimes and cohortSpans", () => {
  it("dates every beat of the fleet incident from the journal that owns it", () => {
    const rows = cohortUnits(cohort, ALERTS, META, RESTORED);
    expect(cohortTimes(cohort, rows, LOG)).toEqual({
      detected: DETECTED,
      halted: HALTED,
      rollbackOrdered: ORDERED,
      firstRestored: ORDERED + 4_000,
      lastRestored: ORDERED + 16_000,
      completed: ORDERED + 16_000,
    });
  });

  it("measures containment and restoration, and never MTTA", () => {
    const rows = cohortUnits(cohort, ALERTS, META, RESTORED);
    const spans = cohortSpans(cohortTimes(cohort, rows, LOG));
    expect(spans.toContain).toBe(22_000);
    expect(spans.toOrder).toBe(40_000);
    expect(spans.rollbackRan).toBe(16_000);
    expect(spans.toRestore).toBe(56_000);
  });

  it("has no span where it has no end", () => {
    const rows = cohortUnits(cohort, ALERTS, {}, AFFECTED);
    const spans = cohortSpans(cohortTimes(cohort, rows, []));
    expect(spans).toEqual({
      toContain: undefined,
      toOrder: undefined,
      toRestore: undefined,
      rollbackRan: undefined,
    });
  });

});

describe("cohortLog", () => {
  /** A unit's own log is a different incident's record; only the fleet's counts. */
  it("reads only fleet-scoped entries", () => {
    const unitScoped: AuditEntry[] = [
      { id: "u1", ts: HALTED, kind: "rollout-halted", unitId: "N-02", summary: "x" },
      ...LOG,
    ];
    expect(cohortLog(unitScoped, DETECTED).some((e) => e.unitId === "N-02")).toBe(false);
  });

  /**
   * The session log survives RESET_SIM, so the storyline can be replayed — and
   * without the floor the second run's report would count the first run's halt
   * as its own save.
   */
  it("ignores fleet entries from before the detection it belongs to", () => {
    const stale = [
      ...LOG,
      fleetEntry("old", DETECTED - 60_000, "rollout-halted", "ROLLOUT HALTED — N-09 REMAINS ON 2.3.7"),
    ];
    const log = cohortLog(stale, DETECTED);
    expect(log.some((e) => e.summary.includes("N-09"))).toBe(false);
    expect(preventedUpdates(log).map((p) => p.unitId)).toEqual(["N-05"]);
  });
});

describe("rollbackChronology", () => {
  it("is the serial walk, with the cadence that makes it serial", () => {
    const rows = cohortUnits(cohort, ALERTS, META, RESTORED);
    const steps = rollbackChronology(rows, ORDERED);
    expect(steps.map((s) => s.unitId)).toEqual(MEMBERS);
    expect(steps.map((s) => s.sinceOrder)).toEqual([4_000, 8_000, 12_000, 16_000]);
    expect(steps.map((s) => s.sincePrevious)).toEqual([
      undefined,
      4_000,
      4_000,
      4_000,
    ]);
  });

  it("lists only the units that actually completed", () => {
    const partial: Record<string, AlertMeta> = {
      "al-1": META["al-1"]!,
      "al-2": META["al-2"]!,
    };
    const rows = cohortUnits(cohort, ALERTS, partial, RESTORED);
    expect(rollbackChronology(rows, ORDERED).map((s) => s.unitId)).toEqual([
      "N-02",
      "N-04",
    ]);
  });

  it("still lists the walk when no order is on file, without inventing offsets", () => {
    const rows = cohortUnits(cohort, ALERTS, META, RESTORED);
    const steps = rollbackChronology(rows, undefined);
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.sinceOrder === undefined)).toBe(true);
  });
});

describe("preventedUpdates", () => {
  /**
   * The whole section rests on this: a robot that did not install a build
   * leaves no alert, no command and no unit_update. The halt's receipt is the
   * only artefact, and it is read rather than reasoned from.
   */
  it("names the unit the halt spared, off the machine's own receipt", () => {
    expect(preventedUpdates(LOG)).toEqual([
      {
        unitId: "N-05",
        fw: STABLE,
        at: HALTED,
        // Carried, not rebuilt: the report quotes this line under a caption
        // naming who recorded it.
        note: `ROLLOUT HALTED — N-05 REMAINS ON ${STABLE}`,
      },
    ]);
  });

  it("claims no save where no halt landed", () => {
    expect(preventedUpdates(LOG.filter((e) => e.kind !== "rollout-halted"))).toEqual([]);
  });

  /**
   * A receipt this console does not recognise still prints in the log (the
   * carry-through rule) — but it yields no facts, so nothing is counted from a
   * sentence nobody parsed.
   */
  it("counts nothing from a receipt it cannot read", () => {
    const odd = [
      fleetEntry("a3", HALTED, "rollout-halted", "ROLLOUT HALTED"),
      ...LOG.filter((e) => e.kind !== "rollout-halted"),
    ];
    expect(preventedUpdates(odd)).toEqual([]);
  });

  it("names a unit once, however often the receipt is restated", () => {
    const twice = [
      fleetEntry("a3b", HALTED + 5, "rollout-halted", `ROLLOUT HALTED — N-05 REMAINS ON ${STABLE}`),
      ...LOG,
    ];
    expect(preventedUpdates(twice)).toHaveLength(1);
  });
});

describe("haltRefusal", () => {
  /** The storyline's other ending: the operator who reached for HALT too late. */
  it("carries the fleet's refusal verbatim", () => {
    const refused = [
      fleetEntry("r1", HALTED, "command-failed", "HALT ROLLOUT failed: NO ROLLOUT ACTIVE", "HALT_ROLLOUT#2"),
      ...LOG.filter((e) => e.kind !== "rollout-halted"),
    ];
    expect(haltRefusal(refused)).toEqual({ reason: "NO ROLLOUT ACTIVE", at: HALTED });
  });

  it("is not confused by a rollback that was refused", () => {
    const refused = [
      fleetEntry("r2", ORDERED, "command-failed", "ROLLBACK COHORT failed: ROLLBACK IN PROGRESS", "ROLLBACK_COHORT#5"),
      ...LOG,
    ];
    expect(haltRefusal(refused)).toBeNull();
  });

  it("is null on an incident nobody tried to halt", () => {
    expect(haltRefusal(LOG)).toBeNull();
  });
});

describe("cohortActions", () => {
  it("folds the log back into one row per intervention, oldest first", () => {
    const actions = cohortActions(LOG, FW);
    expect(actions.map((a) => a.label)).toEqual(["Halt rollout", "Roll back cohort"]);
    expect(actions[0]?.outcome).toBe(`complete — N-05 remains on ${STABLE}`);
    expect(actions[1]?.outcome).toBe(`complete — every unit off ${FW}`);
    expect(actions.every((a) => !a.refused)).toBe(true);
  });

  /**
   * A rollback that is still draining is an action that was taken. Leaving it
   * out until the last unit lands would make the report read as though nobody
   * had done anything for the sixteen seconds it runs.
   */
  it("shows a rollback that was ordered and has not finished", () => {
    const running = LOG.filter((e) => e.kind !== "rollback-complete");
    const actions = cohortActions(running, FW);
    expect(actions.map((a) => a.label)).toContain("Roll back cohort");
    expect(actions.find((a) => a.label === "Roll back cohort")?.outcome).toBe(
      "ordered — staged restoration running",
    );
  });

  it("records a refusal as its own row, in the fleet's words", () => {
    const refused = [
      fleetEntry("r1", HALTED, "command-failed", "HALT ROLLOUT failed: NO ROLLOUT ACTIVE", "HALT_ROLLOUT#2"),
      ...LOG.filter((e) => e.kind !== "rollout-halted"),
    ];
    const row = cohortActions(refused, FW).find((a) => a.label === "Halt rollout");
    expect(row?.refused).toBe(true);
    expect(row?.outcome).toBe("refused — NO ROLLOUT ACTIVE");
  });

  it("reports nothing on an incident nobody acted on", () => {
    expect(cohortActions(LOG.slice(-1), FW)).toEqual([]);
  });
});
