import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Alert,
  type CommandEvent,
  type FleetSnapshotMessage,
  type OperatorCommand,
  type UnitSummary,
} from "@/lib/schema";
import {
  resetCohortDerivation,
  useAuditStore,
  useCohortRecordStore,
  useCommandStore,
  useFleetStore,
  type CohortResolution,
} from "@/lib/stores";
import { type TelemetryTransport } from "@/lib/transport";
import { clockTime, formatDuration } from "./alert-lifecycle";
import { setAlertFilter } from "./alert-rail";
import { AlertRail } from "./alert-rail";
import { auditLine } from "./audit-line";
import { CohortCard, useCohortSubject } from "./cohort-card";
import CohortIncidentCard, { CohortRecord } from "./cohort-incident";
import { resetCohortMembership, selectCohortMembers } from "./cohort-membership";
import { resetIncidentReport } from "./incident-report";
import { setCommandTransport } from "./telemetry-command";
import { UnitCard } from "./unit-card";

/**
 * The console noticing that four alerts are ONE incident, and giving
 * the operator fleet-scale actions with SAFE SIT's safety discipline — in
 * operator space, where the vocabulary is sentence case and the consequence is
 * four robots instead of one.
 *
 * The three things this file exists to hold down:
 *
 * 1. Nothing on screen claims a fleet-scale action the fleet has not agreed to.
 * No optimistic receipt, no progress bar over a round trip, no rollback list
 * animating a command that was refused.
 * 2. The confirmation is a real gate: focus lands on the cancel, Escape aborts,
 * and the two choices carry the same weight.
 * 3. The progress list is a reading of firmware truth, so it cannot drift from
 * what the rail rows and the map markers are showing about the same units.
 */

const BASE = 1_700_000_000_000;
const NOW = BASE + 34_000;

const SIGNATURE = "Balance reflex latency above threshold";
const SUSPECT = "2.4.1";
const BASELINE = "2.3.7";

/** N-02/04/06/08 on the rollout build, N-05 queued for it, the rest baseline. */
function unit(id: string, fw: string, fwPending?: string, battery = 80): UnitSummary {
  return {
    id,
    name: `${id} House`,
    status: "nominal",
    // Restatements carry a drifted battery because the sim's do: `summarize`
    // always reads the live value, and a test that restated a byte-identical
    // summary would be exercising the store's no-op path instead of the wire's.
    battery,
    pos: { lat: 44.06, lng: -121.31 },
    fw,
    ...(fwPending !== undefined ? { fwPending } : {}),
  };
}

const SNAPSHOT: FleetSnapshotMessage = {
  t: "fleet_snapshot",
  units: [
    unit("N-01", BASELINE),
    unit("N-02", SUSPECT),
    unit("N-03", BASELINE),
    unit("N-04", SUSPECT),
    unit("N-05", BASELINE, SUSPECT),
    unit("N-06", SUSPECT),
    unit("N-07", BASELINE),
    unit("N-08", SUSPECT),
  ],
};

const MEMBERS = ["N-02", "N-04", "N-06", "N-08"];

const sent: OperatorCommand[] = [];
const transport: TelemetryTransport = {
  connect: () => {},
  send: (cmd) => sent.push(cmd),
  disconnect: () => {},
};

let seq = 0;

/** Raise one member's signature alert — byte-identical message, by design. */
function raise(unitId: string, at: number): Alert {
  const alert: Alert = {
    id: `al-${unitId}`,
    unitId,
    severity: "amber",
    message: SIGNATURE,
    ts: at,
  };
  act(() => {
    useFleetStore.getState().applyAlert({ t: "alert", alert });
  });
  return alert;
}

/** Everything up to and including the alert that crosses the threshold. */
function formCohort(members: readonly string[] = MEMBERS): void {
  members.forEach((id, i) => raise(id, BASE + i * 1_000));
}

function fleetEvent(
  cmd: "HALT_ROLLOUT" | "ROLLBACK_COHORT",
  ev: CommandEvent,
  fw = SUSPECT,
): void {
  act(() => {
    useCommandStore.getState().applyFleetCommandEvent({
      t: "fleet_command_event",
      cmd,
      fw,
      seq: (seq += 1),
      ts: NOW,
      ev,
    });
  });
}

/**
 * What the engine does at ROLLBACK_COHORT accept, beyond the lifecycle event.
 *
 * "Rolling a build back implies halting its rollout: a still-queued install of
 * cmd.fw is canceled here (visible as the unit_update dropping fwPending), and
 * rolloutHalted flips so a later HALT_ROLLOUT answers NO ROLLOUT ACTIVE
 * truthfully" (sim/engine.ts). The card reads the queue off `fwPending`, so a
 * fixture that skipped this restatement left the console — correctly — still
 * offering a halt for an install the wire still said was scheduled.
 */
function cancelQueuedInstall(): void {
  act(() => {
    useFleetStore.getState().applyUnitUpdate({
      t: "unit_update",
      unit: unit("N-05", BASELINE, undefined, 79.8),
    });
  });
}

/** The engine's per-unit consequence: firmware restated, then the alert cleared. */
function restore(unitId: string): void {
  act(() => {
    useFleetStore.getState().applyUnitUpdate({
      t: "unit_update",
      unit: unit(unitId, BASELINE, undefined, 79.4),
    });
    useFleetStore.getState().resolveAlert(`al-${unitId}`, { via: "rollback" });
  });
}

function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-slot='cohort-card']");
}

function rollbackRow(unitId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-slot='rollback-unit'][data-unit='${unitId}']`,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  seq = 0;
  sent.length = 0;
  setAlertFilter("open");
  useFleetStore.getState().reset();
  useCommandStore.getState().reset();
  // Fleet and command reducers both append to the audit log; a stale log would
  // leak the previous test's receipts into this one.
  useAuditStore.getState().reset();
  // The close-out is session-scoped like the log: a record left over from the
  // previous test would suppress the next one's card before it existed.
  useCohortRecordStore.getState().reset();
  resetCohortDerivation();
  resetCohortMembership();
  setCommandTransport(transport);
  useFleetStore.getState().applySnapshot(SNAPSHOT);
});

afterEach(() => {
  setCommandTransport(null);
  vi.useRealTimers();
});

/**
 * `fireEvent`, not `userEvent`: this suite runs on fake timers (the card has a
 * ticking duration), and user-event's own delay loop does not resolve under
 * them. The same choice alert-rail.test.tsx makes, for the same reason.
 */
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const key = (el: Element, init: Partial<KeyboardEvent>) => fireEvent.keyDown(el, init);

/**
 * The card body, mounted against the gate's own judgement.
 *
 * `CohortCard` puts the body behind a `next/dynamic` boundary — the fleet
 * page's initial JS is measured against a hard budget and this card renders a
 * state that does not exist on load. That boundary is an async import, which
 * every synchronous assertion below would have to wait on for no benefit: the
 * thing under test is what the card SAYS, not how its chunk arrives. So the
 * suite renders the body directly, driven by `useCohortSubject` — the exact
 * derivation the gate uses, so the two cannot disagree about when a fleet
 * incident exists — and the boundary itself is covered once, in "the gate".
 */
function Card() {
  const subject = useCohortSubject();
  if (subject === null) return null;
  return <CohortIncidentCard cohort={subject.cohort} dissolved={subject.dissolved} />;
}

describe("presence", () => {
  it("says nothing on a healthy fleet", () => {
    render(<Card />);
    expect(card()).toBeNull();
  });

  it("says nothing below the threshold — two units are two problems", () => {
    formCohort(["N-02", "N-04"]);
    render(<Card />);
    expect(card()).toBeNull();
  });

  it("arrives when the group crosses it", () => {
    formCohort();
    render(<Card />);
    expect(card()).not.toBeNull();
  });
});

describe("the card's composition", () => {
  beforeEach(() => {
    formCohort();
    render(<Card />);
  });

  it("heads with the count and quotes the shared signature verbatim", () => {
    expect(
      screen.getByRole("heading", { name: "4 units raising the same warning" }),
    ).toBeInTheDocument();
    expect(screen.getByText(`“${SIGNATURE}”`)).toBeInTheDocument();
  });

  it("prints the canary comparison — the argument for touching a build", () => {
    expect(
      screen.getByText("All on firmware 2.4.1 — 0 of 4 units on 2.3.7 affected"),
    ).toBeInTheDocument();
  });

  it("links every member to its unit page, status-aware", () => {
    for (const id of MEMBERS) {
      // The chip shows a coloured dot; a screen reader gets the word behind it,
      // with the visible id leading so the two names agree (WCAG 2.5.3).
      expect(screen.getByRole("link", { name: `${id}, Attention` })).toHaveAttribute(
        "href",
        `/unit/${id}`,
      );
    }
  });

  it("names the queued unit — the thing a halt is racing", () => {
    expect(screen.getByText(/N-05 is scheduled for 2\.4\.1/)).toBeInTheDocument();
  });

  it("dates the incident from the alert that crossed the threshold, and ticks", () => {
    // Not the first raise: the incident began when it became an incident, and
    // the derivation freezes `detectedAt` at exactly that alert (the third).
    const header = card()!;
    expect(within(header).getByText(/^32s$/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(within(header).getByText(/^38s$/)).toBeInTheDocument();
  });

  it("carries the page's one dark pill while it exists", () => {
    expect(screen.getByRole("button", { name: "Halt rollout" })).toHaveAttribute(
      "data-variant",
      "primary",
    );
    expect(screen.getByRole("button", { name: "Roll back cohort" })).toHaveAttribute(
      "data-variant",
      "secondary",
    );
  });
});

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

describe("the settled card offers nothing it cannot do", () => {
  beforeEach(() => {
    formCohort();
    render(<Card />);
  });

  /**
   * The reported bug, and the path that produced it: an operator who went
   * straight to the rollback never issued a halt, so the row's old question —
   * "has a halt been issued?" — kept answering no long after there was anything
   * to halt. The page's single dark pill sat on a finished incident pointing at
   * a command the fleet refuses with NO ROLLOUT ACTIVE.
   */
  it("retires the halt the operator never issued", () => {
    press("Roll back cohort");
    press("Confirm");
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });
    cancelQueuedInstall();
    // Mid-flight the halt is still a real thing to reach for.
    expect(screen.getByRole("button", { name: "Halt rollout" })).toBeInTheDocument();

    for (const id of MEMBERS) restore(id);
    fleetEvent("ROLLBACK_COHORT", { k: "complete" });

    expect(card()).toHaveAttribute("data-settled", "true");
    expect(screen.queryByRole("button", { name: "Halt rollout" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Roll back cohort" })).toBeNull();
  });

  /**
   *, and the correction to the correction above.
   *
   * The trigger row was short-circuited by `settled`, which is a fact about
   * ALERT MEMBERSHIP — the group has fallen below COHORT_THRESHOLD — and says
   * nothing whatever about firmware. This is the supported path that separates
   * the two: halt the rollout, then work two members' alerts through their own
   * pages. Membership drops 4 → 2, the derivation lets the group go, and the
   * card retired `Roll back cohort` with four robots still running the suspect
   * build. `rollbackCohort()` has exactly one call site in the product, so that
   * build could not be rolled back again for the rest of the session — under a
   * card printing "incident closed".
   */
  it("keeps the rollback reachable when the group dissolves with the build still on the fleet", () => {
    press("Halt rollout");
    press("Confirm");
    fleetEvent("HALT_ROLLOUT", { k: "accepted" });
    fleetEvent("HALT_ROLLOUT", {
      k: "progress",
      pct: 100,
      note: `ROLLOUT HALTED — N-05 REMAINS ON ${BASELINE}`,
    });
    fleetEvent("HALT_ROLLOUT", { k: "complete" });

    // Two members' alerts resolved from their unit pages. No firmware moves.
    act(() => {
      useFleetStore.getState().resolveAlert("al-N-02", { via: "operator" });
      useFleetStore.getState().resolveAlert("al-N-04", { via: "operator" });
    });

    expect(card()).toHaveAttribute("data-settled", "true");
    // Four robots are still on the suspect build. The one control that can do
    // anything about that is still on the card.
    expect(screen.getByRole("button", { name: "Roll back cohort" })).toBeInTheDocument();
    // And the close-out stands beside it: fix it, or file it as it stands.
    expect(screen.getByRole("button", { name: "Resolve incident" })).toBeInTheDocument();
    // The halt is gone, because the halt has answered and its receipt is above.
    expect(screen.queryByRole("button", { name: "Halt rollout" })).toBeNull();

    // And it is a live control, not a decoration: the command reaches the wire.
    press("Roll back cohort");
    press("Confirm");
    expect(sent).toContainEqual({ c: "ROLLBACK_COHORT", fw: SUSPECT });
  });

  /**
   * The other half of the same rule. Nothing queued, nothing left on the build:
   * a halt would be refused with NO ROLLOUT ACTIVE and a rollback has no target,
   * so neither is offered however the incident got there.
   */
  it("still offers nothing once the build is off every unit and nothing is queued", () => {
    // The queued install is canceled by a halt, and every member is restored by
    // hand rather than by a rollback — no ROLLBACK_COHORT lifecycle at all.
    press("Halt rollout");
    press("Confirm");
    fleetEvent("HALT_ROLLOUT", { k: "complete" });
    for (const id of MEMBERS) restore(id);

    expect(card()).toHaveAttribute("data-settled", "true");
    expect(screen.queryByRole("button", { name: "Halt rollout" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Roll back cohort" })).toBeNull();
    expect(screen.getByRole("button", { name: "Resolve incident" })).toBeInTheDocument();
  });

  /** The other path: halted first — refused, honestly — then rolled back. */
  it("retires both triggers after a refused halt and a completed rollback", () => {
    press("Halt rollout");
    press("Confirm");
    fleetEvent("HALT_ROLLOUT", { k: "failed", reason: "NO ROLLOUT ACTIVE" });
    press("Roll back cohort");
    press("Confirm");
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });
    for (const id of MEMBERS) restore(id);
    fleetEvent("ROLLBACK_COHORT", { k: "complete" });

    expect(screen.queryByRole("button", { name: "Halt rollout" })).toBeNull();
    // The refusal is still on the card — it is what happened, and the operator
    // may be reading it. What is gone is the offer to try it again.
    expect(screen.getByText("Refused — NO ROLLOUT ACTIVE")).toBeInTheDocument();
  });

  /**
   * Clear puts away a COMMAND. On a settled card it was the only way out, which
   * made tidying a receipt the de facto close-out — an incident dismissed
   * through a control that does not mean dismissal, leaving no record that
   * anyone closed anything.
   */
  it("offers one door out, and it is not a receipt's Clear", () => {
    press("Roll back cohort");
    press("Confirm");
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });
    for (const id of MEMBERS) restore(id);
    fleetEvent("ROLLBACK_COHORT", { k: "complete" });

    expect(screen.queryByRole("button", { name: /^Clear/ })).toBeNull();
    const resolve = screen.getByRole("button", { name: "Resolve incident" });
    // Never the dark pill: by now the fleet is not the failing subject.
    expect(resolve).toHaveAttribute("data-variant", "secondary");
    // A RECORD action, and it says so rather than opening a gate.
    expect(
      screen.getByText(
        "Files the incident in the session log. Nothing is sent to the fleet.",
      ),
    ).toBeInTheDocument();
  });

  it("does not offer the close-out while the rollback is still running", () => {
    press("Roll back cohort");
    press("Confirm");
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });
    restore("N-02");
    restore("N-04");
    expect(screen.queryByRole("button", { name: "Resolve incident" })).toBeNull();
  });

  /**
   * The clock stops with the incident. A settled card counting upwards over a
   * fleet reading "Units alerting 0" is the page's loudest object insisting the
   * damage is ongoing.
   */
  it("freezes the span at the moment the fleet closed it", () => {
    press("Roll back cohort");
    press("Confirm");
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });
    for (const id of MEMBERS) restore(id);
    fleetEvent("ROLLBACK_COHORT", { k: "complete" });

    const header = card()!;
    expect(within(header).getByText(/^32s$/)).toBeInTheDocument();
    expect(within(header).getByText(/closed/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // Still 32s — the incident is not getting older, the console is.
    expect(within(header).getByText(/^32s$/)).toBeInTheDocument();
  });
});

describe("firmware, made visible only where it is the question", () => {
  it("marks the members and prints their build in the rail's second line", () => {
    formCohort();
    const members = selectCohortMembers(useFleetStore.getState());
    expect([...members.keys()].sort()).toEqual(MEMBERS);
    expect(members.get("N-02")).toBe(SUSPECT);
    // N-05 is queued for the build and has raised nothing: not a member.
    expect(members.has("N-05")).toBe(false);

    render(
      <UnitCard
        unitId="N-02"
        name="N-02 House"
        status="nominal"
        battery={80}
        fw={SUSPECT}
        cohort
      />,
    );
    const row = document.querySelector("[data-slot='unit-card']")!;
    expect(row).toHaveAttribute("data-cohort", "true");
    expect(within(row as HTMLElement).getByText(SUSPECT)).toBeInTheDocument();
    expect(row).toHaveAccessibleName(expect.stringContaining("Firmware 2.4.1."));
  });

  it("keeps the version off an unaffiliated row", () => {
    render(<UnitCard unitId="N-01" name="N-01 House" status="nominal" battery={80} />);
    const row = document.querySelector("[data-slot='unit-card']")!;
    expect(row).not.toHaveAttribute("data-cohort");
    expect(within(row as HTMLElement).queryByText(BASELINE)).toBeNull();
  });

  it("lets the group go the moment a rollback restates a member's build", () => {
    formCohort();
    restore("N-02");
    const members = selectCohortMembers(useFleetStore.getState());
    expect(members.has("N-02")).toBe(false);
  });

  it("keeps the same lookup identity while cohort truth is unchanged", () => {
    formCohort();
    const first = selectCohortMembers(useFleetStore.getState());
    expect(selectCohortMembers(useFleetStore.getState())).toBe(first);
  });
});

describe("the feed groups without hiding anything", () => {
  it("tags every member row and leaves all four rows standing", () => {
    formCohort();
    render(<AlertRail />);
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-slot='alert-row']"),
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toHaveAttribute("data-cohort", SUSPECT);
      // The card's own label, word for word: two regions naming one thing.
      expect(within(row).getByText(`Cohort · ${SUSPECT}`)).toBeInTheDocument();
    }
  });

  it("does not sweep an unrelated alert on a member unit into the group", () => {
    formCohort();
    raise("N-07", BASE + 5_000);
    act(() => {
      useFleetStore.getState().applyAlert({
        t: "alert",
        alert: {
          id: "al-knee",
          unitId: "N-02",
          severity: "red",
          message: "N-02 House: left knee actuator overheating",
          ts: BASE + 9_000,
        },
      });
    });
    render(<AlertRail />);
    const knee = document.querySelector<HTMLElement>(
      "[data-slot='alert-row'][data-cohort]",
    );
    expect(knee).not.toBeNull();
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-slot='alert-row']"),
    );
    const tagged = rows.filter((r) => r.hasAttribute("data-cohort"));
    // Four members, and only four: the knee alert on N-02 keeps its own row.
    expect(tagged).toHaveLength(4);
  });
});

describe("the session log reads it in operator English", () => {
  it("carries the halt's receipt without shouting it", () => {
    formCohort();
    fleetEvent("HALT_ROLLOUT", { k: "accepted" });
    fleetEvent("HALT_ROLLOUT", {
      k: "progress",
      pct: 100,
      note: `ROLLOUT HALTED — N-05 REMAINS ON ${BASELINE}`,
    });
    fleetEvent("HALT_ROLLOUT", { k: "complete" });

    const entry = useAuditStore
      .getState()
      .entries.find((e) => e.kind === "rollout-halted")!;
    // The store keeps the machine's words; the reading is the page's.
    expect(entry.summary).toBe("ROLLOUT HALTED — N-05 REMAINS ON 2.3.7");
    expect(auditLine(entry)).toBe("Rollout halted — N-05 remains on 2.3.7");
  });

  it("keeps a refusal's reason on the line that reports it", () => {
    fleetEvent("HALT_ROLLOUT", { k: "failed", reason: "NO ROLLOUT ACTIVE" });
    const entry = useAuditStore
      .getState()
      .entries.find((e) => e.kind === "command-failed")!;
    expect(auditLine(entry)).toBe("Halt rollout refused — NO ROLLOUT ACTIVE");
  });

  it("names the staged rollback at both ends", () => {
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });
    fleetEvent("ROLLBACK_COHORT", { k: "complete" });
    const kinds = useAuditStore.getState().entries.map((e) => e.kind);
    expect(kinds).toContain("rollback-started");
    expect(kinds).toContain("rollback-complete");
  });
});

describe("the gate", () => {
  /**
   * The one place the `next/dynamic` boundary itself is exercised: the card's
   * chunk arriving, the reveal opening around it, and the collapse taking the
   * space back. Real timers, because this is the only suite that waits on
   * something asynchronous.
   */
  beforeEach(() => {
    vi.useRealTimers();
  });

  const reveal = () => document.querySelector<HTMLElement>("[data-slot='cohort-reveal']");

  it("ships nothing and renders nothing while the fleet is healthy", async () => {
    render(<CohortCard />);
    await act(async () => {});
    expect(reveal()).toBeNull();
    expect(card()).toBeNull();
  });

  it("loads the card and opens the space for it when a cohort forms", async () => {
    formCohort();
    render(<CohortCard />);
    await waitFor(() => expect(card()).not.toBeNull());
    expect(reveal()).not.toHaveAttribute("inert");
  });

  it("closes the space rather than dropping the card out of the page", async () => {
    formCohort();
    render(<CohortCard />);
    await waitFor(() => expect(card()).not.toBeNull());

    act(() => {
      for (const id of MEMBERS) {
        useFleetStore.getState().resolveAlert(`al-${id}`, { via: "rollback" });
      }
    });

    // The wrapper stays mounted for the length of the collapse and is inert
    // while it plays — a card you can still click is worse than a ghost.
    await waitFor(() => expect(reveal()).toHaveAttribute("inert"));
    expect(reveal()).not.toHaveAttribute("data-open");
  });
});

describe("the incident is the widest it ever got, not the width it is now", () => {
  beforeEach(() => {
    formCohort();
    render(<Card />);
  });

  it("does not let the headline count down under its own remediation", () => {
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });
    restore("N-02");
    restore("N-04");

    // The group really has dropped to two — and the card is not describing the
    // group, it is describing the incident the operator is acting on.
    expect(
      screen.getByRole("heading", { name: "4 units raising the same warning" }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll("[data-slot='cohort-member']")).toHaveLength(4);
  });

  it("still widens when a fifth unit installs the build and says the same words", () => {
    // The queued install landing IS the incident getting bigger, and the card
    // has to be able to say so.
    act(() => {
      useFleetStore.getState().applyUnitUpdate({
        t: "unit_update",
        unit: unit("N-05", SUSPECT, undefined, 79.1),
      });
    });
    raise("N-05", BASE + 10_000);

    expect(
      screen.getByRole("heading", { name: "5 units raising the same warning" }),
    ).toBeInTheDocument();
    // And the canary follows the fleet: one fewer unit left on the baseline.
    expect(
      screen.getByText("All on firmware 2.4.1 — 0 of 3 units on 2.3.7 affected"),
    ).toBeInTheDocument();
  });

  it("steps the queued line aside once the halt has answered for it", () => {
    expect(screen.getByText(/N-05 is scheduled for 2\.4\.1/)).toBeInTheDocument();
    fleetEvent("HALT_ROLLOUT", { k: "accepted" });
    fleetEvent("HALT_ROLLOUT", {
      k: "progress",
      pct: 100,
      note: `ROLLOUT HALTED — N-05 REMAINS ON ${BASELINE}`,
    });
    fleetEvent("HALT_ROLLOUT", { k: "complete" });
    // The receipt states the same fact with the fleet's authority behind it.
    expect(screen.queryByText(/is scheduled for/)).toBeNull();
    expect(
      screen.getByText("Rollout halted — N-05 remains on 2.3.7"),
    ).toBeInTheDocument();
  });
});

/* ---------------------------------------------------------------------------
   the way in to the fleet write-up
--------------------------------------------------------------------------- */

describe("the report reference", () => {
  /**
   * The card's own door onto the fleet incident report. It is a reference
   * rather than a "View report" control for the reason the unit page's incident
   * history gives: the string was going to be on the card anyway, and
   * two objects meaning one document is one too many.
   *
   * Real timers, like "the gate": the document itself is a second
   * `next/dynamic` boundary and this is where it is exercised.
   */
  beforeEach(() => {
    vi.useRealTimers();
    resetIncidentReport();
  });

  afterEach(() => {
    resetIncidentReport();
    document.documentElement.removeAttribute("data-report");
  });

  const reference = () =>
    document.querySelector<HTMLElement>("[data-slot='cohort-report-link']");

  it("prints the incident's reference on the card, and names the fleet", () => {
    formCohort();
    render(<Card />);
    const ref = reference();
    expect(ref).not.toBeNull();
    expect(ref?.textContent).toMatch(/^FLT-241-[0-9A-Z]+$/);
    expect(ref).toHaveAccessibleName(`Open fleet incident report ${ref?.textContent}`);
  });

  it("opens the fleet report, and closes it again on Escape", async () => {
    formCohort();
    fleetEvent("HALT_ROLLOUT", { k: "accepted" });
    fleetEvent("HALT_ROLLOUT", {
      k: "progress",
      pct: 100,
      note: `ROLLOUT HALTED — N-05 REMAINS ON ${BASELINE}`,
    });
    fleetEvent("HALT_ROLLOUT", { k: "complete" });
    render(<Card />);

    fireEvent.click(reference()!);
    await waitFor(() =>
      expect(
        document.querySelector("[data-slot='incident-report'][data-scope='fleet']"),
      ).not.toBeNull(),
    );

    // The document, not a bigger card: it says what happened, including the
    // update that did not.
    expect(
      screen.getByRole("heading", { name: "Fleet incident report" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/N-05 did not take/)).toBeInTheDocument();
    // The page under it is locked and marked for the print stylesheet.
    expect(document.documentElement).toHaveAttribute("data-report", "open");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(document.querySelector("[data-slot='incident-report']")).toBeNull(),
    );
    expect(document.documentElement).not.toHaveAttribute("data-report");
  });

  it("is a door and not a receipt: nothing opens until it is pressed", async () => {
    formCohort();
    render(<Card />);
    await act(async () => {});
    expect(document.querySelector("[data-slot='incident-report']")).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-report");
  });
});

/* ---------------------------------------------------------------------------
   the close-out
--------------------------------------------------------------------------- */

describe("closing the incident", () => {
  /**
   * Through the real gate, not the `Card` harness: the whole point of this beat
   * is what happens to the PAGE — the card leaving it, the record taking its
   * place, the keyboard finding somewhere to stand — and none of that is
   * visible from a harness that mounts the body directly. Real timers, like
   * "the gate", because two `next/dynamic` boundaries are exercised here.
   */
  beforeEach(() => {
    vi.useRealTimers();
    resetIncidentReport();
  });

  afterEach(() => {
    resetIncidentReport();
    document.documentElement.removeAttribute("data-report");
  });

  const record = () => document.querySelector<HTMLElement>("[data-slot='cohort-record']");

  /** Straight to the rollback, no halt — the path the bug was reported on. */
  async function playToSettled() {
    formCohort();
    render(<CohortCard />);
    await waitFor(() => expect(card()).not.toBeNull());
    press("Roll back cohort");
    press("Confirm");
    fleetEvent("ROLLBACK_COHORT", { k: "accepted" });
    for (const id of MEMBERS) restore(id);
    fleetEvent("ROLLBACK_COHORT", { k: "complete" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Resolve incident" }),
      ).toBeInTheDocument(),
    );
  }

  it("takes the card off the page and leaves the record in its place", async () => {
    await playToSettled();
    press("Resolve incident");

    // The card goes — the reveal closes its space and goes inert around the
    // ghost, the same departure a dissolving cohort gets ("the gate"). What is
    // left is one line: the incident does not stop having happened.
    await waitFor(() => expect(record()).not.toBeNull());
    const wrapper = document.querySelector("[data-slot='cohort-reveal']");
    expect(wrapper).toHaveAttribute("inert");
    expect(wrapper).not.toHaveAttribute("data-open");
    expect(record()).toHaveTextContent(
      "4 units raised the same warning on 2.4.1 — incident closed.",
    );
    // And the record is the quiet one: no tint, no pill, nothing to command.
    expect(
      within(record()!).queryByRole("button", { name: /rollout|cohort$/ }),
    ).toBeNull();
  });

  it("records the closure to the session log, under the incident's own id", async () => {
    await playToSettled();
    const cohortId = `cohort-${SUSPECT}-${BASE + 2_000}`;
    press("Resolve incident");
    await waitFor(() => expect(record()).not.toBeNull());

    const entry = useAuditStore
      .getState()
      .entries.find((e) => e.kind === "resolution" && e.ref === cohortId);
    expect(entry).toBeDefined();
    expect(entry!.unitId).toBe("fleet");
    expect(auditLine(entry!)).toBe(
      "Fleet incident closed by operator — 4 units on 2.4.1",
    );
    // A RECORD action: nothing about it went to the fleet.
    expect(sent).toEqual([{ c: "ROLLBACK_COHORT", fw: SUSPECT }]);
  });

  it("puts the finished command lifecycles away with it", async () => {
    await playToSettled();
    press("Resolve incident");
    await waitFor(() => expect(record()).not.toBeNull());
    // Otherwise the next run's card inherits the last run's receipts.
    expect(useCommandStore.getState().fleetCommands).toEqual({});
  });

  it("hands the keyboard to the record rather than dropping it on the body", async () => {
    await playToSettled();
    press("Resolve incident");
    await waitFor(() => expect(record()).not.toBeNull());

    const door = within(record()!).getByRole("button", {
      name: /^Open fleet incident report FLT-/,
    });
    expect(door).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  /**
   * The acceptance that matters most: an operator holding an `FLT-…` reference
   * after the incident is closed must still be able to open the document it
   * names. The derivation forgot the cohort when it dropped below threshold and
   * the card that remembered it is gone — the record is the only thing that
   * still knows the subject.
   */
  it("still opens the write-up by its reference after the card has gone", async () => {
    await playToSettled();
    press("Resolve incident");
    await waitFor(() => expect(record()).not.toBeNull());

    const door = within(record()!).getByRole("button", {
      name: /^Open fleet incident report FLT-/,
    });
    expect(door.textContent).toMatch(/^FLT-241-[0-9A-Z]+$/);
    fireEvent.click(door);

    await waitFor(() =>
      expect(
        document.querySelector("[data-slot='incident-report'][data-scope='fleet']"),
      ).not.toBeNull(),
    );
    expect(
      screen.getByRole("heading", { name: "Fleet incident report" }),
    ).toBeInTheDocument();
    // And it is the same incident, not a smaller one derived from what is left.
    expect(
      screen.getByRole("heading", {
        name: `4 units on firmware ${SUSPECT} raised the same warning.`,
      }),
    ).toBeInTheDocument();
  });

  it("does not take the keyboard when the record was already on file", async () => {
    await playToSettled();
    press("Resolve incident");
    await waitFor(() => expect(record()).not.toBeNull());

    // The operator went to a unit page and came back: same store, fresh mount.
    document.body.innerHTML = "";
    render(<CohortCard />);
    await waitFor(() => expect(record()).not.toBeNull());
    expect(document.activeElement).toBe(document.body);
  });

  /**
   * Non-negotiable #6: the scripted incident is re-runnable. A snapshot is what
   * RESET_SIM sends, and the replayed storyline detects as a NEW instance —
   * which the closed record must not be allowed to suppress.
   */
  it("gives the card back when the storyline runs again", async () => {
    await playToSettled();
    press("Resolve incident");
    await waitFor(() => expect(record()).not.toBeNull());

    // RESET_SIM: a fresh snapshot puts the fleet back on the suspect build and
    // clears the feed and the command lifecycles, then the storyline replays.
    act(() => {
      useFleetStore.getState().applySnapshot(SNAPSHOT);
      useCommandStore.getState().applySnapshot();
    });
    act(() => {
      // New alerts, with the wire's own ids and times — which is what makes the
      // replay a NEW instance rather than the old one restated.
      MEMBERS.forEach((id, i) => {
        useFleetStore.getState().applyAlert({
          t: "alert",
          alert: {
            id: `al-run2-${id}`,
            unitId: id,
            severity: "amber",
            message: SIGNATURE,
            ts: BASE + 100_000 + i * 1_000,
          },
        });
      });
    });

    await waitFor(() => expect(card()).not.toBeNull());
    expect(record()).toBeNull();
    expect(screen.getByRole("button", { name: "Halt rollout" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "4 units raising the same warning" }),
    ).toBeInTheDocument();
  });

  /**
   * The record survives RESET_SIM on purpose — a sim reset does not
   * un-happen the incident the operator just worked, and the session log keeps
   * the closure either way (auditStore.ts). What it must not do is keep a door
   * onto a document that has lost its subject.
   *
   * The write-up used to re-derive from the live stores every time it opened.
   * After a reset those stores describe a different world: the feed is empty, so
   * every raise and clear reads "Not recorded", and every member is back on the
   * suspect build, so the table reads "still on build" and the differential
   * flips from "the cohort was rolled back and every alert cleared with the
   * build" to "Recommended: roll the cohort back" — underneath a chronology
   * still narrating the rollback that happened. Filing takes the evidence now.
   */
  it("opens the same document after a sim reset has moved the world on", async () => {
    await playToSettled();
    press("Resolve incident");
    await waitFor(() => expect(record()).not.toBeNull());

    act(() => {
      useFleetStore.getState().applySnapshot(SNAPSHOT);
      useCommandStore.getState().applySnapshot();
    });

    fireEvent.click(
      within(record()!).getByRole("button", { name: /^Open fleet incident report FLT-/ }),
    );
    const doc = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        "[data-slot='incident-report'][data-scope='fleet']",
      );
      expect(el).not.toBeNull();
      return el!;
    });

    // The fleet came back, and the record still says so.
    expect(doc.querySelector("[data-slot='status-chip']")).toHaveTextContent("Restored");
    expect(
      doc.querySelector("[data-slot='fleet-differential-stance']"),
    ).toHaveTextContent(/^Tested:/);
    const row = doc.querySelector("[data-unit='N-02']")!;
    expect(row).toHaveTextContent(BASELINE);
    expect(row).not.toHaveTextContent("still on build");
    // The member alerts are dated from the archive, not from an emptied feed.
    expect(within(row as HTMLElement).queryByText("Not recorded")).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
   the record line's two moments
--------------------------------------------------------------------------- */

describe("the record line dates what it says it dates", () => {
  const DETECTED = BASE + 2_000;
  const CLOSED = DETECTED + 168_000;
  const FILED = CLOSED + 24_000;

  const RESOLUTION: CohortResolution = {
    cohort: {
      id: `cohort-${SUSPECT}-${DETECTED}`,
      signature: SIGNATURE,
      fw: SUSPECT,
      unitIds: [...MEMBERS],
      alertIds: MEMBERS.map((id) => `al-${id}`),
      detectedAt: DETECTED,
      canary: [
        { fw: SUSPECT, affected: 4, total: 4 },
        { fw: BASELINE, affected: 0, total: 4 },
      ],
    },
    at: FILED,
    closedAt: CLOSED,
    archive: { alerts: [], alertMeta: {}, units: {}, audit: [], fleetSize: 8 },
  };

  /** A labelled figure on the record line, label and value together. */
  const figure = (label: string) =>
    screen.getByText(label).parentElement?.textContent ?? "";

  /**
   * The card printed "closed 13:59:21" off the journals and folded into a
   * record reading "Closed 13:59:45" off the press that filed it — two surfaces
   * disagreeing by seconds about one event. Worse, the span beside it was
   * measured to the first while the label pointed at the second, so Detected +
   * Open for did not reach Closed on the record's own line.
   */
  it("reconciles detected + open for with the moment the fleet closed it", () => {
    render(<CohortRecord record={RESOLUTION} claimFocus={false} />);
    expect(figure("Closed")).toBe(`Closed${clockTime(CLOSED)}`);
    expect(figure("Open for")).toBe(`Open for${formatDuration(CLOSED - DETECTED)}`);
    // The arithmetic the reader can now do on the line itself.
    expect(formatDuration(CLOSED - DETECTED)).toBe("2m 48s");
  });

  /** The press is its own moment, and it is the operator's rather than the fleet's. */
  it("calls the operator's press what it is", () => {
    render(<CohortRecord record={RESOLUTION} claimFocus={false} />);
    expect(figure("Filed")).toBe(`Filed${clockTime(FILED)}`);
    expect(clockTime(FILED)).not.toBe(clockTime(CLOSED));
  });

  /**
   * `cohortClosedAt` returns nothing where no journal dated the closure, and the
   * line prints no closure rather than promoting the filing into one. The span
   * goes with it: it is measured to a moment that is not on file.
   */
  it("prints no closure it cannot cite, and still stamps the filing", () => {
    const { closedAt: _closedAt, ...withoutClosure } = RESOLUTION;
    render(<CohortRecord record={withoutClosure} claimFocus={false} />);
    expect(screen.queryByText("Closed")).toBeNull();
    expect(screen.queryByText("Open for")).toBeNull();
    expect(figure("Filed")).toBe(`Filed${clockTime(FILED)}`);
  });
});
