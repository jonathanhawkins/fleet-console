import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { setCommandTransport } from "./telemetry-command";
import {
  BASELINE,
  Card,
  card,
  fleetEvent,
  formCohort,
  installCohortHarness,
  key,
  MEMBERS,
  press,
  restore,
  rollbackRow,
  SUSPECT,
  sent,
} from "./cohort-harness";

/**
 * The fleet-scale actions and the discipline around them: confirmation, halting a
 * rollout, and draining a rollback one robot at a time.
 *
 * Preamble and hooks: cohort-harness.tsx.
 */

installCohortHarness();

describe("the confirmation, SAFE SIT's discipline in operator space", () => {
  beforeEach(() => {
    formCohort();
    render(<Card />);
    press("Halt rollout");
  });

  it("is a real modal, in the flow rather than over the evidence", () => {
    const gate = screen.getByRole("alertdialog");
    expect(gate).toHaveAttribute("aria-modal", "true");
    // The canary line and the member chips are still on screen: the operator is
    // weighing the decision against the evidence, not against a scrim.
    expect(
      screen.getByText("All on firmware 2.4.1 — 0 of 4 units on 2.3.7 affected"),
    ).toBeInTheDocument();
    expect(within(gate).getByRole("heading", { name: "Halt the 2.4.1 rollout?" }));
  });

  it("opens with focus on Cancel, never on the dangerous control", () => {
    // The operator who double-tapped Return is exactly who this catches.
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("gives Confirm and Cancel the same weight", () => {
    const gate = screen.getByRole("alertdialog");
    const confirm = within(gate).getByRole("button", { name: "Confirm" });
    const cancel = within(gate).getByRole("button", { name: "Cancel" });
    expect(confirm.getAttribute("data-variant")).toBe(
      cancel.getAttribute("data-variant"),
    );
    expect(confirm).toHaveAttribute("data-variant", "secondary");
  });

  it("states the save AND the thing the save does not do", () => {
    const gate = screen.getByRole("alertdialog");
    expect(
      within(gate).getByText("Prevents the scheduled update on N-05."),
    ).toBeInTheDocument();
    expect(
      within(gate).getByText("Units already on 2.4.1 are unaffected."),
    ).toBeInTheDocument();
    expect(
      within(gate).getByText("Roll back the cohort to restore them."),
    ).toBeInTheDocument();
  });

  it("aborts on Escape and sends nothing", () => {
    key(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent).toHaveLength(0);
    // Focus comes back to the control that opened it.
    expect(screen.getByRole("button", { name: "Halt rollout" })).toHaveFocus();
  });

  it("aborts on Cancel and sends nothing", () => {
    press("Cancel");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("keeps Tab inside the gate at both ends", () => {
    const confirm = screen.getByRole("button", { name: "Confirm" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    // Forward off the last returns to the first...
    key(cancel, { key: "Tab" });
    expect(confirm).toHaveFocus();
    // ...and back off the first returns to the last.
    key(confirm, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
  });
});

describe("halting the rollout", () => {
  beforeEach(() => {
    formCohort();
    render(<Card />);
  });

  const confirmHalt = () => {
    press("Halt rollout");
    press("Confirm");
  };

  it("sends the fleet-scoped command and claims nothing until it is answered", () => {
    confirmHalt();
    expect(sent).toEqual([{ c: "HALT_ROLLOUT" }]);
    // A word, not a bar: the fleet has not agreed to anything yet.
    expect(screen.getByText("Awaiting fleet response")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/Rollout halted/)).toBeNull();
  });

  it("renders the save as the receipt, in the page's voice", () => {
    confirmHalt();
    fleetEvent("HALT_ROLLOUT", { k: "accepted" });
    fleetEvent("HALT_ROLLOUT", {
      k: "progress",
      pct: 100,
      note: `ROLLOUT HALTED — N-05 REMAINS ON ${BASELINE}`,
    });
    fleetEvent("HALT_ROLLOUT", { k: "complete" });

    // The receipt is the machine's own claim about the non-event, read in the
    // page's voice. It is deliberately NOT re-derived from store state: the
    // save is the fleet's assertion, not the console's.
    expect(
      screen.getByText("Rollout halted — N-05 remains on 2.3.7"),
    ).toBeInTheDocument();
  });

  it("prints a refusal in the fleet's own words, and says what to do instead", () => {
    // The storyline's other ending: the operator reached for HALT after the
    // queued install already landed.
    confirmHalt();
    fleetEvent("HALT_ROLLOUT", { k: "failed", reason: "NO ROLLOUT ACTIVE" });

    expect(screen.getByText("Refused — NO ROLLOUT ACTIVE")).toBeInTheDocument();
    expect(screen.getByText(/Rolling back the cohort restores/)).toBeInTheDocument();
    // The other door is still open, and still the operator's to take.
    expect(screen.getByRole("button", { name: "Roll back cohort" })).toBeEnabled();
  });

  it("lets a finished lifecycle be put away, and offers the action again", () => {
    confirmHalt();
    fleetEvent("HALT_ROLLOUT", { k: "failed", reason: "NO ROLLOUT ACTIVE" });
    press("Clear halt rollout");
    expect(screen.queryByText("Refused — NO ROLLOUT ACTIVE")).toBeNull();
    expect(screen.getByRole("button", { name: "Halt rollout" })).toBeInTheDocument();
  });

  it("says so when nothing left the building", () => {
    setCommandTransport(null);
    confirmHalt();
    expect(screen.getByText("Not sent · no link to the fleet")).toBeInTheDocument();
  });
});

describe("rolling the cohort back", () => {
  beforeEach(() => {
    formCohort();
    render(<Card />);
  });

  const confirmRollback = () => {
    press("Roll back cohort");
    press("Confirm");
  };

  it("states the staging and the expected duration before it is ordered", () => {
    press("Roll back cohort");
    const gate = screen.getByRole("alertdialog");
    expect(
      within(gate).getByRole("heading", { name: "Roll back 4 units from 2.4.1?" }),
    ).toBeInTheDocument();
    expect(
      within(gate).getByText("Rolls back 4 units, one at a time — about 16 seconds."),
    ).toBeInTheDocument();
    expect(
      within(gate).getByText("Alerts clear as each unit completes."),
    ).toBeInTheDocument();
    expect(
      within(gate).getByText("The queued update on N-05 is canceled too."),
    ).toBeInTheDocument();
  });

  it("names the cohort's firmware on the wire, never a string the UI built", () => {
    confirmRollback();
    expect(sent).toEqual([{ c: "ROLLBACK_COHORT", fw: SUSPECT }]);
  });

  it("walks the roster one unit at a time, off firmware truth", () => {
    confirmRollback();
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });

    expect(
      screen.getByText("Rolling back 4 units — 0 of 4 restored."),
    ).toBeInTheDocument();
    expect(rollbackRow("N-02")).toHaveAttribute("data-phase", "rolling-back");
    expect(rollbackRow("N-04")).toHaveAttribute("data-phase", "waiting");

    restore("N-02");
    expect(rollbackRow("N-02")).toHaveAttribute("data-phase", "restored");
    expect(rollbackRow("N-04")).toHaveAttribute("data-phase", "rolling-back");
    expect(
      screen.getByText("Rolling back 4 units — 1 of 4 restored."),
    ).toBeInTheDocument();
  });

  it("keeps the whole roster on screen as the cohort dissolves beneath it", () => {
    // Membership tracks current truth, so the derivation drops below threshold
    // partway through. The card is narrating a command by then, not a cohort.
    confirmRollback();
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });
    restore("N-02");
    restore("N-04");

    expect(card()).toHaveAttribute("data-dissolved", "true");
    expect(rollbackRow("N-06")).not.toBeNull();
    expect(rollbackRow("N-08")).not.toBeNull();
    expect(
      screen.getByText("Rolling back 4 units — 2 of 4 restored."),
    ).toBeInTheDocument();
  });

  it("ends on a receipt naming the build the fleet actually reported", () => {
    confirmRollback();
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });
    for (const id of MEMBERS) restore(id);
    fleetEvent("ROLLBACK_COHORT", { k: "complete" });

    expect(
      screen.getByText("Rollback complete — 4 units restored to 2.3.7."),
    ).toBeInTheDocument();
    for (const id of MEMBERS) {
      expect(rollbackRow(id)).toHaveAttribute("data-phase", "restored");
    }
  });

  it("cools down and changes tense when the incident is actually over", () => {
    confirmRollback();
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });
    // Mid-flight it is still the amber question, in the present tense.
    expect(card()).not.toHaveAttribute("data-settled");
    expect(
      screen.getByRole("heading", { name: "4 units raising the same warning" }),
    ).toBeInTheDocument();

    for (const id of MEMBERS) restore(id);
    fleetEvent("ROLLBACK_COHORT", { k: "complete" });

    // A card insisting "raising" over a fleet counting zero alerting units
    // would be the loudest object on the page arguing with it.
    expect(card()).toHaveAttribute("data-settled", "true");
    expect(
      screen.getByRole("heading", { name: "4 units raised the same warning" }),
    ).toBeInTheDocument();
  });

  it("animates no rollback the fleet declined", () => {
    confirmRollback();
    fleetEvent("ROLLBACK_COHORT", { k: "failed", reason: "ROLLBACK IN PROGRESS" });
    expect(screen.getByText("Refused — ROLLBACK IN PROGRESS")).toBeInTheDocument();
    expect(rollbackRow("N-02")).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
   the settled card, and the way out of it
--------------------------------------------------------------------------- */
