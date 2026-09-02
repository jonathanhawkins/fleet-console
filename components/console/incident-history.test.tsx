import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type VerdictReport } from "@/lib/schema";
import { useAuditStore, useFleetStore, useIncidentStore } from "@/lib/stores";
import { IncidentHistory } from "./incident-history";
import { incidentReportSnapshot, resetIncidentReport } from "./incident-report";

/**
 * The row the whole golden path exists to produce. Two Phase 10 additions are
 * pinned here: it says how long the incident took, and its reference
 * is the way into the full report.
 */

const T0 = 1_700_000_000_000;
const VERDICT_TS = T0 + 5_700_000; // 1h 35m after the raise

const report: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE",
  recommendations: ["Disable joint", "Command safe sit", "Dispatch service"],
  ts: VERDICT_TS,
};

const INCIDENT_ID = `inc-N-07-${VERDICT_TS}`;

function seedIncident() {
  useIncidentStore.setState({
    history: [
      { id: INCIDENT_ID, unitId: "N-07", report, acknowledged: ["Dispatch service"] },
    ],
  });
}

function seedAlert(resolvedAt?: number) {
  useFleetStore.getState().applyAlert({
    t: "alert",
    alert: {
      id: "al-001",
      unitId: "N-07",
      severity: "amber",
      message: "Sagebrush House: left knee actuator running hot",
      ts: T0,
    },
  });
  if (resolvedAt === undefined) return;
  useFleetStore.setState((s) => ({
    alertMeta: {
      ...s.alertMeta,
      "al-001": { resolvedAt, resolution: { via: "incident", ref: INCIDENT_ID } },
    },
  }));
}

beforeEach(() => {
  useFleetStore.getState().reset();
  useIncidentStore.getState().reset();
  useAuditStore.getState().reset();
  resetIncidentReport();
});

describe("IncidentHistory", () => {
  it("says nothing at all until a scan has reached a verdict", () => {
    const { container } = render(<IncidentHistory unitId="N-07" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("prints the finding in the page's own voice, with the moment it landed", () => {
    seedIncident();
    render(<IncidentHistory unitId="N-07" />);
    expect(screen.getByText("Left knee actuator A-07: gain anomaly.")).toBeVisible();
    expect(screen.getByText(/Acknowledged: dispatch service/)).toBeVisible();
  });

  /**
   * An alert raised at 18:07 and closed at 19:42 is a very different
   * call from one closed at 18:09, and both rows read identically without this.
   */
  it("carries how long the whole incident took", () => {
    seedIncident();
    seedAlert(T0 + 5_760_000); // 1h 36m after the raise
    render(<IncidentHistory unitId="N-07" />);

    expect(screen.getByText("Raised → resolved")).toBeVisible();
    expect(screen.getByText("1h 36m")).toBeVisible();
  });

  it("has no elapsed time for an incident that closed nothing", () => {
    seedIncident();
    seedAlert(); // still standing
    render(<IncidentHistory unitId="N-07" />);
    expect(screen.queryByText("Raised → resolved")).not.toBeInTheDocument();
  });

  /**
   * The id was already the row's reference — the string an operator
   * reads down a phone — so it is what opens the report, rather than a second
   * control beside it meaning the same record.
   */
  it("opens the full report from the reference itself", () => {
    seedIncident();
    render(<IncidentHistory unitId="N-07" />);

    const id = screen.getByRole("button", { name: /Open incident report INC-N07-/ });
    expect(id).toBeVisible();
    expect(incidentReportSnapshot()).toBeNull();

    fireEvent.click(id);
    expect(incidentReportSnapshot()).toBe(INCIDENT_ID);
  });

  /**
   * One gesture, one meaning: pressing the reference opens the report
   * and does nothing else. A live deploy observed the id click writing the OS
   * clipboard alongside the open; no code in this console writes the clipboard
   * and none may start — a press on the id must never double as a copy. If a
   * copy-id affordance is ever wanted, it belongs in the report header as its
   * own explicit control, not riding this click.
   */
  it("pressing the reference does not touch the clipboard", () => {
    const writeText = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;

    seedIncident();
    render(<IncidentHistory unitId="N-07" />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open incident report INC-N07-/ }),
    );

    expect(incidentReportSnapshot()).toBe(INCIDENT_ID); // the one meaning
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("keeps the record's own anchor, so a link from elsewhere can still find it", () => {
    seedIncident();
    const { container } = render(<IncidentHistory unitId="N-07" />);
    expect(
      container.querySelector(`[data-incident="${INCIDENT_ID}"]`),
    ).toBeInTheDocument();
  });
});
