import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAuditStore,
  useCommandStore,
  useFleetStore,
  type CohortResolution,
} from "@/lib/stores";
import { clockTime, formatDuration } from "./alert-lifecycle";
import { AlertRail } from "./alert-rail";
import { auditLine } from "./audit-line";
import { CohortCard } from "./cohort-card";
import { CohortRecord } from "./cohort-incident";
import { resetIncidentReport } from "./incident-report";
import {
  BASE,
  BASELINE,
  Card,
  card,
  fleetEvent,
  formCohort,
  installCohortHarness,
  MEMBERS,
  press,
  raise,
  restore,
  SIGNATURE,
  SNAPSHOT,
  SUSPECT,
  sent,
  unit,
} from "./cohort-harness";

/**
 * What the incident leaves behind: the feed's grouping, the session log's English,
 * the width it reached, its reference, and how it closes.
 *
 * Preamble and hooks: cohort-harness.tsx.
 */

installCohortHarness();

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
