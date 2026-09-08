import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type CommandEvent,
  type CommandEventMessage,
  type DiagEventMessage,
  type OperatorCommand,
  type UnitSummary,
  type VerdictReport,
} from "@/lib/schema";
import {
  useAuditStore,
  useCommandStore,
  useFleetStore,
  useIncidentStore,
  type DiagSession,
} from "@/lib/stores";
import { type TelemetryTransport } from "@/lib/transport";
import { setCommandTransport } from "@/components/fleet/telemetry-command";
import { EvidenceTrace } from "./evidence-trace";
import {
  calibrationAmendment,
  recalImpact,
  RECAL_GATE_NOTE,
  residualDifferential,
  residualReading,
} from "./recalibrate-copy";
import { resetAcknowledgedTimes } from "./safe-sit-copy";
import { VerdictCard } from "./verdict-card";

/**
 * RECALIBRATE JOINT was the first recommendation the verdict printed
 * and the only one that did nothing: it sat in RECORD, stamped a time, and sent
 * no command, ungated by the very posture the SAFE SIT beside it existed to
 * produce. This file is the receipt for the three things that changed.
 *
 * 1. The sit is its PRECONDITION. Inert with a reason while the robot stands,
 * live the instant the settle beat lands — so the card reads as a procedure.
 * 2. It EXECUTES, with everything commanding a robot owes an operator. The
 * generic half of that (confirmation, focus, refusal, dismiss) is
 * safe-sit.test.tsx's; what is here is the half that is about calibration.
 * 3. The result lands on the EVIDENCE. The exhibit that made the diagnosis is
 * re-drawn against its own earlier self, the verdict amends, and the
 * differential narrows to what a gain table cannot fix — which is the whole
 * reason DISPATCH SERVICE stops being a button and becomes a conclusion.
 */

const sent: OperatorCommand[] = [];

const transport: TelemetryTransport = {
  connect: () => {},
  send: (cmd) => sent.push(cmd),
  disconnect: () => {},
};

const report: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LEFT KNEE ACTUATOR A-07: GAIN ANOMALY.",
  recommendations: [
    "Recalibrate joint",
    "Command safe sit",
    "Disable joint",
    "Dispatch service",
  ],
  ts: 120_000,
};

const summary = (posture: "walking" | "sitting"): UnitSummary => ({
  id: "N-07",
  name: "Sagebrush House",
  status: "red",
  battery: 80,
  pos: { lat: 44.0597, lng: -121.2793 },
  posture,
});

const seedPosture = (posture: "walking" | "sitting") =>
  act(() =>
    useFleetStore
      .getState()
      .applySnapshot({ t: "fleet_snapshot", units: [summary(posture)] }),
  );

const ref = [0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5];
/** The scan's exhibit and the sim's own residual band, in miniature. */
const faulty = ref.map((v) => v * 1.75);
const corrected = ref.map((v) => v * 1.32);

const session = (over: Partial<DiagSession> = {}): DiagSession => ({
  unitId: "N-07",
  startedAt: 1_700_000_000_000,
  walkLines: [],
  channels: [
    { joint: "knee_L", ref, wave: faulty },
    { joint: "knee_R", ref, wave: ref.map((v) => v * 1.02) },
  ],
  flag: { k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" },
  report,
  acknowledged: [],
  calibration: null,
  ...over,
});

const calibration = (
  over: Partial<Extract<DiagEventMessage["ev"], { k: "recalibration" }>> = {},
) =>
  ({
    k: "recalibration",
    joint: "knee_L",
    wave: corrected,
    ref,
    outcome: "partial",
    ...over,
  }) as const;

let seq = 0;
function say(ev: CommandEvent) {
  const msg: CommandEventMessage = {
    t: "command_event",
    unitId: "N-07",
    cmd: "RECALIBRATE_JOINT",
    seq: ++seq,
    ts: 1_700_000_000_000 + seq * 500,
    ev,
  };
  act(() => useCommandStore.getState().applyCommandEvent(msg));
}

/** Drive the incident store to a standing verdict, the way the wire does. */
function toVerdict() {
  act(() => {
    const s = useIncidentStore.getState();
    s.beginDescent("N-07");
    s.applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    s.applyDiagEvent({
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "channel", joint: "knee_L", wave: faulty, ref },
    });
    s.applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "verdict", report } });
  });
}

const sayRecalibrated = (ev = calibration()) =>
  act(() =>
    useIncidentStore.getState().applyDiagEvent({ t: "diag_event", unitId: "N-07", ev }),
  );

beforeEach(() => {
  sent.length = 0;
  seq = 0;
  setCommandTransport(transport);
  useCommandStore.getState().reset();
  useIncidentStore.getState().reset();
  useAuditStore.getState().reset();
  useFleetStore.getState().reset();
  resetAcknowledgedTimes();
});

afterEach(() => setCommandTransport(null));

// ---------------------------------------------------------------------------

describe("the sit is the precondition, not the neighbour", () => {
  it("renders inert with the reason while the robot is standing on the joint", () => {
    seedPosture("walking");
    render(<VerdictCard session={session()} />);

    const gated = screen.getByRole("button", {
      name: /^recalibrate joint · requires seated posture$/i,
    });
    expect(gated).toBeDisabled();
    // Disabled, not hidden: the report recommended it, and a card that hides a
    // recommendation is editing the report.
    const note = screen.getByText(RECAL_GATE_NOTE);
    expect(gated).toHaveAttribute("aria-describedby", note.id);
  });

  it("fails safe when the fleet store has never heard of the unit", () => {
    render(<VerdictCard session={session()} />);
    expect(
      screen.getByRole("button", {
        name: /recalibrate joint · requires seated posture/i,
      }),
    ).toBeDisabled();
  });

  it("enables in place when the settle beat flips posture — no remount", () => {
    seedPosture("walking");
    render(<VerdictCard session={session()} />);
    const before = screen.getByRole("button", {
      name: /recalibrate joint · requires seated posture/i,
    });

    act(() =>
      useFleetStore
        .getState()
        .applyUnitUpdate({ t: "unit_update", unit: summary("sitting") }),
    );

    const after = screen.getByRole("button", { name: /^recalibrate joint$/i });
    expect(after).toBeEnabled();
    expect(after).toBe(before);
    expect(screen.queryByText(RECAL_GATE_NOTE)).toBeNull();
  });

  it("sends nothing while gated, however hard it is pressed", async () => {
    const user = userEvent.setup();
    seedPosture("walking");
    render(<VerdictCard session={session()} />);
    await user.click(
      screen.getByRole("button", {
        name: /recalibrate joint · requires seated posture/i,
      }),
    );
    expect(sent).toEqual([]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("what it costs the operator to say yes", () => {
  it("states the consequences before anything leaves, wear included", async () => {
    const user = userEvent.setup();
    seedPosture("sitting");
    render(<VerdictCard session={session()} />);

    await user.click(screen.getByRole("button", { name: /^recalibrate joint$/i }));

    const dialog = screen.getByRole("alertdialog");
    // toBeInTheDocument, not toBeVisible: the gate opens inside the verdict
    // card's fade, whose `initial` is opacity 0, and toBeVisible reads that
    // through every ancestor. Whether a frame has advanced it by now depends on
    // how loaded the machine is, which is not what this test is about. That the
    // operator can see these lines is asserted in a real browser, by the axe and
    // keyboard passes in e2e/accessibility.spec.ts.
    expect(
      within(dialog).getByText(/confirm recalibration · unit n-07/i),
    ).toBeInTheDocument();
    for (const line of recalImpact("gain")) {
      expect(within(dialog).getByText(line.text)).toBeInTheDocument();
    }
    // The line an operator would otherwise drop, and the only colour spent.
    expect(
      within(dialog).getByText(/calibration corrects gain, not wear/i),
    ).toBeInTheDocument();
    // Nothing has left the building yet.
    expect(sent).toEqual([]);
  });

  it("sends the command and records the operator's decision on confirm", async () => {
    const user = userEvent.setup();
    seedPosture("sitting");
    toVerdict();
    render(<VerdictCard session={useIncidentStore.getState().session!} />);

    await user.click(screen.getByRole("button", { name: /^recalibrate joint$/i }));
    await user.click(screen.getByRole("button", { name: /^confirm$/i }));

    expect(sent).toEqual([{ c: "RECALIBRATE_JOINT", unitId: "N-07" }]);
    expect(useIncidentStore.getState().session?.acknowledged).toEqual([
      "Recalibrate joint",
    ]);
  });

  it("sends nothing on abort", async () => {
    const user = userEvent.setup();
    seedPosture("sitting");
    render(<VerdictCard session={session()} />);
    await user.click(screen.getByRole("button", { name: /^recalibrate joint$/i }));
    await user.click(screen.getByRole("button", { name: /^abort$/i }));

    expect(sent).toEqual([]);
    expect(screen.getByRole("button", { name: /^recalibrate joint$/i })).toBeEnabled();
  });

  it("narrates the sweep in the machine's own words, and refuses in them too", () => {
    seedPosture("sitting");
    render(<VerdictCard session={session()} />);

    say({ k: "accepted" });
    expect(screen.getByText("RECALIBRATION · ACCEPTED")).toBeInTheDocument();

    say({ k: "progress", pct: 40, note: "RANGE SWEEP 1/2" });
    expect(screen.getByText(/RANGE SWEEP 1\/2/)).toBeInTheDocument();

    say({ k: "complete" });
    expect(screen.getByText("RECALIBRATION COMPLETE")).toBeInTheDocument();
  });

  it("prints a refusal verbatim rather than translating it", () => {
    seedPosture("sitting");
    render(<VerdictCard session={session()} />);
    say({ k: "failed", reason: "CALIBRATION CURRENT" });
    expect(screen.getByText("REFUSED · CALIBRATION CURRENT")).toBeInTheDocument();
  });

  /**
   * The two maneuvers run on one robot. A control that rendered whatever the
   * unit's slot held would put a SAFE SIT's narration under the RECALIBRATE
   * button — the console misattributing a robot's own words to a command
   * nobody sent. Since the store keys by `(unit, command)`, so this is
   * structural rather than filtered; the assertion stays, because that is the
   * property, not the mechanism.
   */
  it("does not narrate the other command's lifecycle", () => {
    seedPosture("sitting");
    render(<VerdictCard session={session()} />);
    act(() =>
      useCommandStore.getState().applyCommandEvent({
        t: "command_event",
        unitId: "N-07",
        cmd: "COMMAND_SAFE_SIT",
        seq: 99,
        ts: 1,
        ev: { k: "complete" },
      }),
    );
    // The sit's own control shows it; this one is still an offer.
    expect(screen.getByRole("button", { name: /^recalibrate joint$/i })).toBeEnabled();
  });
});

describe("the result lands on the evidence", () => {
  it("redraws the exhibit against its own earlier self", () => {
    seedPosture("sitting");
    const { container } = render(
      <VerdictCard session={session({ calibration: calibration() })} />,
    );

    const exhibit = container.querySelector('[data-evidence="knee_L"]')!;
    // Two live traces in one frame: the ghost of what it was, and what it is.
    expect(exhibit.querySelector('[data-role="pre"]')).not.toBeNull();
    expect(exhibit.querySelector('[data-role="live"]')).not.toBeNull();
    // The key that names them: two words in the two lines' own tones.
    expect(within(exhibit as HTMLElement).getByText(/^before$/i)).toBeInTheDocument();
    expect(within(exhibit as HTMLElement).getByText(/^after$/i)).toBeInTheDocument();
    // Both readings move together or neither does.
    // Current reading in the primary row, what it came down from under it.
    expect(within(exhibit as HTMLElement).getByText(/1\.32× ref/i)).toBeInTheDocument();
    expect(within(exhibit as HTMLElement).getByText(/was 1\.75×/i)).toBeInTheDocument();
    expect(
      within(exhibit as HTMLElement).getByText(/^rms Δ 0\.196$/i),
    ).toBeInTheDocument();
    expect(within(exhibit as HTMLElement).getByText(/^was 0\.459$/i)).toBeInTheDocument();
  });

  it("leaves the healthy control alone", () => {
    seedPosture("sitting");
    const { container } = render(
      <VerdictCard session={session({ calibration: calibration() })} />,
    );
    const control = container.querySelector('[data-evidence="knee_R"]')!;
    expect(control.querySelector('[data-role="pre"]')).toBeNull();
  });

  it("amends the verdict and narrows the differential", () => {
    seedPosture("sitting");
    render(<VerdictCard session={session({ calibration: calibration() })} />);

    // The headline still says what the scan found: a diagnosis is not rewritten
    // by a treatment.
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/knee_l/i);
    expect(screen.getAllByText(/gain anomaly/i).length).toBeGreaterThan(0);
    // The outcome word rides on the anomaly line now; the amendment under it is
    // the measurement and what it leaves behind, stated once each.
    expect(
      screen.getByText(/^RESIDUAL 1\.32× REFERENCE · MECHANICAL WEAR INDICATED$/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /GAIN DRIFT EXCLUDED · REMAINING TENDON WEAR · ACTUATOR DEGRADATION/,
      ),
    ).toBeInTheDocument();
  });

  it("says nothing about a calibration until one has happened", () => {
    seedPosture("sitting");
    render(<VerdictCard session={session()} />);
    expect(screen.queryByText(/residual/i)).toBeNull();
    expect(screen.queryByText(/gain drift excluded/i)).toBeNull();
    // The scan's own differential is still the one on screen.
    expect(screen.getByText(/CONSISTENT WITH GAIN DRIFT/)).toBeInTheDocument();
  });

  it("ignores a re-measure of a joint this exhibit is not about", () => {
    seedPosture("sitting");
    const { container } = render(
      <VerdictCard session={session({ calibration: calibration({ joint: "hip_R" }) })} />,
    );
    expect(
      container.querySelector('[data-evidence="knee_L"] [data-role="pre"]'),
    ).toBeNull();
  });
});

/**
 * The other ending, and the reason the two must not look alike.
 *
 * The knee's partial correction is a warning with a van attached; the ankle's
 * cleared one is a fault that stopped existing. Both used to render as the same
 * card with one line different — full alert headline, present-tense summary,
 * red-framed exhibit, DISPATCH SERVICE still on offer — which meant the console
 * put a robot that had just been fixed on a screen that still read as an
 * emergency. Everything below is the register changing together.
 */
describe("a cleared re-measure changes the register of the whole card", () => {
  const offsetReport: VerdictReport = {
    unitId: "N-07",
    joint: "ankle_R",
    component: "actuator_A12",
    anomaly: "offset",
    summary: "RIGHT ANKLE ACTUATOR A-12: OFFSET ANOMALY. LIVE TRACE DISPLACED 0.21.",
    recommendations: ["Recalibrate joint", "Command safe sit", "Dispatch service"],
    ts: 120_000,
  };
  /** Displaced from datum, then re-zeroed onto it. */
  const displaced = ref.map((v) => v + 0.21);

  const cleared = (over: Partial<DiagSession> = {}): DiagSession =>
    session({
      channels: [
        { joint: "ankle_R", ref, wave: displaced },
        { joint: "ankle_L", ref, wave: ref.map((v) => v * 1.01) },
      ],
      flag: { k: "flag", joint: "ankle_R", component: "actuator_A12", anomaly: "offset" },
      report: offsetReport,
      calibration: calibration({ joint: "ankle_R", wave: ref, outcome: "cleared" }),
      ...over,
    });

  it("takes the alert off the headline and puts the outcome on the finding", () => {
    seedPosture("sitting");
    const { container } = render(<VerdictCard session={cleared()} />);

    const h2 = screen.getByRole("heading", { level: 2 });
    // The part is still named: a diagnosis is not rewritten by a treatment.
    expect(h2).toHaveTextContent("ANKLE_R · ACTUATOR A-12");
    // …but the loudest object in machine space is no longer red.
    expect(h2.className).toContain("text-nominal");
    expect(h2.className).not.toContain("text-alert");

    const anomaly = container.querySelector('[data-slot="verdict-anomaly"]');
    expect(anomaly).toHaveTextContent(/^offset anomaly · cleared$/i);
    expect(anomaly?.className).toContain("text-nominal");
    expect(anomaly?.className).not.toContain("text-alert");
    // The card says so by name, for the stylesheet and for a reader.
    expect(container.querySelector('[data-slot="verdict-card"]')).toHaveAttribute(
      "data-outcome",
      "cleared",
    );
  });

  it("dates the scan's own sentence and prints the one that is true now", () => {
    seedPosture("sitting");
    render(<VerdictCard session={cleared()} />);

    // The report's present-tense summary survives, marked as history.
    expect(screen.getByText(/At scan/i)).toBeInTheDocument();
    expect(screen.getByText(/LIVE TRACE DISPLACED 0\.21/)).toBeInTheDocument();
    // And what replaced it as the card's standing claim.
    expect(
      screen.getByText(/^RE-MEASURED AFTER CALIBRATION: CHANNEL WITHIN REFERENCE/),
    ).toBeInTheDocument();
    expect(screen.getByText(/CHANNEL RESTORED · RESIDUAL/)).toBeInTheDocument();
  });

  it("retones the exhibit to the measurement inside it", () => {
    seedPosture("sitting");
    const { container } = render(<VerdictCard session={cleared()} />);
    const exhibit = container.querySelector('[data-evidence="ankle_R"]')!;

    // The frame is the figure's own claim about its channel, and the channel is
    // back inside the envelope.
    expect(exhibit.getAttribute("data-tone")).toBe("nominal");
    expect(exhibit.className).not.toContain("border-alert");
    // Both traces are still there, and both are named.
    expect(exhibit.querySelector('[data-role="pre"]')).not.toBeNull();
    expect(exhibit.querySelector('[data-role="live"]')).not.toBeNull();
    expect(within(exhibit as HTMLElement).getByText(/^before$/i)).toBeInTheDocument();
    expect(within(exhibit as HTMLElement).getByText(/^after$/i)).toBeInTheDocument();
  });

  it("keeps the exhibit in alert while the correction is only partial", () => {
    seedPosture("sitting");
    const { container } = render(
      <VerdictCard session={session({ calibration: calibration() })} />,
    );
    const exhibit = container.querySelector('[data-evidence="knee_L"]')!;
    // The frame follows the number, not the fact that a maneuver ran: a channel
    // still outside its envelope keeps a frame that says so. Which of the two
    // loud tiers it lands in is the measurement's business (the scripted
    // partial lands in warn); what it must never reach here is nominal.
    expect(exhibit.getAttribute("data-tone")).not.toBe("nominal");
  });

  it("stops offering the escalation the clear made unnecessary", () => {
    seedPosture("sitting");
    render(<VerdictCard session={cleared()} />);

    const dispatch = screen.getByRole("button", {
      name: /^Dispatch service · NOT INDICATED$/i,
    });
    expect(dispatch).toBeDisabled();
    expect(
      screen.getByText(/^Channel restored · escalation no longer indicated$/i),
    ).toBeInTheDocument();
  });

  it("leaves DISPATCH SERVICE live and pressable after a partial", () => {
    seedPosture("sitting");
    render(<VerdictCard session={session({ calibration: calibration() })} />);
    expect(screen.getByRole("button", { name: /^Dispatch service$/i })).toBeEnabled();
    expect(screen.queryByText(/escalation no longer indicated/i)).not.toBeInTheDocument();
  });

  it("keeps a record that was already taken, gate or no gate", () => {
    seedPosture("sitting");
    render(<VerdictCard session={cleared({ acknowledged: ["Dispatch service"] })} />);
    // The audit outranks the gate: a press that happened cannot un-happen.
    expect(
      screen.getByRole("button", { name: /^Dispatch service · recorded/i }),
    ).toBeDisabled();
    expect(screen.queryByText(/NOT INDICATED/i)).not.toBeInTheDocument();
  });
});

describe("the incident store admits the re-measure, once, against a verdict", () => {
  it("takes it in the verdict phase and archives it on ascent", () => {
    toVerdict();
    sayRecalibrated();
    expect(useIncidentStore.getState().session?.calibration).toMatchObject({
      joint: "knee_L",
      outcome: "partial",
    });

    act(() => useIncidentStore.getState().completeAscent());
    expect(useIncidentStore.getState().history[0]?.calibration).toMatchObject({
      outcome: "partial",
    });
  });

  it("logs it once, however often the beat is replayed", () => {
    toVerdict();
    sayRecalibrated();
    sayRecalibrated(calibration({ outcome: "cleared" }));

    // First write wins: a replayed complete restates nothing, and cannot
    // upgrade a partial result into a clean one.
    expect(useIncidentStore.getState().session?.calibration?.outcome).toBe("partial");
    const log = useAuditStore
      .getState()
      .entries.filter((e) => e.kind === "diag-recalibrated");
    expect(log).toHaveLength(1);
    expect(log[0]?.summary).toMatch(/partial correction/i);
  });

  it("drops a re-measure with no standing verdict beside it", () => {
    // Mid-scan: there is no conclusion for a residual to be compared against.
    act(() => {
      const s = useIncidentStore.getState();
      s.beginDescent("N-07");
      s.applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    });
    sayRecalibrated();
    expect(useIncidentStore.getState().session?.calibration).toBeNull();
  });

  it("drops a re-measure addressed to some other unit's session", () => {
    toVerdict();
    act(() =>
      useIncidentStore
        .getState()
        .applyDiagEvent({ t: "diag_event", unitId: "N-02", ev: calibration() }),
    );
    expect(useIncidentStore.getState().session?.calibration).toBeNull();
  });

  it("leaves an incident where nobody tried the cheap rung representable as one", () => {
    toVerdict();
    act(() => useIncidentStore.getState().completeAscent());
    expect(useIncidentStore.getState().history[0]?.calibration).toBeUndefined();
  });
});

describe("recalibrate-copy", () => {
  it("states the residual in the machine's register", () => {
    const ratio = residualReading("gain", [1.3241], [1]);
    expect(calibrationAmendment("partial", ratio)).toBe(
      "RESIDUAL 1.32× REFERENCE · MECHANICAL WEAR INDICATED",
    );
    expect(calibrationAmendment("cleared", ratio)).toBe(
      "CHANNEL RESTORED · RESIDUAL 1.32× REFERENCE",
    );
  });

  it("measures a residual in the units its own fault is stated in", () => {
    // A gain fault is an amplitude ratio; that is the reading its headline was
    // written in, and the one the knee's amendment prints.
    expect(residualReading("gain", [0.7], [0.5])).toMatchObject({
      value: 1.4,
      machine: "1.40× REFERENCE",
      operator: "1.40× reference",
    });
    // An offset fault is a displacement. Measured as a ratio the SAME channel
    // reads 1.40× too — a true number that says nothing about a datum, which is
    // the whole reason this function exists rather than one call to gainRatio.
    const displaced = residualReading("offset", [0.7], [0.5]);
    expect(displaced.value).toBeCloseTo(0.2, 6);
    expect(displaced).toMatchObject({
      machine: "0.200 FROM DATUM",
      operator: "0.200 from datum",
    });
    // An anomaly with no entry falls back to the general reading rather than to
    // whichever branch happens to be written first.
    expect(residualReading("thermal", [0.7], [0.5]).machine).toBe("1.40× REFERENCE");
  });

  it("states the limit of a calibration against the fault it is aimed at", () => {
    const shared = "Joint driven through range · unloaded";
    expect(recalImpact("gain").map((l) => l.text)).toEqual([
      shared,
      "Unit holds seated posture throughout",
      "Calibration corrects gain, not wear",
    ]);
    // The line that would otherwise be a sentence about gain in front of an
    // operator whose robot has no gain fault.
    expect(recalImpact("offset").at(-1)).toEqual({
      text: "Calibration corrects the datum, not the mounting",
      tone: "warn",
    });
    expect(recalImpact("thermal").at(-1)?.text).toBe(
      "Calibration rewrites a table, not a mechanism",
    );
    // Whatever the fault, the operator is told the robot is about to move.
    for (const anomaly of ["gain", "offset", "thermal"]) {
      expect(recalImpact(anomaly)[0]?.text).toBe(shared);
    }
  });

  it("lists what is left from a table rather than inferring it from array order", () => {
    expect(residualDifferential("gain", "partial")).toBe(
      "GAIN DRIFT EXCLUDED · REMAINING TENDON WEAR · ACTUATOR DEGRADATION",
    );
    // Nothing to say is said as nothing: a cleared channel has no remainder,
    // and an anomaly with no entry gets no improvised pathology.
    expect(residualDifferential("gain", "cleared")).toBeNull();
    expect(residualDifferential("thermal", "partial")).toBeNull();
  });
});

describe("EvidenceTrace without a re-measure", () => {
  it("keeps the single trace under the name a test asks for it by", () => {
    const { container } = render(
      <EvidenceTrace joint="knee_L" wave={faulty} ref={ref} subject />,
    );
    expect(container.querySelector('[data-role="live"]')).not.toBeNull();
    expect(container.querySelector('[data-role="pre"]')).toBeNull();
    expect(screen.getByText(/1\.75× ref/)).toBeInTheDocument();
  });
});
