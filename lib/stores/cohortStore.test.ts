// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { type UnitSummary } from "@/lib/schema";
import { FLEET_AUDIT_SCOPE, useAuditStore } from "./auditStore";
import {
  auditCohortDetections,
  COHORT_THRESHOLD,
  resetCohortDerivation,
  selectCohorts,
  useCohortRecordStore,
} from "./cohortStore";
import { useCommandStore } from "./commandStore";
import { useFleetStore } from "./fleetStore";

/**
 * cohort detection as a pure derivation over fleet-store state.
 * Threshold, (signature, fw) grouping, canary math, latched instance
 * identity, memo identity discipline (telemetry commits cost nothing), and
 * the once-per-instance audit hook.
 */

const SIG = "Balance reflex latency above threshold";

const unit = (id: string, fw: string, extra: Partial<UnitSummary> = {}): UnitSummary => ({
  id,
  name: `House ${id}`,
  status: "nominal",
  battery: 80,
  pos: { lat: 44.05, lng: -121.31 },
  posture: "walking",
  fw,
  ...extra,
});

/** The sim's 4/4 split: even units on 2.4.1, odd on 2.3.7, N-05 queued. */
const FLEET: UnitSummary[] = [
  unit("N-01", "2.3.7"),
  unit("N-02", "2.4.1"),
  unit("N-03", "2.3.7"),
  unit("N-04", "2.4.1"),
  unit("N-05", "2.3.7", { fwPending: "2.4.1" }),
  unit("N-06", "2.4.1"),
  unit("N-07", "2.3.7"),
  unit("N-08", "2.4.1"),
];

const raise = (id: string, unitId: string, ts: number, message = SIG): void =>
  useFleetStore.getState().applyAlert({
    t: "alert",
    alert: { id, unitId, severity: "amber", message, ts },
  });

const cohorts = () => selectCohorts(useFleetStore.getState());

beforeEach(() => {
  useFleetStore.getState().reset();
  useAuditStore.getState().reset();
  resetCohortDerivation();
  useFleetStore.getState().applySnapshot({ t: "fleet_snapshot", units: FLEET });
});

describe("cohort detection — threshold and grouping", () => {
  it("stays empty below the threshold and detects at exactly COHORT_THRESHOLD members", () => {
    expect(COHORT_THRESHOLD).toBe(3);
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    expect(cohorts()).toEqual([]);

    raise("al-3", "N-06", 1_400);
    const [cohort] = cohorts();
    expect(cohort).toBeDefined();
    expect(cohort).toMatchObject({
      signature: SIG,
      fw: "2.4.1",
      unitIds: ["N-02", "N-04", "N-06"],
      alertIds: ["al-1", "al-2", "al-3"],
      detectedAt: 1_400, // the ts of the alert that crossed the threshold
    });
    expect(cohort!.id).toBe("cohort-2.4.1-1400");
  });

  it("groups by BOTH signature and firmware: other messages and other builds never count", () => {
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    // same words from a baseline unit: a different (signature, fw) group
    raise("al-3", "N-07", 1_300);
    // different words from a rollout unit: a different signature
    raise("al-4", "N-06", 1_350, "House N-06: left knee actuator running hot");
    expect(cohorts()).toEqual([]);

    raise("al-5", "N-08", 1_500); // the third true member
    const [cohort] = cohorts();
    expect(cohort!.unitIds).toEqual(["N-02", "N-04", "N-08"]);
    expect(cohort!.alertIds).not.toContain("al-3");
    expect(cohort!.alertIds).not.toContain("al-4");
  });

  it("orders members oldest raise first whatever order the feed holds them in", () => {
    // the feed is newest-first; the derivation must sort by ts
    raise("al-9", "N-06", 3_000);
    raise("al-1", "N-02", 1_000);
    raise("al-5", "N-04", 2_000);
    const [cohort] = cohorts();
    expect(cohort!.unitIds).toEqual(["N-02", "N-04", "N-06"]);
    expect(cohort!.detectedAt).toBe(3_000); // third-OLDEST member's ts
  });
});

describe("cohort detection — canary comparison", () => {
  it("reports affected/total per firmware, suspect (highest version) first", () => {
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    raise("al-3", "N-06", 1_400);
    expect(cohorts()[0]!.canary).toEqual([
      { fw: "2.4.1", affected: 3, total: 4 },
      { fw: "2.3.7", affected: 0, total: 4 },
    ]);
  });

  it("counts only signature alerts as affected — N-07's knee trouble keeps the baseline row clean", () => {
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    raise("al-3", "N-06", 1_400);
    raise("al-7", "N-07", 1_500, "House N-07: left knee actuator running hot");
    const rows = cohorts()[0]!.canary;
    expect(rows.find((r) => r.fw === "2.3.7")).toEqual({
      fw: "2.3.7",
      affected: 0,
      total: 4,
    });
  });

  it("moves a unit between rows when its firmware restates (the rollback path)", () => {
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    raise("al-3", "N-06", 1_400);
    raise("al-4", "N-08", 1_600);
    expect(cohorts()[0]!.canary[0]).toEqual({ fw: "2.4.1", affected: 4, total: 4 });

    // the rollback restates N-02 onto the baseline BEFORE its alert_clear
    // arrives: it leaves the cohort's membership at once (current fw rules)
    useFleetStore.getState().applyUnitUpdate({
      t: "unit_update",
      unit: unit("N-02", "2.3.7"),
    });
    const [cohort] = cohorts();
    expect(cohort!.unitIds).toEqual(["N-04", "N-06", "N-08"]);
    expect(cohort!.canary).toEqual([
      { fw: "2.4.1", affected: 3, total: 3 },
      // N-02's still-unresolved signature alert now counts against 2.3.7 —
      // the derivation reports current truth, not history
      { fw: "2.3.7", affected: 1, total: 5 },
    ]);
  });
});

describe("cohort detection — lifecycle: resolution, dissolution, latched identity", () => {
  it("keeps id and detectedAt latched while members churn at/above threshold", () => {
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    raise("al-3", "N-06", 1_400);
    const first = cohorts()[0]!;

    raise("al-4", "N-08", 1_600); // fourth member joins
    const grown = cohorts()[0]!;
    expect(grown.unitIds).toHaveLength(4);
    expect(grown.id).toBe(first.id);
    expect(grown.detectedAt).toBe(first.detectedAt);

    // one member resolves; still >= threshold: identity holds
    useFleetStore.getState().resolveAlert("al-1", { via: "operator" });
    const shrunk = cohorts()[0]!;
    expect(shrunk.unitIds).toEqual(["N-04", "N-06", "N-08"]);
    expect(shrunk.id).toBe(first.id);
    expect(shrunk.detectedAt).toBe(first.detectedAt);
  });

  it("dissolves below the threshold, and a later re-cross is a NEW instance", () => {
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    raise("al-3", "N-06", 1_400);
    const first = cohorts()[0]!;

    useFleetStore.getState().resolveAlert("al-1", { via: "operator" });
    useFleetStore.getState().resolveAlert("al-2", { via: "operator" });
    expect(cohorts()).toEqual([]); // 1 member is not a cohort

    raise("al-5", "N-02", 5_000);
    raise("al-6", "N-08", 6_000);
    const second = cohorts()[0]!;
    expect(second.unitIds).toEqual(["N-06", "N-02", "N-08"]); // oldest raise first
    expect(second.id).not.toBe(first.id);
    expect(second.detectedAt).toBe(6_000);
  });

  it("resolution via the wire's alert_clear counts exactly like the operator's", () => {
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    raise("al-3", "N-06", 1_400);
    raise("al-4", "N-08", 1_600);
    expect(cohorts()[0]!.unitIds).toHaveLength(4);
    // bindTransport routes alert_clear through this same idempotent action;
    // the derivation reads only alertMeta and cannot tell the authors apart
    useFleetStore.getState().resolveAlert("al-2", { via: "rollback" });
    expect(cohorts()[0]!.unitIds).toEqual(["N-02", "N-06", "N-08"]);
  });
});

describe("cohort detection — memo identity discipline", () => {
  it("returns the same array identity across telemetry commits (three reference compares, no recompute)", () => {
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    raise("al-3", "N-06", 1_400);
    const before = cohorts();

    for (let i = 1; i <= 10; i += 1) {
      useFleetStore.getState().applyTelemetry({
        t: "telemetry",
        unitId: "N-02",
        ts: 2_000 + i * 100,
        batch: [{ joint: "knee_L", tempC: 33, torqueNm: 12, currentA: 1.5, battery: 79 }],
      });
    }
    expect(useFleetStore.getState().telemetryVersion).toBe(10);
    expect(cohorts()).toBe(before); // identity, not just equality
  });

  it("keeps the previous identity when an unrelated alert recomputes to equal content", () => {
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    raise("al-3", "N-06", 1_400);
    const before = cohorts();

    raise("al-9", "N-01", 2_000, "House N-01: navigation blocked"); // not the signature
    const after = cohorts();
    expect(after).toBe(before); // recomputed, content-equal, identity preserved
  });
});

describe("cohort detection — the audit hook", () => {
  const detectedEntries = () =>
    useAuditStore.getState().entries.filter((e) => e.kind === "cohort-detected");

  it("appends cohort-detected once per instance, fleet-scoped, ref'd by the instance id", () => {
    raise("al-1", "N-02", 1_000);
    auditCohortDetections();
    expect(detectedEntries()).toHaveLength(0); // below threshold: nothing

    raise("al-2", "N-04", 1_200);
    raise("al-3", "N-06", 1_400);
    auditCohortDetections();
    const [entry] = detectedEntries();
    expect(entry).toMatchObject({
      kind: "cohort-detected",
      unitId: FLEET_AUDIT_SCOPE,
      ts: 1_400,
      ref: "cohort-2.4.1-1400",
      summary: `Cohort detected — 3 units on 2.4.1: "${SIG}"`,
    });

    // growth and repeated calls do not re-log the same instance
    raise("al-4", "N-08", 1_600);
    auditCohortDetections();
    auditCohortDetections();
    expect(detectedEntries()).toHaveLength(1);
  });

  it("logs a NEW instance after dissolution and re-cross — RESET_SIM's replayed storyline detects again", () => {
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    raise("al-3", "N-06", 1_400);
    auditCohortDetections();

    // RESET_SIM: snapshot restates the world (feed clears), storyline replays
    useFleetStore.getState().applySnapshot({ t: "fleet_snapshot", units: FLEET });
    expect(cohorts()).toEqual([]);
    raise("al-5", "N-02", 11_000);
    raise("al-6", "N-04", 11_200);
    raise("al-7", "N-06", 11_400);
    auditCohortDetections();

    const entries = detectedEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.ref)).toContain("cohort-2.4.1-11400");
  });
});

/* ---------------------------------------------------------------------------
   the close-out
--------------------------------------------------------------------------- */

describe("closing a fleet incident", () => {
  const settle = () => {
    raise("al-1", "N-02", 1_000);
    raise("al-2", "N-04", 1_200);
    raise("al-3", "N-06", 1_400);
    auditCohortDetections();
    return cohorts()[0]!;
  };

  beforeEach(() => {
    useCommandStore.getState().reset();
    useCohortRecordStore.getState().reset();
  });

  /**
   * A RECORD action, in the store that owns the record. The audit log is
   * written by stores and never by the UI (auditStore.ts), which is the whole
   * reason this is an action rather than three calls at a button's onClick.
   */
  it("files the incident, logs the closure, and clears the finished commands", () => {
    const cohort = settle();
    useCommandStore.getState().applyFleetCommandEvent({
      t: "fleet_command_event",
      cmd: "ROLLBACK_COHORT",
      fw: "2.4.1",
      seq: 1,
      ts: 5_000,
      ev: { k: "complete" },
    });

    useCohortRecordStore.getState().resolve(cohort, 4_000);

    const record = useCohortRecordStore.getState().record!;
    // The subject survives the incident: the derivation has already forgotten
    // the group, and the report still needs something to be a report about.
    expect(record.cohort).toBe(cohort);
    expect(record.closedAt).toBe(4_000);

    const closure = useAuditStore
      .getState()
      .entries.find((e) => e.kind === "resolution" && e.ref === cohort.id)!;
    expect(closure.unitId).toBe(FLEET_AUDIT_SCOPE);
    expect(closure.summary).toBe("Fleet incident closed by operator — 3 units on 2.4.1");

    // Left on file, a finished lifecycle is what brings a closed incident's
    // card back — and it would arrive carrying the last run's receipts.
    expect(useCommandStore.getState().fleetCommands).toEqual({});
  });

  it("does not date a closure it cannot cite", () => {
    useCohortRecordStore.getState().resolve(settle(), undefined);
    expect(useCohortRecordStore.getState().record).not.toHaveProperty("closedAt");
  });

  /** Twice is the same fact, and the log is deduped by (kind, ref). */
  it("logs one closure however many times it is pressed", () => {
    const cohort = settle();
    useCohortRecordStore.getState().resolve(cohort);
    useCohortRecordStore.getState().resolve(cohort);
    expect(
      useAuditStore.getState().entries.filter((e) => e.kind === "resolution"),
    ).toHaveLength(1);
  });

  /**
   * A snapshot does not clear it, and that is the point: RESET_SIM replays the
   * storyline, and a reset that erased the closure would make the operator's
   * own record the one thing in the console a sim restart could delete. The
   * page gives the slot back on the next DETECTION instead (cohort-card.tsx),
   * and the log keeps the closure either way.
   */
  it("survives the snapshot that replays the storyline", () => {
    useCohortRecordStore.getState().resolve(settle());
    useFleetStore.getState().applySnapshot({ t: "fleet_snapshot", units: FLEET });
    expect(cohorts()).toEqual([]);
    expect(useCohortRecordStore.getState().record).not.toBeNull();
  });
});
