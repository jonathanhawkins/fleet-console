// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DiagEvent, type UnitStatus, type VerdictReport } from "@/lib/schema";
import { useAuditStore, useFleetStore, useIncidentStore } from "@/lib/stores";
import { setDiagnosticView } from "@/lib/prefs/diagnostic-view";
import { DiagnosticPanel } from "./panel";

/**
 * The scan, on the page that motivated it.
 *
 * Two properties carry most of the design and both are asserted here. The
 * column **does not grow**: all six joints are rows from the first paint, so a
 * channel landing fills a cell rather than pushing the page down under an
 * operator who is reading it. And the panel **holds nothing the store does
 * not**, which is what lets the same session be rendered here and on the dark
 * board without the two being able to disagree.
 */

const JOINTS = ["hip_L", "hip_R", "knee_L", "knee_R", "ankle_L", "ankle_R"];

const wave = (gain: number) =>
  Array.from({ length: 40 }, (_, i) => Math.sin((i / 40) * Math.PI * 4) * gain);

const REPORT: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LEFT KNEE ACTUATOR A-07: GAIN ANOMALY.",
  // The wire's own order, recalibrate first — which the panel reorders.
  recommendations: [
    "Recalibrate joint",
    "Command safe sit",
    "Disable joint",
    "Dispatch service",
  ],
  ts: 1_700_000_000_000,
};

function seed(status: UnitStatus = "red", posture: "walking" | "sitting" = "walking") {
  act(() => {
    useFleetStore.getState().applySnapshot({
      t: "fleet_snapshot",
      units: [
        {
          id: "N-07",
          name: "Elm House",
          status,
          battery: 71,
          posture,
          pos: { lat: 44.06, lng: -121.28 },
        },
      ],
    });
  });
}

const send = (ev: DiagEvent, unitId = "N-07") =>
  act(() => {
    useIncidentStore.getState().applyDiagEvent({ t: "diag_event", unitId, ev });
  });

function openScan() {
  act(() => useIncidentStore.getState().beginDescent("N-07"));
  send({ k: "scan_start" });
}

beforeEach(() => {
  // The column is canvas-backed; jsdom has neither a ResizeObserver nor a 2d
  // backend. Neither is what these tests are about — the readings, the gate and
  // the row count are all DOM.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

  useFleetStore.getState().reset();
  useIncidentStore.getState().reset();
  useAuditStore.getState().reset();
  setDiagnosticView("calm");
});

afterEach(() => {
  setDiagnosticView("calm");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DiagnosticPanel", () => {
  it("says nothing when no scan is open", () => {
    seed();
    const { container } = render(<DiagnosticPanel unitId="N-07" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("ignores a scan running on another unit", () => {
    seed();
    act(() => useIncidentStore.getState().beginDescent("N-03"));
    send({ k: "scan_start" }, "N-03");
    const { container } = render(<DiagnosticPanel unitId="N-07" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stands all six channel rows up before a single one has reported", () => {
    seed();
    openScan();
    render(<DiagnosticPanel unitId="N-07" />);

    const rows = document.querySelectorAll("[data-channel]");
    expect(rows).toHaveLength(6);
    // Dashed, not absent: the cell exists and is honest about being empty.
    for (const row of rows) expect(row.textContent).toContain("—");
  });

  it("fills a row in place when its channel lands, without adding rows", () => {
    seed();
    openScan();
    render(<DiagnosticPanel unitId="N-07" />);

    send({ k: "channel", joint: "knee_L", wave: wave(1.8), ref: wave(1) });

    expect(document.querySelectorAll("[data-channel]")).toHaveLength(6);
    const knee = document.querySelector('[data-channel="knee_L"]')!;
    expect(knee.textContent).not.toContain("—");
    // …and every joint that has not reported is still dashed.
    expect(document.querySelector('[data-channel="hip_L"]')!.textContent).toContain("—");
  });

  it("counts progress in wire events rather than in seconds", () => {
    seed();
    openScan();
    render(<DiagnosticPanel unitId="N-07" />);

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemax", "26");
    expect(bar).toHaveAttribute("aria-valuenow", "0");

    send({ k: "walk", path: "/sys/core/heartbeat.svc" });
    send({ k: "walk", path: "/sys/core/power_rail/v48_main" });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
  });

  it("names the subject once the scan flags it, and only once", () => {
    seed();
    openScan();
    render(<DiagnosticPanel unitId="N-07" />);
    for (const joint of JOINTS) {
      send({
        k: "channel",
        joint,
        wave: wave(joint === "knee_L" ? 1.8 : 1),
        ref: wave(1),
      });
    }
    expect(document.querySelectorAll("[data-subject]")).toHaveLength(0);

    send({ k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" });

    const flagged = document.querySelectorAll("[data-subject]");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.getAttribute("data-channel")).toBe("knee_L");
  });

  it("states the finding with the part written the way a work order writes it", () => {
    seed();
    openScan();
    render(<DiagnosticPanel unitId="N-07" />);
    send({ k: "channel", joint: "knee_L", wave: wave(1.8), ref: wave(1) });
    send({ k: "verdict", report: REPORT });

    expect(screen.getByRole("heading", { name: /Actuator A-07/ })).toBeVisible();
    // The machine's own sentence is quoted, not paraphrased into our voice.
    expect(screen.getByText(REPORT.summary)).toBeVisible();
  });

  it("leads the acting group with the control that unblocks the other one", () => {
    seed("red", "walking");
    openScan();
    render(<DiagnosticPanel unitId="N-07" />);
    send({ k: "verdict", report: REPORT });

    const acting = screen
      .getByRole("heading", { name: /Act on the unit/i })
      .closest("section")!;
    const rows = within(acting)
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    // Safe sit seats the unit; recalibrate needs it seated. The report lists
    // them the other way round, and the panel does not.
    expect(rows[0]).toContain("Command safe sit");
    expect(rows[1]).toContain("Recalibrate joint");
  });

  it("prints the posture gate on the control rather than hiding the recommendation", async () => {
    seed("red", "walking");
    openScan();
    render(<DiagnosticPanel unitId="N-07" />);
    send({ k: "verdict", report: REPORT });

    const disable = screen.getByText("Disable joint").closest("li")!;
    const button = within(disable).getByRole("button");
    expect(button).toBeDisabled();
    expect(disable.textContent).toMatch(/seated/i);
    expect(button).toHaveAccessibleDescription(/seated/i);
  });

  it("lifts the gate once the unit is actually sitting", () => {
    seed("red", "sitting");
    openScan();
    render(<DiagnosticPanel unitId="N-07" />);
    send({ k: "verdict", report: REPORT });

    const disable = screen.getByText("Disable joint").closest("li")!;
    expect(within(disable).getByRole("button")).toBeEnabled();
  });

  it("opens a command's confirmation with the harmless control focused", async () => {
    seed("red", "walking");
    openScan();
    render(<DiagnosticPanel unitId="N-07" />);
    send({ k: "verdict", report: REPORT });

    const row = screen.getByText("Command safe sit").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Command" }));

    const gate = screen.getByRole("alertdialog");
    expect(within(gate).getByRole("button", { name: "Cancel" })).toHaveFocus();
    // The consequence an operator is most likely to drop is on screen.
    expect(gate.textContent).toMatch(/Service still required/i);
  });

  it("records a filed recommendation without sending anything to the robot", async () => {
    seed("red", "sitting");
    openScan();
    render(<DiagnosticPanel unitId="N-07" />);
    send({ k: "verdict", report: REPORT });

    const row = screen.getByText("Dispatch service").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Record" }));

    expect(useIncidentStore.getState().session?.acknowledged).toContain(
      "Dispatch service",
    );
  });

  it("rebuilds itself from the store when it remounts mid-scan", () => {
    seed();
    openScan();
    const view = render(<DiagnosticPanel unitId="N-07" />);
    send({ k: "walk", path: "/sys/core/heartbeat.svc" });
    send({ k: "channel", joint: "knee_L", wave: wave(1.8), ref: wave(1) });
    view.unmount();

    render(<DiagnosticPanel unitId="N-07" />);
    // The panel kept nothing; the session did.
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
    expect(document.querySelector('[data-channel="knee_L"]')!.textContent).not.toContain(
      "—",
    );
  });
});
