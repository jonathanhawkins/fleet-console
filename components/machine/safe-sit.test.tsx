import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type CommandEvent,
  type CommandEventMessage,
  type ExecutedCommand,
  type OperatorCommand,
  type UnitSummary,
  type VerdictReport,
} from "@/lib/schema";
import {
  commandKey,
  useAuditStore,
  useCommandStore,
  useFleetStore,
  useIncidentStore,
  type DiagSession,
} from "@/lib/stores";
import { type TelemetryTransport } from "@/lib/transport";
import { setCommandTransport } from "@/components/fleet/telemetry-command";
import { CommandStatusLine } from "./execute-action";
import { SafeSitAction } from "./safe-sit";
import {
  acknowledgedLabel,
  acknowledgedTime,
  commandFill,
  commandLine,
  executedKind,
  isExecutedRecommendation,
  isPostureGatedRecommendation,
  markAcknowledged,
  POSTURE_GATE_NOTE,
  postureGateLabel,
  resetAcknowledgedTimes,
  splitRecommendations,
} from "@/lib/diagnostics/safe-sit-copy";
import { VerdictCard } from "./verdict-card";

/**
 * The charge against the first version was that this console had
 * command-sounding buttons that sent no commands, and that a button which *did*
 * send one would owe the operator permissions, expected impact, execution
 * progress, failure handling and an audit record. This file is the receipt for
 * each of those, plus the one thing the criticism did not ask for and the
 * console needs most: that nothing on screen can claim a maneuver the machine
 * has not confirmed.
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

/** N-07 as the fleet store knows it — the posture the gate reads live. */
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

/** The unit's own sit lane in the command store — keyed by (unit, command). */
const SIT_KEY = commandKey("N-07", "COMMAND_SAFE_SIT");

const ref = [0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5];

const session = (over: Partial<DiagSession> = {}): DiagSession => ({
  unitId: "N-07",
  startedAt: 1_700_000_000_000,
  walkLines: [],
  channels: [{ joint: "knee_L", ref, wave: ref.map((v) => v * 1.7) }],
  flag: { k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" },
  report,
  acknowledged: [],
  calibration: null,
  ...over,
});

/** The wire answering, at whatever beat the test needs. */
let seq = 0;
function say(
  ev: CommandEvent,
  unitId = "N-07",
  cmd: ExecutedCommand = "COMMAND_SAFE_SIT",
) {
  const msg: CommandEventMessage = {
    t: "command_event",
    unitId,
    cmd,
    seq: ++seq,
    ts: 1_700_000_000_000 + seq * 500,
    ev,
  };
  act(() => useCommandStore.getState().applyCommandEvent(msg));
}

beforeEach(() => {
  sent.length = 0;
  seq = 0;
  setCommandTransport(transport);
  useCommandStore.getState().reset();
  useIncidentStore.getState().reset();
  useAuditStore.getState().reset();
  useFleetStore.getState().reset();
  // Module-level, like the telemetry rings: sweep it with the stores it
  // shadows, or one test's press time leaks into the next one's assertions.
  resetAcknowledgedTimes();
});

afterEach(() => setCommandTransport(null));

// ---------------------------------------------------------------------------

describe("safe-sit-copy", () => {
  it("splits the report's recommendations by what pressing them does", () => {
    // RECALIBRATE leads the report; SAFE SIT leads EXECUTE, because it is the
    // control that seats the unit a recalibration requires. Listing the gated
    // rung above the one that ungates it would be the console recommending
    // something it has itself disabled. RECORD keeps the wire's order.
    expect(splitRecommendations(report.recommendations)).toEqual({
      execute: ["Command safe sit", "Recalibrate joint"],
      record: ["Disable joint", "Dispatch service"],
    });
  });

  it("keeps the report's order among executed actions it has no ladder for", () => {
    // Only the two rungs are ranked; anything else the wire executes stays put.
    expect(
      splitRecommendations(["Recalibrate joint", "Command safe sit"]).execute,
    ).toEqual(["Command safe sit", "Recalibrate joint"]);
    expect(splitRecommendations(["Command safe sit"]).execute).toEqual([
      "Command safe sit",
    ]);
  });

  it("matches the executable recommendations by identity, not by position", () => {
    // The report writes sentence case and the board prints caps; the two must
    // not be able to drift into being different actions.
    expect(isExecutedRecommendation("COMMAND  SAFE SIT ")).toBe(true);
    expect(isExecutedRecommendation("  recalibrate   joint")).toBe(true);
    expect(isExecutedRecommendation("Disable joint")).toBe(false);
    // A recommendation the sim does not execute never lands in EXECUTE, however
    // command-sounding it reads.
    expect(splitRecommendations(["Command shutdown"]).execute).toEqual([]);
  });

  /**
   * The bug this function exists to make unrepresentable: the card sorts by a
   * normalized comparison and renders by a second one, so a report writing the
   * action in another case would be filed as EXECUTE and then handed to the
   * WRONG command's control. One function, one answer.
   */
  it("names which maneuver an executed recommendation is, case-insensitively", () => {
    expect(executedKind("Command safe sit")).toBe("sit");
    expect(executedKind("recalibrate  JOINT ")).toBe("recalibrate");
    expect(executedKind("Dispatch service")).toBeNull();
  });

  it("matches the posture-gated recommendation by identity too", () => {
    expect(isPostureGatedRecommendation("DISABLE  JOINT ")).toBe(true);
    // Recalibrate carries the same physical precondition but is an EXECUTED
    // action, so its gate travels with its control rather than through this
    // predicate — which is about the RECORD group's inert styling.
    expect(isPostureGatedRecommendation("Recalibrate joint")).toBe(false);
    expect(isPostureGatedRecommendation("Dispatch service")).toBe(false);
    // The gate rides on the button as a suffix, the acknowledgedLabel idiom.
    expect(postureGateLabel("Disable joint")).toBe(
      "Disable joint · REQUIRES SEATED POSTURE",
    );
  });

  it("prints each phase in the machine's own words", () => {
    const base = {
      unitId: "N-07",
      cmd: "COMMAND_SAFE_SIT",
      pct: 0,
      note: null,
      reason: null,
    } as const;
    expect(commandLine({ ...base, phase: "pending", seq: 1, updatedAt: 0 })).toBe(
      "SAFE SIT · ACCEPTED",
    );
    expect(
      commandLine({
        ...base,
        phase: "progress",
        pct: 45,
        note: "CROUCH PHASE",
        seq: 2,
        updatedAt: 0,
      }),
    ).toBe("SAFE SIT · 45% · CROUCH PHASE");
    expect(
      commandLine({ ...base, phase: "complete", pct: 100, seq: 3, updatedAt: 0 }),
    ).toBe("SAFE SIT COMPLETE");
  });

  it("reads every failure as a refusal, because the wire has no other kind", () => {
    // messages.ts: exactly one accepted-or-failed answers the command, and an
    // accepted one ends in complete. `failed` is always "declined to start".
    const base = {
      unitId: "N-07",
      cmd: "COMMAND_SAFE_SIT",
      seq: 1,
      updatedAt: 0,
      pct: 0,
    } as const;
    for (const reason of ["ALREADY SITTING", "SIT IN PROGRESS", "SCAN IN PROGRESS"]) {
      expect(commandLine({ ...base, phase: "failed", note: null, reason })).toBe(
        `REFUSED · ${reason}`,
      );
    }
  });

  it("draws no bar under a refusal — there was no maneuver to be part-way through", () => {
    const base = {
      unitId: "N-07",
      cmd: "COMMAND_SAFE_SIT",
      seq: 1,
      updatedAt: 0,
    } as const;
    expect(
      commandFill({
        ...base,
        phase: "failed",
        pct: 0,
        note: null,
        reason: "ALREADY SITTING",
      }),
    ).toBe(0);
    // The store carries the previous command's pct onto a refusal. That number
    // describes a different maneuver and must never reach the bar.
    expect(
      commandFill({
        ...base,
        phase: "failed",
        pct: 70,
        note: "TORQUE RAMP-DOWN",
        reason: "X",
      }),
    ).toBe(0);
    expect(
      commandFill({ ...base, phase: "complete", pct: 100, note: null, reason: null }),
    ).toBe(100);
  });
});

// ---------------------------------------------------------------------------

describe("verdict card action groups", () => {
  it("separates the two actions that execute from the two that only file", () => {
    seedPosture("sitting"); // so RECALIBRATE is offered rather than gated
    render(<VerdictCard session={session()} />);

    const execute = screen.getByRole("group", { name: /execute/i });
    const record = screen.getByRole("group", { name: /record to incident/i });

    expect(
      within(execute).getByRole("button", { name: /command safe sit/i }),
    ).toBeInTheDocument();
    // moved this one across: it drives a robot now.
    expect(
      within(execute).getByRole("button", { name: /recalibrate joint/i }),
    ).toBeInTheDocument();
    expect(
      within(record).getByRole("button", { name: /disable joint/i }),
    ).toBeInTheDocument();
    expect(
      within(record).getByRole("button", { name: /dispatch service/i }),
    ).toBeInTheDocument();
    // Neither of the two that command a robot is filed under "record".
    expect(
      within(record).queryByRole("button", { name: /command safe sit/i }),
    ).toBeNull();
    expect(
      within(record).queryByRole("button", { name: /recalibrate joint/i }),
    ).toBeNull();
  });

  it("retires the blanket caveat and attaches the true one per action", () => {
    seedPosture("sitting");
    render(<VerdictCard session={session()} />);

    // The line that was two-thirds right once the sim learned to execute.
    expect(screen.queryByText(/no command is sent to the unit/i)).toBeNull();

    const note = screen.getByText(/records to the incident on return · no command sent/i);
    for (const name of [/^disable joint$/i, /^dispatch service$/i]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-describedby", note.id);
    }
    // And it is emphatically not attached to either one that sends a command.
    // (Seated, SAFE SIT carries its own spent-gate suffix — see below.)
    for (const name of [
      /^command safe sit · already sitting$/i,
      /^recalibrate joint$/i,
    ]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute(
        "aria-describedby",
        note.id,
      );
    }
  });

  /**
   * The mirror of RECALIBRATE's gate. The two EXECUTE controls are a
   * sequence, not a pair of alternatives, and the group has to say so at both
   * ends of it — otherwise a robot that has just sat down is offered a sit the
   * sim would refuse, which is what the shared one-slot command store made
   * newly visible.
   */
  describe("SAFE SIT is spent once the unit is seated", () => {
    it("is live while the robot is standing", () => {
      seedPosture("walking");
      render(<VerdictCard session={session()} />);
      expect(screen.getByRole("button", { name: /^command safe sit$/i })).toBeEnabled();
    });

    it("goes inert in the sim's own words once it has been performed", async () => {
      const user = userEvent.setup();
      seedPosture("sitting");
      render(<VerdictCard session={session()} />);

      const spent = screen.getByRole("button", {
        name: /^command safe sit · already sitting$/i,
      });
      expect(spent).toBeDisabled();
      // toBeInTheDocument, not toBeVisible: framer-motion's `initial` leaves
      // the card at opacity 0 in jsdom, where no frame ever advances it.
      expect(screen.getByText(/already in a seated hold/i)).toBeInTheDocument();
      await user.click(spent);
      expect(sent).toEqual([]);
    });

    it("hands the live half of the sequence to the other control", () => {
      seedPosture("sitting");
      render(<VerdictCard session={session()} />);
      // Exactly one of the two is pressable at any posture: that is the
      // procedure, drawn.
      expect(
        screen.getByRole("button", { name: /^command safe sit · already sitting$/i }),
      ).toBeDisabled();
      expect(screen.getByRole("button", { name: /^recalibrate joint$/i })).toBeEnabled();
    });
  });

  /**
   * The posture gate. Disabling a load-bearing knee while the robot
   * stands on it drops the robot, so DISABLE JOINT is inert — disabled with
   * the reason on its label, never hidden — until the unit's posture is
   * "sitting", and it enables in place the moment the settle beat's
   * unit_update flips it.
   */
  describe("DISABLE JOINT posture gate", () => {
    it("renders inert with the reason while the unit is standing", () => {
      seedPosture("walking");
      render(<VerdictCard session={session()} />);

      const gated = screen.getByRole("button", {
        name: /^disable joint · requires seated posture$/i,
      });
      expect(gated).toBeDisabled();
      // Gated, not recorded: nothing has been filed.
      expect(gated).toHaveAttribute("aria-pressed", "false");
      // The why rides along for AT, in place of the record caveat.
      const gateNote = screen.getByText(POSTURE_GATE_NOTE);
      expect(gated).toHaveAttribute("aria-describedby", gateNote.id);
      // The gate is the disable button's, not the group's: its neighbour
      // still files, and still says so.
      expect(screen.getByRole("button", { name: /^dispatch service$/i })).toBeEnabled();
    });

    it("fails safe when the fleet store has never heard of the unit", () => {
      // No snapshot at all: posture unknown reads as "not seated".
      render(<VerdictCard session={session()} />);
      expect(
        screen.getByRole("button", { name: /disable joint · requires seated posture/i }),
      ).toBeDisabled();
    });

    it("offers the action normally once the unit is seated", () => {
      seedPosture("sitting");
      render(<VerdictCard session={session()} />);

      const button = screen.getByRole("button", { name: /^disable joint$/i });
      expect(button).toBeEnabled();
      expect(screen.queryByText(POSTURE_GATE_NOTE)).toBeNull();
    });

    it("enables in place when the settle beat flips posture — no remount", () => {
      seedPosture("walking");
      render(<VerdictCard session={session()} />);

      const before = screen.getByRole("button", {
        name: /disable joint · requires seated posture/i,
      });
      expect(before).toBeDisabled();

      // SAFE SIT settles: the sim restates the unit with posture "sitting".
      act(() =>
        useFleetStore
          .getState()
          .applyUnitUpdate({ t: "unit_update", unit: summary("sitting") }),
      );

      const after = screen.getByRole("button", { name: /^disable joint$/i });
      expect(after).toBeEnabled();
      // The same element, live: the gate lifted without tearing the card down.
      expect(after).toBe(before);
      expect(screen.queryByText(POSTURE_GATE_NOTE)).toBeNull();
    });

    it("records normally once ungated, and the record then outranks the gate", async () => {
      const user = userEvent.setup();
      seedPosture("sitting");
      act(() => {
        useIncidentStore.getState().beginDescent("N-07");
        useIncidentStore
          .getState()
          .applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
        useIncidentStore.getState().applyDiagEvent({
          t: "diag_event",
          unitId: "N-07",
          ev: { k: "verdict", report },
        });
      });
      const live = () => useIncidentStore.getState().session!;
      const { rerender } = render(<VerdictCard session={live()} />);

      await user.click(screen.getByRole("button", { name: /^disable joint$/i }));
      expect(live().acknowledged).toEqual(["Disable joint"]);
      rerender(<VerdictCard session={live()} />);

      // Recorded is a fact about the incident; posture cannot un-happen it.
      act(() =>
        useFleetStore
          .getState()
          .applyUnitUpdate({ t: "unit_update", unit: summary("walking") }),
      );
      const recorded = screen.getByRole("button", { name: /disable joint · recorded/i });
      expect(recorded).toBeDisabled();
      expect(recorded).toHaveAttribute("aria-pressed", "true");
    });
  });

  /**
   * The copy stutter this replaced: the button changed to read "· RECORDED"
   * directly above a static note reading "RECORDED · NO COMMAND SENT" — the
   * same word in two tenses, the panel stammering while insisting nothing
   * happened. The note now describes what the group does and when; the button
   * states what happened, with the clock reading that makes it a log entry
   * rather than a toggle echo.
   */
  describe("recording an action", () => {
    const live = () => useIncidentStore.getState().session!;

    const toVerdict = () => {
      act(() => {
        useIncidentStore.getState().beginDescent("N-07");
        useIncidentStore
          .getState()
          .applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
        useIncidentStore.getState().applyDiagEvent({
          t: "diag_event",
          unitId: "N-07",
          ev: { k: "verdict", report },
        });
      });
    };

    it("stamps the press with a clock reading, not just a tense", async () => {
      const user = userEvent.setup();
      toVerdict();
      const { rerender } = render(<VerdictCard session={live()} />);

      await user.click(screen.getByRole("button", { name: /^Dispatch service$/i }));
      rerender(<VerdictCard session={live()} />);

      const pressed = screen.getByRole("button", {
        name: /dispatch service · recorded/i,
      });
      // HH:MM:SS, 24-hour — the same formatter the incident history and the
      // alert feed use, so three surfaces cannot disagree about a clock.
      expect(pressed).toHaveAccessibleName(
        /^Dispatch service · recorded \d{2}:\d{2}:\d{2}$/i,
      );
    });

    it("makes a record that happened stop being an offer", async () => {
      const user = userEvent.setup();
      seedPosture("sitting"); // ungate DISABLE JOINT; the gate has its own suite
      toVerdict();
      const { rerender } = render(<VerdictCard session={live()} />);

      await user.click(screen.getByRole("button", { name: /^Disable joint$/i }));
      rerender(<VerdictCard session={live()} />);

      const pressed = screen.getByRole("button", { name: /disable joint · recorded/i });
      expect(pressed).toBeDisabled();
      expect(pressed).toHaveAttribute("aria-pressed", "true");

      // And the store agrees it is a set: a repeat changes nothing, so the
      // incident cannot archive the same acknowledgement twice.
      act(() => {
        useIncidentStore.getState().acknowledgeRecommendation("Disable joint");
        useIncidentStore.getState().acknowledgeRecommendation("Disable joint");
      });
      expect(live().acknowledged).toEqual(["Disable joint"]);
    });

    it("keeps the stamp when the card is put down and picked back up", async () => {
      const user = userEvent.setup();
      toVerdict();
      const { rerender, unmount } = render(<VerdictCard session={live()} />);

      await user.click(screen.getByRole("button", { name: /^Dispatch service$/i }));
      rerender(<VerdictCard session={live()} />);
      const before = (
        await screen.findByRole("button", { name: /dispatch service · recorded/i })
      ).textContent;

      // MINIMIZE unmounts the card (and on a phone the sheet leaves entirely).
      unmount();
      render(<VerdictCard session={live()} />);

      const after = screen.getByRole("button", {
        name: /dispatch service · recorded/i,
      }).textContent;
      expect(after).toBe(before);
      expect(after).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it("does not leak the stamp into what the incident archives", async () => {
      const user = userEvent.setup();
      toVerdict();
      render(<VerdictCard session={live()} />);

      await user.click(screen.getByRole("button", { name: /^Dispatch service$/i }));
      act(() => useIncidentStore.getState().completeAscent());

      // The unit page's history joins these strings straight into its
      // "Acknowledged: …" line, beside that row's own clock. A timestamp
      // smuggled in here would print twice, in two formats, on one line.
      expect(useIncidentStore.getState().history[0]?.acknowledged).toEqual([
        "Dispatch service",
      ]);
    });

    it("files the press time once, so a repeat cannot move it", () => {
      expect(markAcknowledged("N-07", 1_000, "Disable joint", 111_000)).toBe(111_000);
      expect(markAcknowledged("N-07", 1_000, "Disable joint", 999_000)).toBe(111_000);
      expect(acknowledgedTime("N-07", 1_000, "Disable joint")).toBe(111_000);
      // Keyed by session: a second scan of the same unit starts clean.
      expect(acknowledgedTime("N-07", 2_000, "Disable joint")).toBeUndefined();
    });

    it("prints the word alone rather than inventing a clock it never saw", () => {
      expect(acknowledgedLabel("Disable joint", null)).toBe("Disable joint · recorded");
      expect(acknowledgedLabel("Disable joint", "14:32:07")).toBe(
        "Disable joint · recorded 14:32:07",
      );
    });
  });

  it("leaves a clean scan's actions area exactly as it was", () => {
    render(
      <VerdictCard
        session={session({
          flag: null,
          report: {
            ...report,
            joint: "all",
            component: "all",
            anomaly: "none",
            summary: "SCAN COMPLETE. NO ANOMALY DETECTED.",
            recommendations: ["No action required"],
          },
        })}
      />,
    );

    expect(screen.getByText("No action required")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /execute/i })).toBeNull();
    expect(screen.queryByRole("group", { name: /record to incident/i })).toBeNull();
    expect(screen.queryByText(/no command sent/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("SafeSitConfirm", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
    await user.click(screen.getByRole("button", { name: /command safe sit/i }));
    return screen.getByRole("alertdialog");
  };

  it("states what the maneuver does to the unit before it is ordered", async () => {
    const user = userEvent.setup();
    const dialog = await open(user);

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(/confirm safe sit · unit n-07/i);
    expect(dialog).toHaveTextContent(/torque to hold residual/i);
    expect(dialog).toHaveTextContent(/unit remains monitored/i);
    // The line that stops "SAFE SIT COMPLETE" from being read as "fixed".
    expect(dialog).toHaveTextContent(/service still required/i);
    // Nothing has left the console yet.
    expect(sent).toEqual([]);
  });

  it("opens with ABORT focused, not CONFIRM", async () => {
    const user = userEvent.setup();
    await open(user);
    // A second Return keystroke must not be able to command a robot.
    expect(screen.getByRole("button", { name: /^abort$/i })).toHaveFocus();
  });

  it("traps the keyboard between its two controls", async () => {
    const user = userEvent.setup();
    await open(user);
    const confirm = screen.getByRole("button", { name: /^confirm$/i });
    const abort = screen.getByRole("button", { name: /^abort$/i });

    // ABORT is last in the DOM: forward off the end returns to CONFIRM.
    await user.tab();
    expect(confirm).toHaveFocus();
    // And backward off the front returns to ABORT.
    await user.tab({ shift: true });
    expect(abort).toHaveFocus();
  });

  it("aborts on Escape without ascending out of machine space", async () => {
    const user = userEvent.setup();
    let escapesReachingTheSurface = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") escapesReachingTheSurface += 1;
    };
    window.addEventListener("keydown", onKey);

    await open(user);
    await user.keyboard("{Escape}");

    window.removeEventListener("keydown", onKey);
    // The descent surface listens on the window and treats Escape as "leave".
    expect(escapesReachingTheSurface).toBe(0);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("hands focus back to the control it replaced when aborted", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: /^abort$/i }));
    expect(screen.getByRole("button", { name: /command safe sit/i })).toHaveFocus();
  });

  it("sends the command and records the recommendation on confirm", async () => {
    const user = userEvent.setup();
    // A live session, so the acknowledgement has somewhere to land.
    act(() => {
      useIncidentStore.getState().beginDescent("N-07");
      useIncidentStore
        .getState()
        .applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
      useIncidentStore.getState().applyDiagEvent({
        t: "diag_event",
        unitId: "N-07",
        ev: { k: "verdict", report },
      });
    });

    await open(user);
    await user.click(screen.getByRole("button", { name: /^confirm$/i }));

    expect(sent).toEqual([{ c: "COMMAND_SAFE_SIT", unitId: "N-07" }]);
    expect(useIncidentStore.getState().session?.acknowledged).toEqual([
      "Command safe sit",
    ]);
  });

  it("records nothing when there was no link to send on", async () => {
    setCommandTransport(null);
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: /^confirm$/i }));

    expect(screen.getByText(/not sent · no link/i)).toBeInTheDocument();
    expect(useIncidentStore.getState().session).toBeNull();
    // Still offered: the operator can try again once the link is back.
    expect(screen.getByRole("button", { name: /command safe sit/i })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------

describe("the gap between sent and accepted", () => {
  it("says SENT and nothing else — no percentage, no bar", async () => {
    const user = userEvent.setup();
    render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
    await user.click(screen.getByRole("button", { name: /command safe sit/i }));
    await user.click(screen.getByRole("button", { name: /^confirm$/i }));

    const button = screen.getByRole("button", { name: /command safe sit · sent/i });
    expect(button).toBeDisabled();
    // The store has said nothing yet, so neither has the console.
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(useCommandStore.getState().commands[SIT_KEY]).toBeUndefined();
  });

  it("does not drop the keyboard on the floor when the command goes", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SafeSitAction unitId="N-07" action="Command safe sit" />,
    );
    await user.click(screen.getByRole("button", { name: /command safe sit/i }));
    await user.click(screen.getByRole("button", { name: /^confirm$/i }));

    // CONFIRM unmounts itself and is replaced by a disabled button and a status
    // line — nothing focusable — so focus would otherwise land on <body> at the
    // exact moment the operator commanded a robot.
    expect(document.activeElement).not.toBe(document.body);
    expect(container.firstElementChild).toHaveFocus();
  });

  it("hands over to the store the moment the machine answers", async () => {
    const user = userEvent.setup();
    render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
    await user.click(screen.getByRole("button", { name: /command safe sit/i }));
    await user.click(screen.getByRole("button", { name: /^confirm$/i }));

    say({ k: "accepted" });

    expect(screen.queryByRole("button", { name: /command safe sit/i })).toBeNull();
    expect(screen.getByText(/safe sit · accepted/i)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });
});

// ---------------------------------------------------------------------------

describe("execution, as the machine narrates it", () => {
  const beats = [
    { pct: 20, note: "GAIT ARRESTED" },
    { pct: 45, note: "CROUCH PHASE" },
    { pct: 70, note: "TORQUE RAMP-DOWN" },
    { pct: 90, note: "POSTURE SETTLED" },
  ];

  it("prints every progress note verbatim, at the pct the wire reported", () => {
    render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
    say({ k: "accepted" });

    for (const beat of beats) {
      say({ k: "progress", pct: beat.pct, note: beat.note });
      expect(
        screen.getByText(`SAFE SIT · ${beat.pct}% · ${beat.note}`),
      ).toBeInTheDocument();
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        String(beat.pct),
      );
    }
  });

  it("cannot be put away mid-maneuver", () => {
    render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
    say({ k: "accepted" });
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
    say({ k: "progress", pct: 45, note: "CROUCH PHASE" });
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  it("lands on a statement, not a celebration, and can then be put away", async () => {
    const user = userEvent.setup();
    render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
    say({ k: "accepted" });
    say({ k: "progress", pct: 90, note: "POSTURE SETTLED" });
    say({ k: "complete" });

    expect(screen.getByText("SAFE SIT COMPLETE")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");

    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    // Put away, and the control is offered again — the operator may need it.
    expect(useCommandStore.getState().commands[SIT_KEY]).toBeUndefined();
    expect(screen.getByRole("button", { name: /command safe sit/i })).toBeEnabled();
  });

  it("leaves the audit trail a command owes", () => {
    render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
    say({ k: "accepted" });
    say({ k: "progress", pct: 20, note: "GAIT ARRESTED" });
    say({ k: "complete" });

    const kinds = useAuditStore.getState().entries.map((e) => e.kind);
    expect(kinds).toContain("command-accepted");
    expect(kinds).toContain("command-complete");
    // Narration is not record: four progress beats must not become four rows.
    expect(kinds.filter((k) => k === "command-accepted")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("refusals", () => {
  // The three the sim can answer with (sim/engine.ts), printed verbatim.
  const reasons = ["ALREADY SITTING", "SIT IN PROGRESS", "SCAN IN PROGRESS"];

  for (const reason of reasons) {
    it(`prints "${reason}" as the machine said it, and stays dismissible`, async () => {
      const user = userEvent.setup();
      render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
      say({ k: "failed", reason });

      expect(screen.getByText(`REFUSED · ${reason}`)).toBeInTheDocument();
      // Nothing happened, so nothing is drawn as having partly happened.
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");

      await user.click(screen.getByRole("button", { name: /dismiss/i }));
      expect(screen.getByRole("button", { name: /^command safe sit$/i })).toBeEnabled();
    });
  }

  it("keeps the reason on the audit trail even after the card is cleared", async () => {
    const user = userEvent.setup();
    render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
    say({ k: "failed", reason: "SCAN IN PROGRESS" });
    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(
      useAuditStore.getState().entries.some((e) => /SCAN IN PROGRESS/.test(e.summary)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/**
 * The header of execute-action.tsx says focus never falls to `<body>`
 * when the confirmation unmounts. It had one way of keeping that promise —
 * focus the trigger — and the trigger is `disabled` in most of the states the
 * promise is made in. `HTMLElement.focus()` on a disabled button is a silent
 * no-op, so these are the exits that were quietly dropping the keyboard.
 */
describe("the keyboard, on every way out of the confirmation", () => {
  const openConfirm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: /^command safe sit$/i }));
    expect(screen.getByRole("button", { name: /^abort$/i })).toHaveFocus();
  };

  it("keeps it when the gate closes under an open confirmation", async () => {
    const user = userEvent.setup();
    seedPosture("walking");
    const { container } = render(
      <SafeSitAction unitId="N-07" action="Command safe sit" />,
    );
    await openConfirm(user);

    // A second console sits the robot down (or a RESET_SIM rebuilds it): the
    // precondition is gone, so the offer is withdrawn with the operator
    // standing inside it.
    act(() =>
      useFleetStore
        .getState()
        .applyUnitUpdate({ t: "unit_update", unit: summary("sitting") }),
    );

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: /command safe sit · already sitting/i }),
    ).toBeDisabled();
    expect(document.activeElement).not.toBe(document.body);
    expect(container.firstElementChild).toHaveFocus();
  });

  it("keeps it — on the trigger, with the reason attached — when nothing left", async () => {
    setCommandTransport(null);
    const user = userEvent.setup();
    render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
    await openConfirm(user);
    await user.click(screen.getByRole("button", { name: /^confirm$/i }));

    // The one moment the console MUST reach a keyboard operator: a command
    // aimed at a robot did not leave the building.
    expect(document.activeElement).not.toBe(document.body);
    const trigger = screen.getByRole("button", { name: /^command safe sit$/i });
    expect(trigger).toHaveFocus();
    // ...and the failure travels with the control it landed on.
    const note = screen.getByText(/not sent · no link/i);
    expect(trigger).toHaveAttribute("aria-describedby", note.id);
  });

  it("keeps it when the receipt is put away and the control returns", async () => {
    const user = userEvent.setup();
    render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
    say({ k: "accepted" });
    say({ k: "complete" });

    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    // DISMISS unmounts itself; the trigger comes back where it stood.
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("button", { name: /^command safe sit$/i })).toHaveFocus();
  });
});

/**
 * The two executed commands share a unit and, for one release, its one
 * store slot — so the second one to answer erased the first one's receipt.
 */
describe("two maneuvers on one robot", () => {
  it("does not lose a finished sit's receipt to the command that follows it", () => {
    render(<SafeSitAction unitId="N-07" action="Command safe sit" />);
    say({ k: "accepted" });
    say({ k: "complete" });
    expect(screen.getByText("SAFE SIT COMPLETE")).toBeInTheDocument();

    // The next rung on the ladder, on the same robot, while the operator still
    // has the sit's outcome in front of them.
    say({ k: "accepted" }, "N-07", "RECALIBRATE_JOINT");

    // The receipt and its DISMISS are still there: nothing on this surface may
    // silently replace the outcome of a command the operator gave.
    expect(screen.getByText("SAFE SIT COMPLETE")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
    // And the sit is not re-offered as if it had never run.
    expect(screen.queryByRole("button", { name: /^command safe sit$/i })).toBeNull();
  });
});

describe("CommandStatusLine", () => {
  it("is a live region that exists before it has anything to say", () => {
    const { container } = render(<CommandStatusLine unitId="N-07" />);
    const region = container.querySelector('[data-slot="command-status"]');
    // Mounted and empty: a live region created with its text already inside it
    // is one a screen reader is entitled to ignore.
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("");
  });

  it("carries the same sentence the card does", () => {
    render(<CommandStatusLine unitId="N-07" />);
    say({ k: "accepted" });
    say({ k: "progress", pct: 45, note: "CROUCH PHASE" });
    expect(screen.getByText("SAFE SIT · 45% · CROUCH PHASE")).toBeInTheDocument();
    say({ k: "failed", reason: "SIT IN PROGRESS" });
    expect(screen.getByText("REFUSED · SIT IN PROGRESS")).toBeInTheDocument();
  });

  it("minds its own unit", () => {
    render(<CommandStatusLine unitId="N-07" />);
    say({ k: "accepted" }, "N-03");
    expect(screen.queryByText(/safe sit/i)).toBeNull();
  });
});
