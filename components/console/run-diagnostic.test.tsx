import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type OperatorCommand, type UnitStatus, type VerdictReport } from "@/lib/schema";
import { useFleetStore, useIncidentStore } from "@/lib/stores";
import { type TelemetryTransport } from "@/lib/transport";
import { IncidentBanner } from "./incident-banner";
import { IncidentHistory } from "./incident-history";
import { setCommandTransport } from "./telemetry-command";
import { UnitIdentity } from "./unit-identity";

/**
 * the diagnostic must be reachable from every state a unit can be in,
 * and reachable from exactly one place at a time.
 *
 * Two failures this file exists to catch. A page with *no* run control — which
 * is what every unit except an undiagnosed troubled one had before this,
 * including every healthy unit in the fleet and every unit the operator had
 * just finished diagnosing. And a page with *two*, which is what happens the
 * moment the banner and the identity header each decide for themselves whether
 * the other one is rendering.
 *
 * The third property is the one that is invisible until it is wrong: the sim
 * runs one scan at a time (sim/engine.ts drops a second RUN_DIAGNOSTIC), so a
 * run control that stays live during someone else's scan is a control that
 * sends a command into a void.
 */

const sent: OperatorCommand[] = [];

const transport: TelemetryTransport = {
  connect: () => {},
  send: (cmd) => sent.push(cmd),
  disconnect: () => {},
};

function seed(status: UnitStatus, id = "N-07") {
  act(() => {
    useFleetStore.getState().applySnapshot({
      t: "fleet_snapshot",
      units: [
        {
          id,
          name: "Sagebrush House",
          status,
          battery: 84,
          pos: { lat: 44.06, lng: -121.28 },
        },
      ],
    });
  });
}

const ANOMALY: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LEFT KNEE ACTUATOR A-07: GAIN ANOMALY.",
  recommendations: ["Dispatch service"],
  ts: 1_700_000_000_000,
};

/** What the sim serves a unit with nothing wrong with it (sim/engine.ts). */
const CLEAN: VerdictReport = {
  unitId: "N-07",
  joint: "all",
  component: "all",
  anomaly: "none",
  summary: "SCAN COMPLETE. 6 CHANNELS WITHIN TOLERANCE. NO ANOMALY DETECTED.",
  recommendations: ["No action required"],
  ts: 1_700_000_000_000,
};

/** Run a whole scan to its verdict and come back up with it. */
function scanTo(report: VerdictReport, unitId = "N-07") {
  act(() => {
    const incident = useIncidentStore.getState();
    incident.beginDescent(unitId);
    incident.applyDiagEvent({ t: "diag_event", unitId, ev: { k: "scan_start" } });
    incident.applyDiagEvent({ t: "diag_event", unitId, ev: { k: "verdict", report } });
    incident.completeAscent();
  });
}

beforeEach(() => {
  useFleetStore.getState().reset();
  useIncidentStore.getState().reset();
  sent.length = 0;
  setCommandTransport(transport);
});

/** Both surfaces at once — the only way to assert "exactly one of them". */
function UnitPage({ unitId = "N-07" }: { unitId?: string }) {
  return (
    <>
      <UnitIdentity unitId={unitId} />
      <IncidentBanner unitId={unitId} />
    </>
  );
}

describe("the run control's home", () => {
  it("sits in the identity header when the unit has nothing to say", async () => {
    seed("nominal");
    const { container } = render(<UnitPage />);

    expect(container.querySelector('[data-slot="incident-banner"]')).toBeNull();
    const run = screen.getByRole("button", { name: "Run diagnostic" });
    expect(run).toBeEnabled();

    await userEvent.click(run);

    // The pair, unbroken: the wire command and the local session (see
    // telemetry-command.ts).
    expect(sent).toEqual([{ c: "RUN_DIAGNOSTIC", unitId: "N-07" }]);
    expect(useIncidentStore.getState().phase).toBe("descending");
  });

  it("moves to the banner's black pill the moment the unit is troubled", () => {
    seed("red");
    render(<UnitPage />);

    // Exactly one, and it is the loud one.
    const buttons = screen.getAllByRole("button", { name: /run diagnostic/i });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute("data-variant", "primary");
  });

  it("offers a re-run once a service-worthy incident is on file", async () => {
    seed("red");
    scanTo(ANOMALY);
    render(<UnitPage />);

    expect(screen.getByText("Diagnostic complete — service recommended")).toBeVisible();
    const again = screen.getByRole("button", { name: "Run diagnostic again" });
    // A quiet tool, not a second call to action: one black pill per screen.
    expect(again).toHaveAttribute("data-variant", "secondary");
    expect(screen.queryAllByRole("button", { name: "Run diagnostic" })).toHaveLength(0);

    await userEvent.click(again);
    expect(sent).toEqual([{ c: "RUN_DIAGNOSTIC", unitId: "N-07" }]);
    expect(useIncidentStore.getState().phase).toBe("descending");
  });

  it("stays silent after a clean pass and hands the control back to the header", () => {
    seed("nominal");
    scanTo(CLEAN);
    render(<UnitPage />);

    // No standing "all clear" banner — the record went to the history, which is
    // where a record belongs, and the page has nothing left to say.
    expect(screen.queryByText(/service recommended/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Diagnostic complete/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run diagnostic" })).toBeEnabled();
  });
});

describe("one scan at a time", () => {
  it("locks every run control while any unit is being scanned", () => {
    seed("nominal");
    act(() => useIncidentStore.getState().beginDescent("N-03"));
    render(<UnitPage />);

    const run = screen.getByRole("button", { name: "Run diagnostic" });
    expect(run).toBeDisabled();
    // Greyed out *with a reason*: nothing else on a healthy unit's page
    // explains why the button went quiet.
    expect(run).toHaveAccessibleDescription("Diagnostic in progress");
  });

  it("releases them when the session ends", () => {
    seed("nominal");
    act(() => useIncidentStore.getState().beginDescent("N-03"));
    render(<UnitPage />);
    expect(screen.getByRole("button", { name: "Run diagnostic" })).toBeDisabled();

    act(() => useIncidentStore.getState().abortSession());
    const run = screen.getByRole("button", { name: "Run diagnostic" });
    expect(run).toBeEnabled();
    expect(run).toHaveAccessibleDescription("");
  });

  it("hides the header control while this unit's own scan is in progress", () => {
    seed("nominal");
    render(<UnitPage />);
    act(() => {
      useIncidentStore
        .getState()
        .applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    });

    // The banner has taken over the page's voice; a run control in the header
    // beside it would be a second answer to a question already answered.
    expect(screen.getByText("Diagnostic in progress", { selector: "p" })).toBeVisible();
    expect(screen.queryAllByRole("button", { name: /run diagnostic/i })).toHaveLength(0);
  });
});

describe("the healthy verdict, in operator space", () => {
  it("logs a clean pass as a plain record rather than a finding about a part", () => {
    seed("nominal");
    scanTo(CLEAN);
    render(<IncidentHistory unitId="N-07" />);

    // `all / all / none` run through the failing branch read "All all: none
    // anomaly." — a page describing a shape it had never been shown.
    expect(screen.getByText("Diagnostic complete — no anomaly.")).toBeVisible();
    // …and no "No actions acknowledged": the healthy verdict offers no actions
    // to acknowledge, so reporting the absence of one would report a lapse
    // that was never possible.
    expect(screen.queryByText("No actions acknowledged.")).not.toBeInTheDocument();
  });

  it("keeps the anomaly line in the operator's own voice", () => {
    seed("red");
    scanTo(ANOMALY);
    render(<IncidentHistory unitId="N-07" />);

    expect(screen.getByText("Left knee actuator A-07: gain anomaly.")).toBeVisible();
    expect(screen.queryByText(ANOMALY.summary)).not.toBeInTheDocument();
  });
});
