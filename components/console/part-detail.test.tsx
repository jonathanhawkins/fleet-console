import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Posture, type UnitStatus, type VerdictReport } from "@/lib/schema";
import { useFleetStore, useIncidentStore } from "@/lib/stores";
import {
  componentHighlight,
  SERVICE_DISCLAIMER,
  serviceRecord,
  type ComponentHighlight,
} from "./component-spec";
import { incidentReportSnapshot, resetIncidentReport } from "./incident-report";
import { PartDetail } from "./part-detail";

/**
 * The card that turns a selection into a diagnosis.
 *
 * Every line on it had to earn its place against one question — *does this
 * change what the operator does next?* — so the tests are about the four
 * answers rather than about the layout: the live readings come from the same
 * rings and wear the same tone as the strips, the service record says when the
 * part was last touched and admits that it is simulated, the posture note
 * exists to stop one specific misreading, and the incident block only appears
 * on the part the incident is actually about.
 *
 * The readings are on the app's one-second ticker (relative-time.ts), which is
 * a real timer: the fake clock below is what lets a test see a number at all.
 */

const REPORT: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LEFT KNEE ACTUATOR A-07 GAIN ANOMALY",
  recommendations: ["Schedule service"],
  ts: 1_700_000_000_000,
};

function seed(status: UnitStatus = "nominal", posture?: Posture) {
  act(() => {
    useFleetStore.getState().applySnapshot({
      t: "fleet_snapshot",
      units: [
        {
          id: "N-07",
          name: "Sagebrush House",
          status,
          battery: 84,
          posture,
          pos: { lat: 44.06, lng: -121.28 },
        },
      ],
    });
  });
}

/** One batch across the joints a leg and a knee actuator between them own. */
function push(temps: { knee: number; hip: number; ankle: number }) {
  act(() => {
    useFleetStore.getState().applyTelemetry({
      t: "telemetry",
      unitId: "N-07",
      ts: 1_700_000_000_000,
      batch: [
        {
          joint: "knee_L",
          battery: 84,
          tempC: temps.knee,
          torqueNm: 12.4,
          currentA: 1.62,
        },
        { joint: "hip_L", battery: 84, tempC: temps.hip, torqueNm: 18.1, currentA: 2.05 },
        {
          joint: "ankle_L",
          battery: 84,
          tempC: temps.ankle,
          torqueNm: 8.3,
          currentA: 1.11,
        },
      ],
    });
  });
}

function diagnose() {
  act(() => {
    const store = useIncidentStore.getState();
    store.beginDescent("N-07");
    store.applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    store.applyDiagEvent({
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "verdict", report: REPORT },
    });
    store.completeAscent();
  });
}

/** The highlight the page would have derived, so the card is fed what it is fed. */
function flagged(status: UnitStatus = "red"): ComponentHighlight | null {
  return componentHighlight({
    status,
    alertMessage: "N-07: left knee actuator overheating",
    flaggedJoint: null,
    verdictJoint: null,
  });
}

/** Advance past the one-second ticker's first tick so the numerals exist. */
function tick() {
  act(() => {
    vi.advanceTimersByTime(1_100);
  });
}

const readings = (): string[] =>
  [...document.querySelectorAll("[data-slot='part-reading']")].map(
    (el) => el.textContent ?? "",
  );

beforeEach(() => {
  vi.useFakeTimers();
  useFleetStore.getState().reset();
  useIncidentStore.getState().reset();
  resetIncidentReport();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PartDetail readings", () => {
  it("names the part and prints its joint's three measures", () => {
    seed();
    push({ knee: 38.2, hip: 35, ankle: 33 });
    render(<PartDetail unitId="N-07" part="knee_actuator_L" highlight={null} />);
    tick();

    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
      "Left knee actuator",
    );
    // Heat, effort, draw — the same three the strips draw, at the same
    // precision, with the metric's own unit.
    // No space in the text: the gap between figure and unit is a margin, the
    // same way the strips set it.
    expect(readings()).toEqual(["38.2°C", "12.4N·m", "1.62A"]);
  });

  it("gives a leg both the joints it carries, each named", () => {
    seed();
    push({ knee: 38, hip: 35.5, ankle: 33.1 });
    render(<PartDetail unitId="N-07" part="leg_L" highlight={null} />);
    tick();

    expect(screen.getByText("Left hip")).toBeVisible();
    expect(screen.getByText("Left ankle")).toBeVisible();
    expect(readings()).toEqual([
      "35.5°C",
      "18.1N·m",
      "2.05A",
      "33.1°C",
      "8.3N·m",
      "1.11A",
    ]);
    // The knee is a part of its own; a leg does not annex it.
    expect(screen.queryByText("Left knee")).not.toBeInTheDocument();
  });

  it("does not label a single joint under a part that already names it", () => {
    seed();
    push({ knee: 38, hip: 35, ankle: 33 });
    render(<PartDetail unitId="N-07" part="knee_actuator_L" highlight={null} />);
    tick();
    // "Left knee" directly under "Left knee actuator" is a label for a label.
    expect(screen.queryByText("Left knee")).not.toBeInTheDocument();
  });

  it("says plainly that a part carries no instruments", () => {
    seed();
    render(<PartDetail unitId="N-07" part="torso" highlight={null} />);
    tick();

    expect(screen.getByText(/No instrumented joints on this part/)).toBeVisible();
    expect(readings()).toEqual([]);
    // …and the card is still a card: a selection that produced nothing would
    // read as a broken control.
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Torso");
  });

  it("prints em-dashes rather than inventing a reading it does not have", () => {
    seed();
    render(<PartDetail unitId="N-07" part="knee_actuator_L" highlight={null} />);
    tick();
    expect(readings().join("")).toMatch(/^(—No reading yet){3}$/);
  });

  it("borrows the strips' tone, so the card and the grid cannot disagree", () => {
    seed("red");
    push({ knee: 58, hip: 35, ankle: 33 }); // well over the knee's 44 °C ceiling
    render(<PartDetail unitId="N-07" part="knee_actuator_L" highlight={flagged()} />);
    tick();

    const temp = document.querySelector(
      "[data-slot='part-reading'][data-metric='tempC']",
    )!;
    expect(temp.className).toContain("text-alert-ink");
    // Effort and draw are inside their own envelopes and stay ink: the tone is
    // per measure, not per part.
    const torque = document.querySelector(
      "[data-slot='part-reading'][data-metric='torqueNm']",
    )!;
    expect(torque.className).toContain("text-ink");
    expect(torque.className).not.toContain("alert");
  });

  it("states a status for the part, quietly, and only claims trouble on the flagged one", () => {
    seed("red");
    const { rerender } = render(
      <PartDetail unitId="N-07" part="knee_actuator_L" highlight={flagged()} />,
    );
    tick();
    expect(screen.getByText("Attention")).toBeVisible();

    rerender(<PartDetail unitId="N-07" part="knee_actuator_R" highlight={flagged()} />);
    expect(screen.getByText("Nominal")).toBeVisible();
  });
});

describe("PartDetail posture note", () => {
  it("explains a sitting leg's low readings rather than letting them read as recovery", () => {
    seed("red", "sitting");
    push({ knee: 52, hip: 35, ankle: 33 });
    render(<PartDetail unitId="N-07" part="knee_actuator_L" highlight={flagged()} />);
    tick();

    expect(screen.getByText(/carrying nothing/)).toBeVisible();
    expect(screen.getByText(/Temperature is still/)).toBeVisible();
  });

  it("says nothing about posture on a walking unit", () => {
    seed("red");
    push({ knee: 52, hip: 35, ankle: 33 });
    render(<PartDetail unitId="N-07" part="knee_actuator_L" highlight={flagged()} />);
    tick();
    expect(screen.queryByText(/carrying nothing/)).not.toBeInTheDocument();
  });

  it("says nothing about a sitting head, which was never carrying anything", () => {
    seed("red", "sitting");
    render(<PartDetail unitId="N-07" part="head" highlight={null} />);
    tick();
    expect(screen.queryByText(/carrying nothing/)).not.toBeInTheDocument();
  });
});

describe("PartDetail service record", () => {
  it("dates the last service, quotes the note, and admits it is simulated", () => {
    seed();
    render(<PartDetail unitId="N-07" part="knee_actuator_R" highlight={null} />);
    tick();

    expect(screen.getByText(serviceRecord("knee_actuator_R").note)).toBeVisible();
    expect(screen.getByText(SERVICE_DISCLAIMER)).toBeVisible();
    // A real date, derived against the app's clock rather than hardcoded.
    expect(screen.getByText(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/)).toBeVisible();
  });

  it("counts down to the next service, and counts up once it is late", () => {
    seed();
    const { rerender } = render(
      <PartDetail unitId="N-07" part="knee_actuator_R" highlight={null} />,
    );
    tick();
    expect(screen.getByText("Due in 143 days")).toBeVisible();

    // The overdue part is the one the incident is about — the fact that turns
    // "running hot" into "running hot, past its service".
    rerender(<PartDetail unitId="N-07" part="knee_actuator_L" highlight={null} />);
    const overdue = screen.getByText("33 days overdue");
    expect(overdue).toBeVisible();
    expect(overdue.className).toContain("text-warn-ink");
  });
});

describe("PartDetail incident linkage", () => {
  it("stays quiet on a part the incident is not about", () => {
    seed("red");
    diagnose();
    render(<PartDetail unitId="N-07" part="leg_R" highlight={null} />);
    tick();
    expect(screen.queryByText(/incident/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Open incident report INC-/ }),
    ).not.toBeInTheDocument();
  });

  it("says the part is implicated before anything has been diagnosed", () => {
    seed("red");
    render(<PartDetail unitId="N-07" part="knee_actuator_L" highlight={flagged()} />);
    tick();

    expect(screen.getByText(/open incident/i)).toBeVisible();
    // No record on file yet, so nothing to link to and nothing offered.
    expect(
      screen.queryByRole("button", { name: /Open incident report INC-/ }),
    ).not.toBeInTheDocument();
  });

  /**
   * This used to scroll the page to the matching history row, which was
   * right while the row *was* the record. There is a full report now, and this
   * link is three components deep inside a 3D scene — so it opens the document
   * through the same module signal the history's own id uses, rather than
   * threading a callback down through the component view.
   */
  it("opens the full report once a record is filed", () => {
    seed("red");
    diagnose();
    render(<PartDetail unitId="N-07" part="knee_actuator_L" highlight={flagged()} />);
    tick();

    expect(incidentReportSnapshot()).toBeNull();

    const link = screen.getByRole("button", { name: /^Open incident report INC-/ });
    expect(link).toHaveTextContent(`INC-N07-${REPORT.ts.toString(36).toUpperCase()}`);
    fireEvent.click(link);

    expect(incidentReportSnapshot()).toBe(`inc-N-07-${REPORT.ts}`);
  });

  it("does not offer a record filed about a different part", () => {
    seed("red");
    diagnose(); // the record names knee_L, which resolves to the left actuator
    render(<PartDetail unitId="N-07" part="leg_L" highlight={null} />);
    tick();
    expect(
      screen.queryByRole("button", { name: /^Open incident report INC-/ }),
    ).not.toBeInTheDocument();
  });
});
