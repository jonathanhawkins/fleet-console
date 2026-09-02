import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  markAcknowledged,
  resetAcknowledgedTimes,
} from "@/components/machine/safe-sit-copy";
import { type VerdictReport } from "@/lib/schema";
import {
  useAuditStore,
  useFleetStore,
  useIncidentStore,
  type AuditEntry,
  type IncidentRecord,
} from "@/lib/stores";
import { clockTime } from "./alert-lifecycle";
import { escalatedTier } from "./incident-report";
import {
  confirmedSignal,
  executedCommands,
  IncidentReportSurface,
} from "./incident-report-surface";

/**
 * The write-up.
 *
 * Two properties are load-bearing and everything else follows from them: the
 * report invents nothing (a journal that is silent produces an em dash, never a
 * plausible time), and it says the same numbers the surfaces it summarises say.
 * The rest of these tests are about the composition an operator reads.
 *
 * Presence rather than visibility throughout: the whole document sits inside a
 * motion surface whose opening frame is `opacity: 0`, and jsdom runs no frames
 * — so a `toBeVisible` here would be an assertion about framer's scheduler
 * rather than about the report.
 */

const T0 = new Date("2026-08-24T09:00:00.000Z").getTime();
const DIAG_AT = T0 + 5_600_000;
const VERDICT_TS = DIAG_AT + 25_000;
const RESOLVED_AT = VERDICT_TS + 3_000;

const report: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE",
  recommendations: ["Disable joint", "Command safe sit", "Dispatch service"],
  ts: VERDICT_TS,
};

/** A subject running at 1.78× its reference, and a healthy opposite number. */
const wave = (gain: number) =>
  Array.from({ length: 24 }, (_, i) => gain * Math.sin(i / 3));
const REFERENCE = wave(1);

/** The archive as `completeAscent()` files it: verdict, presses, and evidence. */
const record: IncidentRecord = {
  id: `inc-N-07-${VERDICT_TS}`,
  unitId: "N-07",
  report,
  acknowledged: ["Dispatch service"],
  startedAt: DIAG_AT,
  channels: [
    { joint: "knee_L", wave: wave(1.78), ref: REFERENCE },
    { joint: "knee_R", wave: wave(1.01), ref: REFERENCE },
    { joint: "hip_L", wave: wave(1.0), ref: REFERENCE },
  ],
};

function seedFleet() {
  const fleet = useFleetStore.getState();
  fleet.applySnapshot({
    t: "fleet_snapshot",
    units: [
      {
        id: "N-07",
        name: "Sagebrush House",
        status: "red",
        battery: 79,
        pos: { lat: 44.06, lng: -121.28 },
      },
    ],
  });
  fleet.applyAlert({
    t: "alert",
    alert: {
      id: "al-001",
      unitId: "N-07",
      severity: "amber",
      message: "Sagebrush House: left knee actuator running hot",
      ts: T0,
    },
  });
  useFleetStore.setState((s) => ({
    alertMeta: {
      ...s.alertMeta,
      "al-001": {
        ackedAt: T0 + 90_000,
        ackedBy: "Operator",
        resolvedAt: RESOLVED_AT,
        resolution: { via: "incident", ref: record.id },
      },
    },
  }));
}

function seedLog(extra: Array<Omit<AuditEntry, "id">> = []) {
  const audit = useAuditStore.getState();
  const entries: Array<Omit<AuditEntry, "id">> = [
    {
      ts: T0,
      kind: "alert-raised",
      unitId: "N-07",
      summary: "Sagebrush House: left knee actuator running hot",
      ref: "al-001",
    },
    {
      ts: T0 + 60_000,
      kind: "escalation",
      unitId: "N-07",
      summary: "Escalated amber → red",
      ref: "al-002",
    },
    {
      ts: T0 + 90_000,
      kind: "alert-acked",
      unitId: "N-07",
      summary: "Acknowledged by Operator",
      ref: "al-001",
    },
    {
      ts: DIAG_AT,
      kind: "diag-start",
      unitId: "N-07",
      summary: "Diagnostic scan started",
    },
    {
      ts: VERDICT_TS,
      kind: "diag-verdict",
      unitId: "N-07",
      summary: report.summary,
      ref: record.id,
    },
    {
      ts: RESOLVED_AT,
      kind: "resolution",
      unitId: "N-07",
      summary: "Resolved — diagnostic incident logged",
      ref: "al-001",
    },
    ...extra,
  ];
  for (const entry of entries) audit.append(entry);
}

const onClose = vi.fn();

function renderReport() {
  return render(<IncidentReportSurface record={record} onClose={onClose} />);
}

/** The same incident, with the cheapest rung actually tried. */
function renderRecalibratedReport() {
  return render(
    <IncidentReportSurface
      record={{
        ...record,
        acknowledged: ["Recalibrate joint", "Dispatch service"],
        calibration: {
          k: "recalibration",
          joint: "knee_L",
          wave: wave(1.34),
          ref: REFERENCE,
          outcome: "partial",
        },
      }}
      onClose={onClose}
    />,
  );
}

beforeEach(() => {
  onClose.mockClear();
  useFleetStore.getState().reset();
  useIncidentStore.getState().reset();
  useAuditStore.getState().reset();
  resetAcknowledgedTimes();
  seedFleet();
  seedLog();
});

describe("the header", () => {
  it("is a document: a letterhead, a title, the reference and its subject", () => {
    const { container } = renderReport();
    expect(screen.getByRole("heading", { name: "Incident report" })).toBeInTheDocument();
    expect(
      screen.getByText(`INC-N07-${VERDICT_TS.toString(36).toUpperCase()}`),
    ).toBeInTheDocument();
    expect(screen.getByText(/Sagebrush House/)).toBeInTheDocument();
    // The chip, not the times block's own "Resolved" label.
    expect(container.querySelector("[data-slot='status-chip']")).toHaveTextContent(
      "Resolved",
    );
  });

  it("says how far up the recovery ladder the incident went", () => {
    renderReport();
    expect(screen.getByText(/Escalated to:/)).toHaveTextContent(
      "Escalated to: field service",
    );
  });

  it("stands open when nothing closed the alert", () => {
    useFleetStore.setState({ alertMeta: {} });
    const { container } = renderReport();
    expect(container.querySelector("[data-slot='status-chip']")).toHaveTextContent(
      "Open",
    );
  });
});

describe("the times", () => {
  it("dates every beat to the second", () => {
    const { container } = renderReport();
    const at = (key: string) =>
      container.querySelector(`[data-moment='${key}']`)?.textContent ?? "";
    expect(at("raised")).toContain(clockTime(T0));
    expect(at("escalated")).toContain(clockTime(T0 + 60_000));
    expect(at("acked")).toContain(clockTime(T0 + 90_000));
    expect(at("diagnostic")).toContain(clockTime(DIAG_AT));
    expect(at("verdict")).toContain(clockTime(VERDICT_TS));
    expect(at("resolved")).toContain(clockTime(RESOLVED_AT));
  });

  /**
   * The property the whole document rests on. A service report that fills a
   * missing acknowledgement with a plausible time is worse than one with a gap.
   */
  it("prints a dash where a journal is silent rather than inventing a time", () => {
    useFleetStore.setState({ alertMeta: {} });
    useAuditStore.getState().reset();
    const { container } = renderReport();
    const acked = container.querySelector("[data-moment='acked']");
    expect(acked).toHaveTextContent("—");
    expect(within(acked as HTMLElement).getByText("Not recorded")).toBeInTheDocument();
    // The verdict is the one moment every incident has.
    expect(container.querySelector("[data-moment='verdict']")).toHaveTextContent(
      clockTime(VERDICT_TS),
    );
  });

  it("prints the figures an ops team is measured on, named in English and in acronym", () => {
    const { container } = renderReport();
    const figure = (label: string) =>
      container.querySelector(`[data-figure='${label}']`)?.textContent ?? "";
    expect(figure("Time to acknowledge")).toContain("1m 30s");
    expect(figure("Time to acknowledge")).toContain("MTTA");
    expect(figure("Time to diagnose")).toContain("1h 33m");
    expect(figure("Time to resolve")).toContain("1h 33m");
    expect(figure("Time to resolve")).toContain("MTTR");
  });
});

describe("the verdict", () => {
  it("leads in the page's own voice and quotes the instrument underneath it", () => {
    renderReport();
    expect(
      screen.getByText("Left knee actuator A-07: gain anomaly."),
    ).toBeInTheDocument();
    // Verbatim, attributed — a report cites where a banner translates.
    expect(
      screen.getByText("LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE"),
    ).toBeInTheDocument();
    expect(screen.getByText("Recorded by the diagnostic scan")).toBeInTheDocument();
  });

  it("tables every channel the scan measured, and marks the subject", () => {
    const { container } = renderReport();
    const subject = container.querySelector("[data-channel='knee_L']");
    expect(subject).toHaveTextContent("Left knee");
    expect(subject).toHaveTextContent("1.78×");
    expect(within(subject as HTMLElement).getByText("subject")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-channel]")).toHaveLength(3);
  });

  /**
   * A scan that found nothing is filed as joint "all" / anomaly "none", and it
   * is a real incident: the operator asked, and there is proof they asked. What
   * it must not do is print the sim's placeholder field as if it were a part.
   */
  it("does not name a part on a scan that found nothing", () => {
    const clean: IncidentRecord = {
      ...record,
      acknowledged: [],
      report: {
        ...report,
        joint: "all",
        component: "all",
        anomaly: "none",
        recommendations: ["No action required"],
      },
    };
    render(<IncidentReportSurface record={clean} onClose={onClose} />);
    expect(screen.getByText("Diagnostic complete — no anomaly.")).toBeInTheDocument();
    expect(screen.queryByText("all")).not.toBeInTheDocument();
  });

  /**
   * A record archived without traces — before they rode the record, or by a
   * scan that produced none — still gets an honest page.
   */
  it("says so plainly when the traces are not on file", () => {
    const unfiled: IncidentRecord = {
      id: record.id,
      unitId: record.unitId,
      report,
      acknowledged: record.acknowledged,
    };
    render(<IncidentReportSurface record={unfiled} onClose={onClose} />);
    expect(screen.getByText(/Channel measurements are not on file/)).toBeInTheDocument();
  });
});

describe("the differential", () => {
  /**
   * A diagnosis stated alone reads as a conviction. The trace proves the joint
   * is out of envelope, not why — so the report says what the measurement is
   * consistent with, and in what order to spend money on it.
   */
  it("states the confirmed signal, the candidates, and the order to try them in", () => {
    renderReport();
    expect(
      screen.getByText("Gain 1.78× reference envelope, two joints within tolerance."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Consistent with: control-gain drift · tendon wear · actuator degradation",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Recommended: unloaded recalibration before module replacement."),
    ).toBeInTheDocument();
  });

  it("renders no differential for an anomaly it has no entry for", () => {
    const clean: IncidentRecord = {
      ...record,
      report: { ...report, anomaly: "thermal" },
    };
    render(<IncidentReportSurface record={clean} onClose={onClose} />);
    expect(screen.queryByText(/Consistent with:/)).not.toBeInTheDocument();
  });
});

describe("confirmedSignal", () => {
  it("is derived from the channels, so it cannot drift from the table above it", () => {
    expect(
      confirmedSignal(report, [
        { joint: "knee_L", wave: wave(1.78), ref: REFERENCE },
        { joint: "knee_R", wave: wave(1), ref: REFERENCE },
      ]),
    ).toBe("Gain 1.78× reference envelope, one joint within tolerance.");
  });

  it("does not assert a measurement it does not have", () => {
    expect(confirmedSignal(report, [])).toMatch(/measurements are not on file/);
  });
});

describe("the evidence", () => {
  it("shows the failing joint against its opposite number", () => {
    const { container } = renderReport();
    const subject = container.querySelector("[data-evidence='knee_L']");
    const control = container.querySelector("[data-evidence='knee_R']");
    expect(within(subject as HTMLElement).getByText("Subject")).toBeInTheDocument();
    expect(within(control as HTMLElement).getByText("Control")).toBeInTheDocument();
    // Both traces are drawn: the live one and the reference it is judged against.
    expect(subject?.querySelector("[data-role='live']")).toBeInTheDocument();
    expect(subject?.querySelector("[data-role='reference']")).toBeInTheDocument();
  });
});

describe("the recalibration, once the cheap rung has been tried", () => {
  it("reads the before and after inside the subject's own frame", () => {
    const { container } = renderRecalibratedReport();
    const subject = container.querySelector("[data-evidence='knee_L']") as HTMLElement;

    // Still two figures, not three: the claim is that THIS channel came down.
    expect(container.querySelectorAll("[data-evidence]")).toHaveLength(2);
    expect(subject.querySelector("[data-role='pre']")).toBeInTheDocument();
    expect(subject.querySelector("[data-role='live']")).toBeInTheDocument();
    expect(within(subject).getByText(/1\.78× → 1\.34× reference/)).toBeInTheDocument();
  });

  it("says in operator voice what the attempt was worth", () => {
    renderRecalibratedReport();
    expect(
      screen.getByText(/unloaded recalibration was run over the link/i),
    ).toBeInTheDocument();
    // The consequence the terse machine-card version leaves implicit.
    expect(screen.getByText(/not a tendon/i)).toBeInTheDocument();
  });

  it("still prints what the evidence supported, above what was tried", () => {
    renderRecalibratedReport();
    // The differential is not replaced by the outcome; a reader deciding
    // whether to send a van needs both, in that order.
    expect(screen.getByText(/^Recommended: /)).toBeInTheDocument();
  });

  it("climbs the ladder: a remote attempt, then a technician", () => {
    // The recovery tier is a maximum, so the remote rung the recalibration
    // sits on has to be visible in the header WITHOUT pulling the dispatch
    // back down it — the ladder's one hard direction.
    expect(escalatedTier(["Recalibrate joint"])).toBe("remote operations");
    expect(escalatedTier(["Recalibrate joint", "Dispatch service"])).toBe(
      "field service",
    );
    renderRecalibratedReport();
    expect(screen.getAllByText(/field service/i).length).toBeGreaterThan(0);
  });

  it("says nothing about a calibration on an incident where none was run", () => {
    renderReport();
    expect(screen.queryByText(/unloaded recalibration was run/i)).toBeNull();
    expect(screen.queryByText(/→/)).toBeNull();
  });
});

describe("the chronology", () => {
  it("is this incident's window and not the whole shift", () => {
    useAuditStore.getState().append({
      ts: RESOLVED_AT + 3_600_000,
      kind: "alert-raised",
      unitId: "N-07",
      summary: "Sagebrush House: a later, unrelated fault",
      ref: "al-777",
    });

    renderReport();
    expect(screen.queryByText(/a later, unrelated fault/)).not.toBeInTheDocument();
    expect(screen.getByText("Diagnostic scan started")).toBeInTheDocument();
  });
});

describe("the actions", () => {
  it("stamps a recorded recommendation with the press this console saw, and its tier", () => {
    markAcknowledged("N-07", DIAG_AT, "Dispatch service", VERDICT_TS + 1_000);
    const { container } = renderReport();

    const row = container.querySelector("[data-action='Dispatch service']");
    expect(row).toHaveTextContent(`recorded ${clockTime(VERDICT_TS + 1_000)}`);
    expect(row).toHaveTextContent("field service");
  });

  it("says 'recorded' without a time rather than a time nobody observed", () => {
    const { container } = renderReport();
    const row = container.querySelector("[data-action='Dispatch service']");
    expect(row).toHaveTextContent("recorded");
    expect(row?.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("folds a command's three log beats into one row with its outcome", () => {
    useAuditStore.getState().append({
      ts: VERDICT_TS + 2_000,
      kind: "command-accepted",
      unitId: "N-07",
      summary: "SAFE SIT accepted",
      ref: "COMMAND_SAFE_SIT#3",
    });
    useAuditStore.getState().append({
      ts: VERDICT_TS + 2_600,
      kind: "command-complete",
      unitId: "N-07",
      summary: "SAFE SIT complete",
      ref: "COMMAND_SAFE_SIT#3",
    });

    const { container } = renderReport();
    const row = container.querySelector("[data-command='COMMAND_SAFE_SIT#3']");
    expect(row).toHaveTextContent("Safe sit");
    expect(row).toHaveTextContent(`complete ${clockTime(VERDICT_TS + 2_600)}`);
    expect(row).toHaveTextContent("remote operations");
  });

  it("says nothing happened, where nothing happened", () => {
    render(
      <IncidentReportSurface
        record={{ ...record, acknowledged: [] }}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("No actions were recorded or executed.")).toBeInTheDocument();
  });
});

describe("executedCommands", () => {
  it("prefers a refusal to a completion — the outcome is what the row is for", () => {
    const rows = executedCommands([
      {
        id: "2",
        ts: 2,
        kind: "command-failed",
        unitId: "N-07",
        summary: "",
        ref: "COMMAND_SAFE_SIT#1",
      },
      {
        id: "1",
        ts: 1,
        kind: "command-accepted",
        unitId: "N-07",
        summary: "",
        ref: "COMMAND_SAFE_SIT#1",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.failedAt).toBe(2);
  });

  it("ignores everything that is not a command", () => {
    expect(
      executedCommands([
        { id: "1", ts: 1, kind: "diag-start", unitId: "N-07", summary: "" },
      ]),
    ).toEqual([]);
  });
});

describe("the service record", () => {
  it("carries the fact that turns a measurement into a cause", () => {
    renderReport();
    expect(screen.getByText(/Left knee actuator · last serviced/)).toBeInTheDocument();
    expect(screen.getByText("33 days overdue")).toBeInTheDocument();
    expect(screen.getByText("Dispatch service recorded.")).toBeInTheDocument();
    expect(screen.getByText("Service records simulated")).toBeInTheDocument();
  });

  it("claims no dispatch where none was recorded", () => {
    render(
      <IncidentReportSurface
        record={{ ...record, acknowledged: [] }}
        onClose={onClose}
      />,
    );
    expect(screen.queryByText("Dispatch service recorded.")).not.toBeInTheDocument();
  });
});

describe("the document's frame", () => {
  it("says what it is and when it was made", () => {
    renderReport();
    expect(
      screen.getByText("Simulated data · generated by Fleet Console"),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Generated \d{2}:\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it("is a modal document, and Escape leaves it", () => {
    const { container } = renderReport();
    const root = container.querySelector("[data-slot='incident-report']");
    expect(root).toHaveAttribute("role", "dialog");
    expect(root).toHaveAttribute("aria-modal", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes focus on arrival and gives it back on the way out", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const { container, unmount } = renderReport();
    expect(document.activeElement).toBe(
      container.querySelector("[data-slot='incident-report']"),
    );

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps the console's own controls off the printed page", () => {
    renderReport();
    expect(screen.getByRole("button", { name: "Close" }).className).toContain(
      "print:hidden",
    );
  });
});
