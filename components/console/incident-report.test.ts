import { beforeEach, describe, expect, it } from "vitest";
import { type Alert } from "@/lib/schema";
import { type AlertMeta, type AuditEntry, type IncidentRecord } from "@/lib/stores";
import {
  closeIncidentReport,
  escalatedTier,
  incidentAlerts,
  incidentReportSnapshot,
  incidentSpans,
  incidentTimes,
  openIncidentReport,
  recoveryTier,
  resetIncidentReport,
  subscribeIncidentReport,
} from "./incident-report";

/**
 * The report is a join across three journals that were each written for a
 * narrower question. These tests pin what the join is allowed to conclude —
 * and, more importantly, what it must refuse to conclude, because this is the
 * surface an operator would quote in a dispute.
 */

const T0 = 1_700_000_000_000;

const report = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain" as const,
  summary: "LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE",
  recommendations: ["Disable joint", "Command safe sit", "Dispatch service"],
  ts: T0 + 5_700_000,
};

const record: IncidentRecord = {
  id: `inc-N-07-${report.ts}`,
  unitId: "N-07",
  report,
  acknowledged: ["Dispatch service"],
};

function alert(over: Partial<Alert> & Pick<Alert, "id" | "ts">): Alert {
  return {
    unitId: "N-07",
    severity: "amber",
    message: "Sagebrush House: left knee actuator running hot",
    ...over,
  };
}

/** The scripted incident: amber, red, both closed by the diagnostic. */
const ALERTS: Alert[] = [
  alert({ id: "al-002", ts: T0 + 60_000, severity: "red" }),
  alert({ id: "al-001", ts: T0 }),
];

const META: Record<string, AlertMeta> = {
  "al-001": {
    ackedAt: T0 + 90_000,
    ackedBy: "Operator",
    resolvedAt: T0 + 5_760_000,
    resolution: { via: "incident", ref: record.id },
  },
  "al-002": {
    resolvedAt: T0 + 5_760_001,
    resolution: { via: "incident", ref: record.id },
  },
};

const LOG: AuditEntry[] = [
  { id: "a4", ts: T0 + 5_600_000, kind: "diag-start", unitId: "N-07", summary: "" },
  { id: "a3", ts: T0 + 90_000, kind: "alert-acked", unitId: "N-07", summary: "" },
  { id: "a2", ts: T0 + 60_000, kind: "escalation", unitId: "N-07", summary: "" },
  { id: "a1", ts: T0, kind: "alert-raised", unitId: "N-07", summary: "" },
];

beforeEach(() => {
  resetIncidentReport();
});

describe("incidentAlerts", () => {
  it("takes the alerts this incident actually closed, by their own resolution ref", () => {
    const { closed } = incidentAlerts(record, ALERTS, META);
    expect(closed.map((a) => a.id)).toEqual(["al-002", "al-001"]);
  });

  it("does not sweep in an alert a different incident closed", () => {
    const meta: Record<string, AlertMeta> = {
      ...META,
      "al-002": {
        resolvedAt: T0 + 10,
        resolution: { via: "incident", ref: "inc-N-07-999" },
      },
    };
    expect(incidentAlerts(record, ALERTS, meta).closed.map((a) => a.id)).toEqual([
      "al-001",
    ]);
  });

  /**
   * A clean pass resolves nothing on purpose, and a report can be read while
   * its alert is still standing. The subject is then what the incident was
   * about, even though it closed nothing.
   */
  it("falls back to what was standing when the verdict landed", () => {
    const { closed, subject } = incidentAlerts(record, ALERTS, {});
    expect(closed).toEqual([]);
    expect(subject.map((a) => a.id)).toEqual(["al-002", "al-001"]);
  });

  it("never reaches forward to an alert raised after the verdict", () => {
    const later = alert({ id: "al-009", ts: report.ts + 60_000, severity: "red" });
    const { subject } = incidentAlerts(record, [later, ...ALERTS], {});
    expect(subject.map((a) => a.id)).not.toContain("al-009");
  });

  /**
   * The one incident that ends without the console writing a ref:
   * the sim resolves the alert itself the moment a recalibration clears the
   * fault, so the resolution names "recalibration" as its author and carries no
   * incident id. Without this the product's only self-resolving unit incident
   * would file with no closure time under a letterhead saying it was open.
   */
  const CLEARED_RECORD: IncidentRecord = {
    ...record,
    calibration: {
      k: "recalibration",
      joint: "ankle_R",
      wave: [0.1],
      ref: [0.1],
      outcome: "cleared",
    },
  };
  const CLEARED_META: Record<string, AlertMeta> = {
    "al-001": {
      resolvedAt: T0 + 5_760_000,
      resolution: { via: "recalibration" },
    },
  };

  it("credits a cleared recalibration with the alert the sim closed for it", () => {
    const { closed, subject } = incidentAlerts(CLEARED_RECORD, ALERTS, CLEARED_META);
    expect(closed.map((a) => a.id)).toEqual(["al-001"]);
    // The subject stays every standing alert, so the raise time is still the
    // earliest of them rather than the one that happened to close.
    expect(subject.map((a) => a.id)).toEqual(["al-002", "al-001"]);
  });

  it("does not credit a partial calibration, which closed nothing", () => {
    const partial: IncidentRecord = {
      ...record,
      calibration: { ...CLEARED_RECORD.calibration!, outcome: "partial" },
    };
    expect(incidentAlerts(partial, ALERTS, CLEARED_META).closed).toEqual([]);
    // …and neither does an incident with no calibration on file at all.
    expect(incidentAlerts(record, ALERTS, CLEARED_META).closed).toEqual([]);
  });

  it("still lets an operator's own resolution outrank it", () => {
    const { closed } = incidentAlerts(CLEARED_RECORD, ALERTS, META);
    expect(closed.map((a) => a.id)).toEqual(["al-002", "al-001"]);
  });
});

describe("incidentTimes", () => {
  it("dates every beat of the incident from the journal that owns it", () => {
    expect(incidentTimes(record, ALERTS, META, LOG)).toEqual({
      raised: T0,
      escalated: T0 + 60_000,
      acked: T0 + 90_000,
      diagnostic: T0 + 5_600_000,
      verdict: report.ts,
      resolved: T0 + 5_760_001,
    });
  });

  /**
   * Every field but the verdict can genuinely be absent, and a report that
   * filled one with a plausible-looking time would be the one surface in the
   * product that lies.
   */
  it("leaves a moment undated rather than inventing it", () => {
    const times = incidentTimes(record, [], {}, []);
    expect(times).toEqual({
      raised: undefined,
      escalated: undefined,
      acked: undefined,
      diagnostic: undefined,
      verdict: report.ts,
      resolved: undefined,
    });
  });

  it("is not closed by an alert the incident did not close", () => {
    expect(incidentTimes(record, ALERTS, {}, LOG).resolved).toBeUndefined();
  });

  it("takes the scan that produced this verdict, not an abandoned earlier one", () => {
    const withAbort: AuditEntry[] = [
      { id: "a5", ts: T0 + 300_000, kind: "diag-start", unitId: "N-07", summary: "" },
      ...LOG,
    ];
    expect(incidentTimes(record, ALERTS, META, withAbort).diagnostic).toBe(
      T0 + 5_600_000,
    );
  });

  it("reads only this unit's log", () => {
    const foreign: AuditEntry[] = [
      { id: "x1", ts: T0 + 10, kind: "escalation", unitId: "N-03", summary: "" },
      ...LOG.filter((e) => e.kind !== "escalation"),
    ];
    expect(incidentTimes(record, ALERTS, META, foreign).escalated).toBeUndefined();
  });
});

describe("incidentSpans", () => {
  it("derives the figures an ops team is measured on", () => {
    const spans = incidentSpans(incidentTimes(record, ALERTS, META, LOG));
    expect(spans.mtta).toBe(90_000);
    expect(spans.mttr).toBe(5_760_001);
    expect(spans.toDiagnose).toBe(5_600_000);
    expect(spans.toResolve).toBe(160_001);
  });

  it("has no span where it has no end", () => {
    expect(incidentSpans({ verdict: report.ts })).toEqual({
      mtta: undefined,
      mttr: undefined,
      toDiagnose: undefined,
      toResolve: undefined,
    });
  });

  it("refuses to measure backwards", () => {
    // A closure dated before the raise is a clock skew, not a negative MTTR.
    const spans = incidentSpans({ verdict: report.ts, raised: T0, resolved: T0 - 1_000 });
    expect(spans.mttr).toBeUndefined();
  });
});

describe("the recovery ladder", () => {
  /**
   * The calibration-first recommendation shipped with no rung against
   * it — it is the differential's own cheapest step ("unloaded recalibration
   * before module replacement") and it was the one action on the knee
   * incident's report reading as untiered.
   */
  it("files an unloaded recalibration as remote operations", () => {
    expect(recoveryTier("Recalibrate joint")).toBe("remote operations");
    expect(recoveryTier("Recalibration, unloaded")).toBe("remote operations");
  });

  /** the two fleet-scale interventions are still commands over a link. */
  it("files the fleet's own two actions as remote operations", () => {
    expect(recoveryTier("Halt rollout")).toBe("remote operations");
    expect(recoveryTier("Roll back cohort")).toBe("remote operations");
    expect(recoveryTier("Rollback cohort")).toBe("remote operations");
  });

  /**
   * The table's one hard direction: it may overstate a rung, never understate
   * one. A phrase that names a technician outranks the remote verb inside it.
   */
  it("does not let a remote verb pull a dispatch back down the ladder", () => {
    expect(recoveryTier("Dispatch service to recalibrate the joint")).toBe(
      "field service",
    );
    expect(recoveryTier("Return to depot and recalibrate")).toBe("depot");
  });

  /**
   * That direction used to be held by the ORDER of the table — the
   * remote patterns were kept last so a phrase naming a technician, a household
   * or a depot as well would fall through to its true rung, and the entry said
   * so: "position is the only thing enforcing that". It was already broken at
   * the top of the table, where the bare word `remote` sat above field service
   * and depot. Both of these filed as remote operations, and that value is the
   * one line of the filed document saying how expensive the incident got.
   *
   * The rule is structural now: the highest match wins, whatever the order.
   */
  it("takes the highest rung a phrase reaches, not the first one it matches", () => {
    expect(recoveryTier("Reduce torque, then dispatch a technician")).toBe(
      "field service",
    );
    expect(recoveryTier("Remote depot diagnostics")).toBe("depot");
    expect(recoveryTier("Remote session with the customer present")).toBe(
      "customer-assisted",
    );
    // And it does not climb for a phrase that names only the cheap rung.
    expect(recoveryTier("Remote session")).toBe("remote operations");
  });

  it("still gives an action it has never heard of no tier at all", () => {
    expect(recoveryTier("Reticulate splines")).toBeNull();
    expect(escalatedTier(["Reticulate splines"])).toBeNull();
  });

  it("reports the highest rung anything reached", () => {
    expect(escalatedTier(["Recalibrate joint", "Dispatch service"])).toBe(
      "field service",
    );
    expect(escalatedTier(["Halt rollout", "Roll back cohort"])).toBe(
      "remote operations",
    );
  });

  it("stops at rung two when the cheap rung was enough", () => {
    // The offset act's whole claim, as the report computes it: the two commands
    // the operator actually executed, and nothing above them. `escalatedTier`
    // reads what was *done*, so the verdict's unpressed DISPATCH SERVICE
    // recommendation does not climb the ladder on its own.
    expect(escalatedTier(["Command safe sit", "Recalibrate joint"])).toBe(
      "remote operations",
    );
  });
});

describe("the open signal", () => {
  it("names the open report and tells its subscribers", () => {
    let beats = 0;
    const stop = subscribeIncidentReport(() => {
      beats += 1;
    });

    expect(incidentReportSnapshot()).toBeNull();
    openIncidentReport(record.id);
    expect(incidentReportSnapshot()).toBe(record.id);
    expect(beats).toBe(1);

    // Opening the one already open is not an event: it would re-render every
    // subscriber to change nothing.
    openIncidentReport(record.id);
    expect(beats).toBe(1);

    closeIncidentReport();
    expect(incidentReportSnapshot()).toBeNull();
    expect(beats).toBe(2);
    stop();
  });
});
