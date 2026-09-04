import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFleetStore } from "@/lib/stores";
import { UnitCard } from "@/components/console";
import { CohortCard } from "./cohort-card";
import { selectCohortMembers } from "./cohort-membership";
import {
  BASELINE,
  Card,
  card,
  cancelQueuedInstall,
  fleetEvent,
  formCohort,
  installCohortHarness,
  MEMBERS,
  press,
  restore,
  SIGNATURE,
  SUSPECT,
  sent,
} from "./cohort-harness";

/**
 * The card itself: when it exists, what it says, and what it refuses to say.
 *
 * Preamble and hooks: cohort-harness.tsx.
 */

installCohortHarness();

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
