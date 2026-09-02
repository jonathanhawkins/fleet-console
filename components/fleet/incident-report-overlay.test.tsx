import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type VerdictReport } from "@/lib/schema";
import { useAuditStore, useFleetStore, useIncidentStore } from "@/lib/stores";
import { IncidentReport, REPORT_ATTR } from "./incident-report-overlay";
import {
  closeIncidentReport,
  openIncidentReport,
  resetIncidentReport,
} from "./incident-report";

/**
 * The gate holds two things the document itself cannot: the door — nothing
 * renders until an operator asks, and the document stays its own chunk — and
 * what happens to the page underneath while the report is over it.
 */

/**
 * The document behind the gate is a `next/dynamic` chunk, and the first open
 * pays for it — on a cold module graph that is a Vite transform of the surface
 * and everything under it, not an import. Alone that is tens of milliseconds;
 * inside a full parallel suite, sharing one transform server with seventy other
 * files, it outruns `findByRole`'s 1000 ms wait and fails a test whose subject
 * is not loading at all (the same failure, and the same fix, as the descent
 * stage). Importing the same specifier here pays the cost once,
 * before any assertion's clock starts, and leaves the component's dynamic
 * import resolving from cache. The gate discipline this file protects — nothing
 * rendered until an operator asks — is asserted before any open and is
 * untouched by how fast the chunk arrives.
 *
 * The explicit timeout is for the transform itself, which is a build cost and
 * has no business being measured against a test's five-second default.
 */
beforeAll(async () => {
  await import("./incident-report-surface");
}, 60_000);

const VERDICT_TS = 1_700_000_000_000;

const report: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE",
  recommendations: ["Dispatch service"],
  ts: VERDICT_TS,
};

const INCIDENT_ID = `inc-N-07-${VERDICT_TS}`;

/** The scan, as the wire drives it: start, one channel, verdict, ascend. */
function runDiagnostic({ ascend = true }: { ascend?: boolean } = {}) {
  act(() => {
    const store = useIncidentStore.getState();
    store.beginDescent("N-07");
    store.applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    store.applyDiagEvent({
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "channel", joint: "knee_L", wave: [0.2, 0.4], ref: [0.1, 0.2] },
    });
    store.applyDiagEvent({
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "verdict", report },
    });
    if (ascend) store.completeAscent();
  });
}

beforeEach(() => {
  useFleetStore.getState().reset();
  useIncidentStore.getState().reset();
  useAuditStore.getState().reset();
  resetIncidentReport();
  document.documentElement.removeAttribute(REPORT_ATTR);
  useFleetStore.getState().applySnapshot({
    t: "fleet_snapshot",
    units: [
      {
        id: "N-07",
        name: "Sagebrush House",
        status: "red",
        battery: 80,
        pos: { lat: 44.06, lng: -121.28 },
      },
    ],
  });
});

describe("IncidentReport gate", () => {
  it("renders nothing until an operator asks for a report", () => {
    const { container } = render(<IncidentReport unitId="N-07" />);
    runDiagnostic();
    expect(container).toBeEmptyDOMElement();
    expect(document.documentElement).not.toHaveAttribute(REPORT_ATTR);
  });

  /**
   * The evidence rides the record, not this gate: `completeAscent()` files the
   * channels and the session clock on the archive itself, so a console that
   * was not open when the scan ended still has exhibits to report. The scan
   * here runs to its verdict before any gate exists, and the document still
   * tables the traces.
   */
  it("reports evidence archived by a scan no console was watching", async () => {
    runDiagnostic(); // completes before the gate is mounted

    const archived = useIncidentStore.getState().history[0];
    expect(archived?.id).toBe(INCIDENT_ID);
    expect(archived?.channels?.map((c) => c.joint)).toEqual(["knee_L"]);
    expect(archived?.startedAt).toEqual(expect.any(Number));

    render(<IncidentReport unitId="N-07" />);
    act(() => openIncidentReport(INCIDENT_ID));

    await screen.findByRole("heading", { name: "Incident report" });
    expect(document.querySelector("[data-channel='knee_L']")).not.toBeNull();
  });

  it("opens the document, and marks the root so the page can be printed", async () => {
    render(<IncidentReport unitId="N-07" />);
    runDiagnostic();

    act(() => openIncidentReport(INCIDENT_ID));

    expect(
      await screen.findByRole("heading", { name: "Incident report" }),
    ).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute(REPORT_ATTR, "open");
    // The page underneath is locked while the document is over it.
    expect(document.documentElement.style.overflow).toBe("hidden");
  });

  it("gives the page back on close", async () => {
    render(<IncidentReport unitId="N-07" />);
    runDiagnostic();
    act(() => openIncidentReport(INCIDENT_ID));
    await screen.findByRole("heading", { name: "Incident report" });

    act(() => closeIncidentReport());

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Incident report" }),
      ).not.toBeInTheDocument();
    });
    expect(document.documentElement).not.toHaveAttribute(REPORT_ATTR);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("opens nothing for a record belonging to another unit", async () => {
    render(<IncidentReport unitId="N-01" />);
    runDiagnostic();
    act(() => openIncidentReport(INCIDENT_ID));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Incident report" }),
      ).not.toBeInTheDocument();
    });
  });
});
