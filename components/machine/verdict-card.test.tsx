import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type DiagEventMessage, type VerdictReport } from "@/lib/schema";
import { useIncidentStore, type DiagSession } from "@/lib/stores";
import { resetAcknowledgedTimes } from "./safe-sit-copy";
import { pairJoint, VerdictCard, VerdictStrip } from "./verdict-card";

/**
 * the card is rendered from a canned session, so what it says is
 * pinned to what the report actually contains — the headline, the machine's own
 * summary, the evidence, and the three recommendations *the report carries*
 * rather than three hardcoded strings that happen to match today.
 */

const report: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary:
    "LEFT KNEE ACTUATOR A-07: GAIN ANOMALY. LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE.",
  recommendations: [
    "Recalibrate joint",
    "Command safe sit",
    "Disable joint",
    "Dispatch service",
  ],
  ts: 120_000,
};

const ref = [0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5];

const session = (over: Partial<DiagSession> = {}): DiagSession => ({
  unitId: "N-07",
  startedAt: 1_700_000_000_000,
  walkLines: [],
  channels: [
    { joint: "knee_L", ref, wave: ref.map((v) => v * 1.7) },
    { joint: "knee_R", ref, wave: ref.map((v) => v * 1.01) },
  ],
  flag: { k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" },
  report,
  acknowledged: [],
  calibration: null,
  ...over,
});

/** Drive the real store to the verdict phase, the way the wire would. */
function toVerdict() {
  const ev = (e: DiagEventMessage["ev"]): DiagEventMessage => ({
    t: "diag_event",
    unitId: "N-07",
    ev: e,
  });
  act(() => {
    useIncidentStore.getState().beginDescent("N-07");
    useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" }));
    useIncidentStore.getState().applyDiagEvent(ev({ k: "verdict", report }));
  });
}

beforeEach(() => {
  useIncidentStore.getState().reset();
  // The acknowledgement clock is module-level (safe-sit-copy.ts), so it has to
  // be swept alongside the store whose `acknowledged` list it shadows.
  resetAcknowledgedTimes();
});

describe("pairJoint", () => {
  it("finds a joint's opposite number, and only a real one", () => {
    expect(pairJoint("knee_L")).toBe("knee_R");
    expect(pairJoint("ankle_R")).toBe("ankle_L");
    expect(pairJoint("all")).toBeNull();
    expect(pairJoint("wrist_L")).toBeNull();
  });
});

describe("VerdictCard", () => {
  it("names the component and the anomaly, and quotes the report verbatim", () => {
    const heading = screen.queryByRole("heading", { level: 2 });
    expect(heading).toBeNull(); // nothing rendered yet
    render(<VerdictCard session={session()} />);

    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2).toHaveTextContent("KNEE_L · ACTUATOR A-07");
    // Scoped to the header: "gain anomaly" also appears inside the machine's
    // own summary immediately below, and matching both would pass for the
    // wrong reason.
    expect(h2.parentElement).toHaveTextContent(/gain anomaly/i);
    expect(screen.getByText(report.summary)).toBeInTheDocument();
  });

  /**
   * The verdict is the loudest thing in machine space. jsdom lays nothing
   * out, so the claim is made where it is decided: the two lines of the
   * finding sit at the top of the machine type scale and carry the alert
   * token, and nothing else on the card reaches either. The rendered sizes
   * and colours are asserted in a browser by e2e/golden-path.spec.ts.
   */
  it("sets the finding at the top of the scale, in alert, and nothing else that loud", () => {
    const { container } = render(<VerdictCard session={session()} />);
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2.className).toContain("text-display");
    expect(h2.className).toContain("text-alert");

    const anomaly = container.querySelector('[data-slot="verdict-anomaly"]');
    expect(anomaly).toHaveTextContent(/^gain anomaly$/i);
    expect(anomaly?.className).toContain("text-title");
    expect(anomaly?.className).toContain("text-alert");

    // Everything else on the card is quieter: no other element is set at
    // display size, and the section labels around the headline stay labels.
    expect(container.querySelectorAll(".text-display")).toHaveLength(1);
    expect(screen.getByText("Verdict").className).toContain("text-label");
    expect(screen.getByText(report.summary).className).not.toMatch(
      /text-(display|title)/,
    );
  });

  it("frames the anomaly as a hypothesis: the differential rides under the headline", () => {
    render(<VerdictCard session={session()} />);
    // the scan measured a signature, it did not open the knee — the
    // one dim line under GAIN ANOMALY says what produces that signature.
    expect(
      screen.getByText("CONSISTENT WITH GAIN DRIFT · TENDON WEAR · ACTUATOR DEGRADATION"),
    ).toBeInTheDocument();
  });

  it("shows the failing joint against its healthy pair, with both readings", () => {
    const { container } = render(<VerdictCard session={session()} />);
    const subject = container.querySelector('[data-evidence="knee_L"]');
    const control = container.querySelector('[data-evidence="knee_R"]');
    expect(subject).not.toBeNull();
    expect(control).not.toBeNull();

    // The evidence is geometry, not a picture of geometry: the polylines carry
    // a point per sample, so the thumbnail can be asserted rather than eyeballed.
    const live = subject?.querySelector('polyline[data-role="live"]');
    const reference = subject?.querySelector('polyline[data-role="reference"]');
    expect(live?.getAttribute("points")?.split(" ")).toHaveLength(ref.length);
    expect(reference?.getAttribute("points")?.split(" ")).toHaveLength(ref.length);

    expect(subject).toHaveTextContent(/1\.70× ref/i);
    expect(control).toHaveTextContent(/1\.01× ref/i);
  });

  it("renders one button per recommendation the report carries", () => {
    render(<VerdictCard session={session()} />);
    for (const action of report.recommendations) {
      // toBeInTheDocument, not toBeVisible: framer-motion's `initial` leaves
      // the card at opacity 0 in jsdom, where no frame ever advances it.
      expect(
        screen.getByRole("button", { name: new RegExp(action, "i") }),
      ).toBeInTheDocument();
    }
  });

  /**
   * moved the caveat off the card and onto the two actions it is
   * actually true of; the split itself, the confirmation and the execution
   * lifecycle are covered in safe-sit.test.tsx. What this file keeps is the
   * part that is the *card's* job: that pressing one of the two recorded
   * actions still only records it.
   */
  it("says out loud that the recorded actions do not command the robot", () => {
    render(<VerdictCard session={session()} />);
    expect(
      screen.getByText(/records to the incident on return · no command sent/i),
    ).toBeInTheDocument();
    // And no longer says it of all three, now that one of them executes.
    expect(screen.queryByText(/no command is sent to the unit/i)).toBeNull();
  });

  it("records an acknowledgement in the incident rather than sending anything", async () => {
    const user = userEvent.setup();
    toVerdict();
    const live = useIncidentStore.getState().session!;
    const { rerender } = render(<VerdictCard session={live} />);

    // Dispatch service: the recorded class, and ungated (DISABLE JOINT's
    // posture gate has its own coverage below). "Recalibrate joint" is no
    // longer one of these made it a command.
    await user.click(screen.getByRole("button", { name: /^Dispatch service$/i }));
    expect(useIncidentStore.getState().session?.acknowledged).toEqual([
      "Dispatch service",
    ]);

    rerender(<VerdictCard session={useIncidentStore.getState().session!} />);
    const acked = screen.getByRole("button", { name: /Dispatch service · recorded/i });
    expect(acked).toHaveAttribute("aria-pressed", "true");
    expect(acked).toBeDisabled();
  });

  it("ascends on return, archiving the incident with what was acknowledged", async () => {
    const user = userEvent.setup();
    toVerdict();
    act(() => useIncidentStore.getState().acknowledgeRecommendation("Dispatch service"));
    render(<VerdictCard session={useIncidentStore.getState().session!} />);

    await user.click(screen.getByRole("button", { name: /Return to console/i }));

    const state = useIncidentStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.session).toBeNull();
    expect(state.history[0]).toMatchObject({
      unitId: "N-07",
      acknowledged: ["Dispatch service"],
    });
  });

  it("offers no minimize control where there is nowhere to put the card", () => {
    render(<VerdictCard session={session()} />);
    expect(screen.queryByRole("button", { name: /minimize/i })).toBeNull();
  });

  it("hands the card down rather than closing it", async () => {
    const user = userEvent.setup();
    toVerdict();
    let minimized = false;
    render(
      <VerdictCard
        session={useIncidentStore.getState().session!}
        onMinimize={() => {
          minimized = true;
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /minimize verdict/i }));
    expect(minimized).toBe(true);
    // Minimizing is a view decision: the session is untouched and still live.
    expect(useIncidentStore.getState().phase).toBe("verdict");
    expect(useIncidentStore.getState().session?.report).not.toBeNull();
    expect(useIncidentStore.getState().history).toHaveLength(0);
  });

  /**
   * The healthy verdict.
   *
   * The sim has always served this shape — `all / all / none`, one
   * recommendation reading "No action required" — and until the run control
   * moved out of the incident banner there was no way to reach it from the UI.
   * Everything the card draws for a fault has to *not* be drawn here: no clay,
   * no evidence pair (there is no subject joint to pair), and no buttons, since
   * a pressable "No action required" is a decision offered where there is none.
   */
  const cleanSession = () =>
    session({
      flag: null,
      report: {
        ...report,
        joint: "all",
        component: "all",
        anomaly: "none",
        summary: "SCAN COMPLETE. 6 CHANNELS WITHIN TOLERANCE. NO ANOMALY DETECTED.",
        recommendations: ["No action required"],
      },
    });

  it("does not invent an anomaly on a clean scan", () => {
    render(<VerdictCard session={cleanSession()} />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent(/no anomaly detected/i);
    expect(screen.queryByText(/gain anomaly/i)).not.toBeInTheDocument();
    // A healthy verdict hypothesises nothing.
    expect(screen.queryByText(/consistent with/i)).not.toBeInTheDocument();
    // Phosphor, not alert: hierarchy in machine space is luminance, and the
    // one colour reserved for a fault stays reserved.
    expect(heading.className).toContain("text-ink");
    expect(heading.className).not.toContain("text-alert");
  });

  it("shows no evidence pair and no acknowledgements on a clean scan", () => {
    render(<VerdictCard session={cleanSession()} />);

    // `joint: "all"` matches no channel, so there is no SUBJECT trace — and
    // therefore no lone CONTROL pane standing next to nothing.
    expect(screen.queryByText(/subject/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/control/i)).not.toBeInTheDocument();

    // The report's field is printed, as the statement it is. (In the document
    // rather than visible: the card mounts at `boot.verdict`'s hidden opacity
    // and fades in, which jsdom reads as invisible for every child.)
    expect(screen.getByText("No action required")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /no action required/i }),
    ).not.toBeInTheDocument();
    // Nothing is being recorded, so nothing needs disclaiming.
    expect(screen.queryByText(/no command is sent/i)).not.toBeInTheDocument();

    // The way out is still the way out.
    expect(
      screen.getByRole("button", { name: /return to console/i }),
    ).toBeInTheDocument();
  });
});

describe("VerdictStrip", () => {
  it("says where, which part and what kind of wrong, and offers the card back", async () => {
    const user = userEvent.setup();
    let restored = false;
    render(
      <VerdictStrip
        report={report}
        onRestore={() => {
          restored = true;
        }}
      />,
    );

    const chip = screen.getByRole("button", { name: /VERDICT · KNEE_L · A-07 GAIN/i });
    expect(chip).toHaveTextContent(/restore/i);
    // Focus follows the card it replaced: minimizing must not drop a keyboard
    // operator back to the top of the tab order.
    expect(chip).toHaveFocus();

    await user.click(chip);
    expect(restored).toBe(true);
  });

  it("keeps the way out no further away than it was", async () => {
    const user = userEvent.setup();
    toVerdict();
    render(<VerdictStrip report={report} onRestore={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^return to console$/i }));

    const state = useIncidentStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.history[0]).toMatchObject({ unitId: "N-07" });
  });
});
