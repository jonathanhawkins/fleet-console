// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  alertSchema,
  diagEventSchema,
  fleetMessageSchema,
  operatorCommandSchema,
  telemetryPointSchema,
  unitSummarySchema,
  verdictReportSchema,
} from "./messages";

const point = {
  joint: "knee_L",
  tempC: 33.4,
  torqueNm: 12.1,
  currentA: 1.8,
  battery: 76,
};

const unit = {
  id: "N-07",
  name: "Sagebrush House",
  status: "nominal",
  battery: 76,
  pos: { lat: 44.06, lng: -121.31 },
};

const alert = {
  id: "al-001",
  unitId: "N-07",
  severity: "amber",
  message: "Left knee actuator temperature rising",
  ts: 45_000,
};

const report = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LEFT KNEE ACTUATOR A-07 GAIN ANOMALY",
  recommendations: ["Disable joint", "Command safe sit", "Dispatch service"],
  ts: 120_000,
};

describe("telemetryPointSchema", () => {
  it("parses a valid point", () => {
    expect(telemetryPointSchema.parse(point)).toEqual(point);
  });

  it("rejects a battery outside 0–100 and missing fields", () => {
    expect(telemetryPointSchema.safeParse({ ...point, battery: 130 }).success).toBe(
      false,
    );
    expect(
      telemetryPointSchema.safeParse({ ...point, torqueNm: undefined }).success,
    ).toBe(false);
    expect(telemetryPointSchema.safeParse({ ...point, tempC: "hot" }).success).toBe(
      false,
    );
  });
});

describe("unitSummarySchema", () => {
  it("parses a valid unit", () => {
    expect(unitSummarySchema.parse(unit)).toEqual(unit);
  });

  it("accepts three-digit scale ids and optional posture", () => {
    expect(unitSummarySchema.safeParse({ ...unit, id: "N-500" }).success).toBe(true);
    expect(unitSummarySchema.parse({ ...unit, posture: "sitting" }).posture).toBe(
      "sitting",
    );
    expect(unitSummarySchema.parse(unit).posture).toBeUndefined();
    expect(unitSummarySchema.safeParse({ ...unit, posture: "prone" }).success).toBe(
      false,
    );
  });

  it("accepts optional fw and fwPending semvers and rejects malformed ones", () => {
    expect(unitSummarySchema.parse(unit).fw).toBeUndefined(); // pre-firmware snapshots stay valid
    const rolled = unitSummarySchema.parse({ ...unit, fw: "2.4.1" });
    expect(rolled.fw).toBe("2.4.1");
    expect(rolled.fwPending).toBeUndefined();
    const queued = unitSummarySchema.parse({ ...unit, fw: "2.3.7", fwPending: "2.4.1" });
    expect(queued.fwPending).toBe("2.4.1");
    expect(unitSummarySchema.safeParse({ ...unit, fw: "2.4" }).success).toBe(false);
    expect(unitSummarySchema.safeParse({ ...unit, fw: "v2.4.1" }).success).toBe(false);
    expect(unitSummarySchema.safeParse({ ...unit, fwPending: "next" }).success).toBe(
      false,
    );
  });

  it("rejects malformed ids, statuses, and coordinates", () => {
    expect(unitSummarySchema.safeParse({ ...unit, id: "unit-7" }).success).toBe(false);
    expect(unitSummarySchema.safeParse({ ...unit, id: "N-1234" }).success).toBe(false);
    expect(unitSummarySchema.safeParse({ ...unit, status: "green" }).success).toBe(false);
    expect(
      unitSummarySchema.safeParse({ ...unit, pos: { lat: 91, lng: 0 } }).success,
    ).toBe(false);
  });
});

describe("alertSchema", () => {
  it("parses a valid alert", () => {
    expect(alertSchema.parse(alert)).toEqual(alert);
  });

  it("rejects unknown severities and empty messages", () => {
    expect(alertSchema.safeParse({ ...alert, severity: "critical" }).success).toBe(false);
    expect(alertSchema.safeParse({ ...alert, message: "" }).success).toBe(false);
  });
});

describe("verdictReportSchema", () => {
  it("parses a valid report", () => {
    expect(verdictReportSchema.parse(report)).toEqual(report);
  });

  it("requires at least one recommendation", () => {
    expect(
      verdictReportSchema.safeParse({ ...report, recommendations: [] }).success,
    ).toBe(false);
  });
});

describe("diagEventSchema", () => {
  it("parses every variant", () => {
    expect(diagEventSchema.parse({ k: "scan_start" })).toEqual({ k: "scan_start" });
    expect(
      diagEventSchema.parse({ k: "walk", path: "/sys/actuator_bus/07" }),
    ).toMatchObject({
      k: "walk",
    });
    expect(
      diagEventSchema.parse({
        k: "channel",
        joint: "hip_R",
        wave: [0, 0.4],
        ref: [0, 0.41],
      }),
    ).toMatchObject({ k: "channel" });
    expect(
      diagEventSchema.parse({
        k: "flag",
        joint: "knee_L",
        component: "actuator_A07",
        anomaly: "gain",
      }),
    ).toMatchObject({ k: "flag" });
    // Both scripted acts, on one shape: joint and component are
    // identifiers, exactly as the verdict has always carried them.
    expect(
      diagEventSchema.parse({
        k: "flag",
        joint: "ankle_R",
        component: "actuator_A12",
        anomaly: "offset",
      }),
    ).toMatchObject({ k: "flag", anomaly: "offset" });
    expect(diagEventSchema.parse({ k: "verdict", report })).toMatchObject({
      k: "verdict",
    });
  });

  it("rejects each variant when malformed", () => {
    expect(diagEventSchema.safeParse({ k: "boot" }).success).toBe(false);
    expect(diagEventSchema.safeParse({ k: "walk" }).success).toBe(false);
    expect(
      diagEventSchema.safeParse({ k: "channel", joint: "hip_R", wave: [0] }).success,
    ).toBe(false);
    expect(
      diagEventSchema.safeParse({ k: "channel", joint: "hip_R", wave: ["a"], ref: [] })
        .success,
    ).toBe(false);
    // The anomaly stays closed while the identifiers widened: three
    // tables downstream are keyed by this value, so a kind with no medicine
    // attached is rejected at the transport rather than rendered as a finding.
    expect(
      diagEventSchema.safeParse({
        k: "flag",
        joint: "hip_L",
        component: "actuator_A03",
        anomaly: "backlash",
      }).success,
    ).toBe(false);
    // …and an identifier is still required to be one.
    expect(
      diagEventSchema.safeParse({
        k: "flag",
        joint: "",
        component: "actuator_A07",
        anomaly: "gain",
      }).success,
    ).toBe(false);
    expect(
      diagEventSchema.safeParse({ k: "verdict", report: { ...report, summary: "" } })
        .success,
    ).toBe(false);
  });
});

describe("fleetMessageSchema", () => {
  it("parses fleet_snapshot", () => {
    const msg = { t: "fleet_snapshot", units: [unit] };
    expect(fleetMessageSchema.parse(msg)).toEqual(msg);
  });

  it("rejects fleet_snapshot with a bad unit", () => {
    expect(
      fleetMessageSchema.safeParse({
        t: "fleet_snapshot",
        units: [{ ...unit, battery: -1 }],
      }).success,
    ).toBe(false);
  });

  it("parses unit_update (the per-unit live restatement) and rejects a bad unit", () => {
    const msg = { t: "unit_update", unit: { ...unit, posture: "sitting" } };
    expect(fleetMessageSchema.parse(msg)).toEqual(msg);
    // posture stays optional here too: the field is additive on UnitSummary
    expect(fleetMessageSchema.parse({ t: "unit_update", unit })).toEqual({
      t: "unit_update",
      unit,
    });
    expect(
      fleetMessageSchema.safeParse({ t: "unit_update", unit: { ...unit, id: "x" } })
        .success,
    ).toBe(false);
    expect(fleetMessageSchema.safeParse({ t: "unit_update" }).success).toBe(false);
  });

  it("parses telemetry and rejects an empty batch", () => {
    const msg = { t: "telemetry", unitId: "N-07", ts: 1000, batch: [point] };
    expect(fleetMessageSchema.parse(msg)).toEqual(msg);
    expect(
      fleetMessageSchema.safeParse({
        t: "telemetry",
        unitId: "N-07",
        ts: 1000,
        batch: [],
      }).success,
    ).toBe(false);
    expect(
      fleetMessageSchema.safeParse({ t: "telemetry", unitId: "N-07", batch: [point] })
        .success,
    ).toBe(false);
  });

  it("parses alert and rejects a malformed one", () => {
    const msg = { t: "alert", alert };
    expect(fleetMessageSchema.parse(msg)).toEqual(msg);
    expect(
      fleetMessageSchema.safeParse({ t: "alert", alert: { ...alert, ts: "now" } })
        .success,
    ).toBe(false);
  });

  it("parses diag_event and rejects a malformed inner event", () => {
    const msg = { t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } };
    expect(fleetMessageSchema.parse(msg)).toEqual(msg);
    expect(
      fleetMessageSchema.safeParse({ t: "diag_event", unitId: "N-07", ev: { k: "walk" } })
        .success,
    ).toBe(false);
  });

  it("parses alert_clear (the sim resolving its own alert)", () => {
    const msg = {
      t: "alert_clear",
      alertId: "al-003",
      unitId: "N-03",
      via: "self-recovery",
      ts: 160_000,
    };
    expect(fleetMessageSchema.parse(msg)).toEqual(msg);
    // `via` is the enum of clearings the sim performs: self-recovery
    // and rollback. Operator resolutions never ride the wire.
    expect(fleetMessageSchema.parse({ ...msg, via: "rollback" })).toEqual({
      ...msg,
      via: "rollback",
    });
    expect(fleetMessageSchema.safeParse({ ...msg, via: "operator" }).success).toBe(false);
    expect(fleetMessageSchema.safeParse({ ...msg, alertId: "" }).success).toBe(false);
    expect(fleetMessageSchema.safeParse({ ...msg, unitId: "X-03" }).success).toBe(false);
  });

  it("rejects unknown discriminators and non-objects", () => {
    expect(fleetMessageSchema.safeParse({ t: "heartbeat" }).success).toBe(false);
    expect(fleetMessageSchema.safeParse("telemetry").success).toBe(false);
    expect(fleetMessageSchema.safeParse(null).success).toBe(false);
  });

  it("parses every command_event beat", () => {
    const base = {
      t: "command_event",
      unitId: "N-07",
      cmd: "COMMAND_SAFE_SIT",
      ts: 2500,
    };
    for (const [seq, ev] of (
      [
        { k: "accepted" },
        { k: "progress", pct: 45, note: "CROUCH PHASE" },
        { k: "complete" },
        { k: "failed", reason: "ALREADY SITTING" },
      ] as const
    ).entries()) {
      const msg = { ...base, seq: seq + 1, ev };
      expect(fleetMessageSchema.parse(msg)).toEqual(msg);
    }
  });

  it("rejects malformed command_events: bad seq, out-of-range pct, empty reason, unknown cmd", () => {
    const base = {
      t: "command_event",
      unitId: "N-07",
      cmd: "COMMAND_SAFE_SIT",
      seq: 1,
      ts: 2500,
      ev: { k: "accepted" },
    };
    expect(fleetMessageSchema.parse(base)).toEqual(base);
    expect(fleetMessageSchema.safeParse({ ...base, seq: 0 }).success).toBe(false);
    expect(fleetMessageSchema.safeParse({ ...base, seq: 1.5 }).success).toBe(false);
    expect(
      fleetMessageSchema.safeParse({ ...base, cmd: "COMMAND_BACKFLIP" }).success,
    ).toBe(false);
    expect(
      fleetMessageSchema.safeParse({
        ...base,
        ev: { k: "progress", pct: 130, note: "x" },
      }).success,
    ).toBe(false);
    expect(
      fleetMessageSchema.safeParse({ ...base, ev: { k: "progress", pct: 50 } }).success,
    ).toBe(false);
    expect(
      fleetMessageSchema.safeParse({ ...base, ev: { k: "failed", reason: "" } }).success,
    ).toBe(false);
  });

  it("parses every fleet_command_event beat — unitId-less by design, fw optional", () => {
    const base = {
      t: "fleet_command_event",
      cmd: "ROLLBACK_COHORT",
      fw: "2.4.1",
      ts: 2500,
    };
    for (const [seq, ev] of (
      [
        { k: "accepted" },
        { k: "progress", pct: 25, note: "ROLLING BACK N-04 2.4.1->2.3.7" },
        { k: "complete" },
        { k: "failed", reason: "ROLLBACK IN PROGRESS" },
      ] as const
    ).entries()) {
      const msg = { ...base, seq: seq + 1, ev };
      expect(fleetMessageSchema.parse(msg)).toEqual(msg);
    }
    // fw is optional context, not identity
    const bare = {
      t: "fleet_command_event",
      cmd: "HALT_ROLLOUT",
      seq: 9,
      ts: 100,
      ev: { k: "accepted" },
    };
    expect(fleetMessageSchema.parse(bare)).toEqual(bare);
  });

  it("rejects malformed fleet_command_events: unknown cmd, bad seq, bad fw", () => {
    const base = {
      t: "fleet_command_event",
      cmd: "HALT_ROLLOUT",
      seq: 1,
      ts: 100,
      ev: { k: "accepted" },
    };
    expect(fleetMessageSchema.parse(base)).toEqual(base);
    expect(
      fleetMessageSchema.safeParse({ ...base, cmd: "COMMAND_SAFE_SIT" }).success,
    ).toBe(false);
    expect(fleetMessageSchema.safeParse({ ...base, seq: 0 }).success).toBe(false);
    expect(fleetMessageSchema.safeParse({ ...base, fw: "2.4" }).success).toBe(false);
  });
});

describe("operatorCommandSchema", () => {
  it("parses all five commands", () => {
    expect(operatorCommandSchema.parse({ c: "RUN_DIAGNOSTIC", unitId: "N-07" })).toEqual({
      c: "RUN_DIAGNOSTIC",
      unitId: "N-07",
    });
    expect(
      operatorCommandSchema.parse({ c: "COMMAND_SAFE_SIT", unitId: "N-07" }),
    ).toEqual({ c: "COMMAND_SAFE_SIT", unitId: "N-07" });
    expect(operatorCommandSchema.parse({ c: "HALT_ROLLOUT" })).toEqual({
      c: "HALT_ROLLOUT",
    });
    expect(operatorCommandSchema.parse({ c: "ROLLBACK_COHORT", fw: "2.4.1" })).toEqual({
      c: "ROLLBACK_COHORT",
      fw: "2.4.1",
    });
    expect(operatorCommandSchema.parse({ c: "RESET_SIM" })).toEqual({ c: "RESET_SIM" });
  });

  it("rejects targeted commands without a target and unknown commands", () => {
    expect(operatorCommandSchema.safeParse({ c: "RUN_DIAGNOSTIC" }).success).toBe(false);
    expect(operatorCommandSchema.safeParse({ c: "COMMAND_SAFE_SIT" }).success).toBe(
      false,
    );
    // ROLLBACK_COHORT's target is a firmware, and it is required + validated
    expect(operatorCommandSchema.safeParse({ c: "ROLLBACK_COHORT" }).success).toBe(false);
    expect(
      operatorCommandSchema.safeParse({ c: "ROLLBACK_COHORT", fw: "latest" }).success,
    ).toBe(false);
    expect(operatorCommandSchema.safeParse({ c: "SELF_DESTRUCT" }).success).toBe(false);
  });
});
