import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLEET_AUDIT_SCOPE,
  useAuditStore,
  useFleetStore,
  type AlertMeta,
  type AuditEntry,
  type CohortIncident,
} from "@/lib/stores";
import { clockTime } from "./alert-lifecycle";
import { cohortRef } from "./cohort-copy";
import {
  CohortReportSurface,
  confirmedFleetSignal,
  fleetDifferentialStance,
} from "./cohort-report-surface";

/**
 * The fleet write-up.
 *
 * Same two load-bearing properties as the unit report's spec — it invents
 * nothing, and it says the same numbers the card says — plus the one this
 * document adds: the section that matters most is about an event that did not
 * happen, so it must rest on the halt's receipt and refuse to reason its way to
 * a save without one.
 *
 * Presence rather than visibility throughout: the document sits inside a motion
 * surface whose opening frame is `opacity: 0` and jsdom runs no frames.
 */

const DETECTED = new Date("2026-08-24T18:03:00.000Z").getTime();
const HALTED = DETECTED + 22_000;
const ORDERED = DETECTED + 40_000;
const FW = "2.4.1";
const STABLE = "2.3.7";
const MEMBERS = ["N-02", "N-04", "N-06", "N-08"];
const SIGNATURE = "Balance reflex latency above threshold";

const cohort: CohortIncident = {
  id: `cohort-${FW}-${DETECTED}`,
  signature: SIGNATURE,
  fw: FW,
  unitIds: [...MEMBERS],
  alertIds: MEMBERS.map((_, i) => `al-${i + 1}`),
  detectedAt: DETECTED,
  canary: [
    { fw: FW, affected: 4, total: 4 },
    { fw: STABLE, affected: 0, total: 4 },
  ],
};

const onClose = vi.fn();

/** The whole roster: four members on the suspect build, four on the baseline. */
function seedFleet(memberFw: string) {
  useFleetStore.getState().applySnapshot({
    t: "fleet_snapshot",
    units: [...MEMBERS, "N-01", "N-03", "N-05", "N-07"].map((id, i) => ({
      id,
      name: `${id} House`,
      status: "nominal" as const,
      battery: 70,
      pos: { lat: 44 + i / 100, lng: -121 },
      fw: MEMBERS.includes(id) ? memberFw : STABLE,
    })),
  });
  for (const [i, unitId] of MEMBERS.entries()) {
    useFleetStore.getState().applyAlert({
      t: "alert",
      alert: {
        id: `al-${i + 1}`,
        unitId,
        severity: "amber",
        message: SIGNATURE,
        ts: DETECTED - 20_000 + i * 10_000,
      },
    });
  }
}

/** Every member cleared by the staged rollback, 4 s apart in roster order. */
function seedResolutions() {
  useFleetStore.setState((s) => {
    const alertMeta: Record<string, AlertMeta> = { ...s.alertMeta };
    for (const [i] of MEMBERS.entries()) {
      alertMeta[`al-${i + 1}`] = {
        resolvedAt: ORDERED + (i + 1) * 4_000,
        resolution: { via: "rollback" },
      };
    }
    return { alertMeta };
  });
}

const fleetEntry = (
  ts: number,
  kind: AuditEntry["kind"],
  summary: string,
  ref?: string,
): Omit<AuditEntry, "id"> => ({ ts, kind, unitId: FLEET_AUDIT_SCOPE, summary, ref });

function seedLog(extra: Array<Omit<AuditEntry, "id">> = []) {
  const audit = useAuditStore.getState();
  const entries = [
    fleetEntry(
      DETECTED,
      "cohort-detected",
      `Cohort detected — 4 units on ${FW}`,
      cohort.id,
    ),
    fleetEntry(
      HALTED,
      "rollout-halted",
      `ROLLOUT HALTED — N-05 REMAINS ON ${STABLE}`,
      "HALT_ROLLOUT#2",
    ),
    fleetEntry(
      ORDERED,
      "rollback-started",
      `Staged rollback of ${FW} started`,
      "ROLLBACK_COHORT#3",
    ),
    fleetEntry(
      ORDERED + 16_000,
      "rollback-complete",
      `Staged rollback of ${FW} complete`,
      "ROLLBACK_COHORT#4",
    ),
    ...extra,
  ];
  for (const entry of entries) audit.append(entry);
}

/** The whole storyline, played out: halted, rolled back, every unit restored. */
function seedSettled() {
  seedFleet(STABLE);
  seedResolutions();
  seedLog();
}

const renderReport = () =>
  render(<CohortReportSurface cohort={cohort} onClose={onClose} />);

/** The differential's closing line, whichever of the three it is. */
const stance = () =>
  document.querySelector<HTMLElement>("[data-slot='fleet-differential-stance']");

beforeEach(() => {
  onClose.mockClear();
  useFleetStore.getState().reset();
  useAuditStore.getState().reset();
});

describe("the header", () => {
  it("is a document about a build, with its own reference", () => {
    seedSettled();
    renderReport();
    expect(
      screen.getByRole("heading", { name: "Fleet incident report" }),
    ).toBeInTheDocument();
    expect(screen.getByText(cohortRef(FW, DETECTED))).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Fleet incident report" }).parentElement,
    ).toHaveTextContent(`Firmware ${FW} · 4 units`);
  });

  /**
   * "Restored", not "Resolved". A rollback puts the robots back on the build
   * they were on; it does not explain the one they came off, and the nearest
   * word would claim it did.
   */
  it("says the fleet was restored rather than that the incident was explained", () => {
    seedSettled();
    const { container } = renderReport();
    expect(container.querySelector("[data-slot='status-chip']")).toHaveTextContent(
      "Restored",
    );
  });

  it("stands open while any member is still on the suspect build", () => {
    seedFleet(FW);
    seedLog();
    const { container } = renderReport();
    expect(container.querySelector("[data-slot='status-chip']")).toHaveTextContent(
      "Open",
    );
  });

  /** The ladder's whole point: four robots restored without a van moving. */
  it("says how far up the recovery ladder the fleet had to climb", () => {
    seedSettled();
    renderReport();
    expect(screen.getByText(/Escalated to:/)).toHaveTextContent(
      "Escalated to: remote operations",
    );
  });
});

describe("the times", () => {
  it("dates every beat of the fleet incident", () => {
    seedSettled();
    const { container } = renderReport();
    const at = (key: string) =>
      container.querySelector(`[data-moment='${key}']`)?.textContent ?? "";
    expect(at("detected")).toContain(clockTime(DETECTED));
    expect(at("halted")).toContain(clockTime(HALTED));
    expect(at("ordered")).toContain(clockTime(ORDERED));
    expect(at("first")).toContain(clockTime(ORDERED + 4_000));
    expect(at("last")).toContain(clockTime(ORDERED + 16_000));
  });

  it("prints a dash where a journal is silent rather than inventing a time", () => {
    seedFleet(FW);
    const { container } = renderReport();
    const halted = container.querySelector("[data-moment='halted']");
    expect(halted).toHaveTextContent("—");
    expect(within(halted as HTMLElement).getByText("Not recorded")).toBeInTheDocument();
    // Detection is the one moment every cohort has.
    expect(container.querySelector("[data-moment='detected']")).toHaveTextContent(
      clockTime(DETECTED),
    );
  });

  /**
   * Deliberately not MTTA/MTTR: those name a unit's incident. The fleet's
   * questions are how long the blast radius could still grow and how long until
   * every robot was back.
   */
  it("measures containment and restoration, in the fleet's own terms", () => {
    seedSettled();
    const { container } = renderReport();
    const figure = (label: string) =>
      container.querySelector(`[data-figure='${label}']`)?.textContent ?? "";
    expect(figure("Time to contain")).toContain("22s");
    expect(figure("Time to contain")).toContain("detected → halted");
    expect(figure("Rollback duration")).toContain("16s");
    expect(figure("Time to restore")).toContain("56s");
    expect(container.textContent).not.toContain("MTTA");
  });
});

describe("the finding and its canary", () => {
  it("quotes the signature verbatim and says whose words it is", () => {
    seedSettled();
    renderReport();
    expect(screen.getByText(SIGNATURE)).toBeInTheDocument();
    expect(screen.getByText("Reported by 4 units, byte-identical")).toBeInTheDocument();
  });

  it("tables the comparison the rollback was justified by, and marks the suspect", () => {
    seedSettled();
    const { container } = renderReport();
    const suspect = container.querySelector(`[data-canary='${FW}']`);
    expect(within(suspect as HTMLElement).getByText("suspect")).toBeInTheDocument();
    expect(suspect).toHaveTextContent("4");
    const clean = container.querySelector(`[data-canary='${STABLE}']`);
    expect(clean).toHaveTextContent("0");
    expect(container.querySelectorAll("[data-canary]")).toHaveLength(2);
  });

  it("says the comparison in the same sentence the card says it in", () => {
    seedSettled();
    renderReport();
    expect(
      screen.getByText(`All on firmware ${FW} — 0 of 4 units on ${STABLE} affected`),
    ).toBeInTheDocument();
  });
});

describe("the differential", () => {
  /**
   * Four robots saying identical words on identical firmware is strong evidence
   * about a build and it is not proof. The document says what else it is
   * consistent with, and what order to spend money in.
   */
  it("states the confirmed signal, the candidates, and the cheapest first", () => {
    // Still open: every member is on the suspect build and nobody has acted.
    seedFleet(FW);
    renderReport();
    expect(
      screen.getByText(
        `4 of 4 units on ${FW} affected, none of the 4 units on other builds.`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Consistent with:/)).toHaveTextContent(
      "independent faults of the same kind",
    );
    expect(stance()).toHaveTextContent(
      "Recommended: roll the cohort back before dispatching anyone.",
    );
  });

  /**
   * A report whose status chip reads RESTORED and whose table shows
   * every unit off the build has no business still issuing the instruction it
   * has already recorded as carried out. What replaces it is the result of the
   * test, in the same epistemics as the rest of the document: consistent with,
   * never proof of.
   */
  it("reports the result rather than the instruction once the incident is closed", () => {
    seedSettled();
    renderReport();
    expect(screen.queryByText(/Recommended:/)).not.toBeInTheDocument();
    expect(stance()).toHaveTextContent(
      `Tested: the cohort was rolled back and every alert cleared with the build. That is what a regression in ${FW} predicts; it does not rule the other two out.`,
    );
    // The candidates themselves survive the closure — the document did not
    // decide the question, it recorded what one experiment returned.
    expect(screen.getByText(/Consistent with:/)).toHaveTextContent(
      "a change these units share off-build",
    );
  });

  /** Restored with nothing on file that would have restored them. */
  it("declines to claim a test that was never run", () => {
    seedFleet(STABLE);
    seedResolutions();
    renderReport();
    expect(stance()).toHaveTextContent(
      `Untested: the affected units came off ${FW} with no rollback on file`,
    );
  });

  /** A fleet running one build has nothing to discriminate with, and says so. */
  it("renders no differential where there is nothing to compare against", () => {
    seedSettled();
    render(
      <CohortReportSurface
        cohort={{ ...cohort, canary: [{ fw: FW, affected: 4, total: 8 }] }}
        onClose={onClose}
      />,
    );
    expect(screen.queryByText(/Consistent with:/)).not.toBeInTheDocument();
  });
});

describe("fleetDifferentialStance", () => {
  it("issues the instruction only while the incident is open", () => {
    expect(fleetDifferentialStance(false, false, FW).label).toBe("Recommended");
    // A rollback ordered but not finished is still an open incident: the units
    // are on the build, and the operator still has the decision in front of them.
    expect(fleetDifferentialStance(false, true, FW).label).toBe("Recommended");
  });

  it("names the two closed endings apart", () => {
    expect(fleetDifferentialStance(true, true, FW).label).toBe("Tested");
    expect(fleetDifferentialStance(true, false, FW).label).toBe("Untested");
  });
});

describe("confirmedFleetSignal", () => {
  it("is derived from the canary, so it cannot drift from the table beside it", () => {
    expect(confirmedFleetSignal(cohort)).toBe(
      `4 of 4 units on ${FW} affected, none of the 4 units on other builds.`,
    );
  });

  it("does not assert a comparison it does not have", () => {
    expect(confirmedFleetSignal({ ...cohort, canary: [] })).toMatch(/not on file/);
  });
});

describe("the affected units", () => {
  it("puts each member's firmware before against its firmware after", () => {
    seedSettled();
    const { container } = renderReport();
    const row = container.querySelector("[data-unit='N-02']");
    expect(row).toHaveTextContent(FW);
    expect(row).toHaveTextContent(STABLE);
    expect(within(row as HTMLElement).getByText("restored to")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-unit]")).toHaveLength(4);
  });

  it("dates each member's raise and clear, and how long it stood", () => {
    seedSettled();
    const { container } = renderReport();
    const row = container.querySelector("[data-unit='N-02']");
    expect(row).toHaveTextContent(clockTime(DETECTED - 20_000));
    expect(row).toHaveTextContent(clockTime(ORDERED + 4_000));
    expect(row).toHaveTextContent("1m 04s");
  });

  it("says plainly which members are still on the suspect build", () => {
    seedFleet(FW);
    seedLog();
    const { container } = renderReport();
    const row = container.querySelector("[data-unit='N-02']");
    expect(within(row as HTMLElement).getByText("still on build")).toBeInTheDocument();
  });

  /**
   * The row has three cells that can be empty, and the third one was
   * printing a bare `aria-hidden` em-dash: a listener heard "Not recorded, Not
   * recorded" and then nothing at all, exactly where a reader's eye finds a
   * third gap. The pattern is one component now (report-surface.tsx), which is
   * the file that exists to stop this drift.
   */
  it("says a missing span out loud, like the two gaps beside it", () => {
    // Raised but never cleared: no closure, and therefore no span either.
    seedFleet(FW);
    seedLog();
    const { container } = renderReport();
    const row = container.querySelector("[data-unit='N-02']") as HTMLElement;
    const cells = [...row.querySelectorAll("td")];
    const openFor = cells[cells.length - 1] as HTMLElement;
    expect(openFor).toHaveTextContent("—");
    expect(within(openFor).getByText("Not recorded")).toBeInTheDocument();
    // Cleared and Open for: one sentence each, not one between them.
    expect(within(row).getAllByText("Not recorded")).toHaveLength(2);
  });
});

describe("the staged rollback", () => {
  it("shows the serial walk and the cadence that makes it serial", () => {
    seedSettled();
    const { container } = renderReport();
    const steps = [...container.querySelectorAll("[data-step]")];
    expect(steps.map((s) => s.getAttribute("data-step"))).toEqual(MEMBERS);
    expect(steps[0]).toHaveTextContent(`restored ${clockTime(ORDERED + 4_000)}`);
    expect(steps[0]).toHaveTextContent("+4s");
    expect(steps[3]).toHaveTextContent("+16s");
  });

  it("says the fleet declared it finished, and when", () => {
    seedSettled();
    renderReport();
    expect(screen.getByText(/staged rollback complete at/)).toHaveTextContent(
      clockTime(ORDERED + 16_000),
    );
  });

  it("claims no rollback where none was ordered", () => {
    seedFleet(FW);
    const { container } = renderReport();
    expect(screen.getByText(`No rollback was ordered for ${FW}.`)).toBeInTheDocument();
    expect(container.querySelectorAll("[data-step]")).toHaveLength(0);
  });
});

describe("the save", () => {
  /**
   * The emotional payload of the whole storyline, and the one figure with no
   * journal behind it. It rests on the halt's receipt, quoted, and on nothing
   * else — see `preventedUpdates`.
   */
  it("names the unit that never took the build, off the machine's own receipt", () => {
    seedSettled();
    const { container } = renderReport();
    expect(screen.getByText(`N-05 did not take`, { exact: false })).toHaveTextContent(
      `N-05 did not take ${FW}.`,
    );
    expect(container.querySelector("[data-prevented='N-05']")).toHaveTextContent(
      `ROLLOUT HALTED — N-05 REMAINS ON ${STABLE}`,
    );
    expect(screen.getByText(/Recorded by the rollout program/)).toHaveTextContent(
      clockTime(HALTED),
    );
  });

  it("counts the cost beside the non-cost", () => {
    seedSettled();
    const { container } = renderReport();
    const figure = (label: string) =>
      container.querySelector(`[data-figure='${label}']`)?.textContent ?? "";
    expect(figure("Units rolled back")).toContain("4");
    expect(figure("Updates prevented")).toContain("1");
    expect(figure("Halted after detection")).toContain("22s");
  });

  it("claims no save where no halt was ordered", () => {
    seedFleet(FW);
    renderReport();
    expect(
      screen.getByText("No update was prevented — no halt was ordered on this incident."),
    ).toBeInTheDocument();
  });

  /**
   * The storyline's other ending: the operator who reached for HALT after the
   * install had already landed is owed the same page, with the refusal in the
   * fleet's own words and what to do about it underneath.
   */
  it("carries a refused halt verbatim, and says what it means", () => {
    seedFleet(FW);
    useAuditStore
      .getState()
      .append(
        fleetEntry(
          HALTED,
          "command-failed",
          "HALT ROLLOUT failed: NO ROLLOUT ACTIVE",
          "HALT_ROLLOUT#2",
        ),
      );
    renderReport();
    expect(screen.getByText(/Halt refused/)).toHaveTextContent("NO ROLLOUT ACTIVE");
    expect(screen.getByText(/Nothing left to halt/)).toBeInTheDocument();
  });
});

describe("the actions", () => {
  it("rows both interventions with the rung each one sits on", () => {
    seedSettled();
    const { container } = renderReport();
    const halt = container.querySelector("[data-action='Halt rollout']");
    expect(halt).toHaveTextContent(`complete — N-05 remains on ${STABLE}`);
    expect(halt).toHaveTextContent("remote operations");
    const rollback = container.querySelector("[data-action='Roll back cohort']");
    expect(rollback).toHaveTextContent(`complete — every unit off ${FW}`);
    expect(rollback).toHaveTextContent("remote operations");
  });

  it("says what staying on that rung was worth", () => {
    seedSettled();
    renderReport();
    expect(
      screen.getByText(/Every intervention on this incident ran over the link/),
    ).toBeInTheDocument();
  });

  it("says nothing happened, where nothing happened", () => {
    seedFleet(FW);
    renderReport();
    expect(
      screen.getByText("No fleet-scale action was recorded on this incident."),
    ).toBeInTheDocument();
  });
});

describe("the chronology", () => {
  it("is the fleet's log for this incident's window, not the whole shift", () => {
    seedSettled();
    useAuditStore
      .getState()
      .append(
        fleetEntry(
          DETECTED - 3_600_000,
          "rollout-halted",
          "ROLLOUT HALTED — N-09 REMAINS ON 2.3.7",
          "HALT_ROLLOUT#1",
        ),
      );
    renderReport();
    expect(screen.queryByText(/N-09/)).not.toBeInTheDocument();
    expect(screen.getByText(/Staged rollback of 2.4.1 started/)).toBeInTheDocument();
  });

  it("leaves a unit's own log to that unit's report", () => {
    seedSettled();
    useAuditStore.getState().append({
      ts: ORDERED + 1_000,
      kind: "alert-raised",
      unitId: "N-07",
      summary: "Sagebrush House: left knee actuator running hot",
      ref: "al-knee",
    });
    renderReport();
    expect(screen.queryByText(/left knee actuator/)).not.toBeInTheDocument();
  });
});

describe("the document's frame", () => {
  it("says what it is and when it was made", () => {
    seedSettled();
    renderReport();
    expect(
      screen.getByText("Simulated data · generated by Fleet Console"),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Generated \d{2}:\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  /** The same surface as the unit's, so the print rule finds it with one selector. */
  it("is a modal document under the print stylesheet's own hook, and Escape leaves it", () => {
    seedSettled();
    const { container } = renderReport();
    const root = container.querySelector("[data-slot='incident-report']");
    expect(root).toHaveAttribute("role", "dialog");
    expect(root).toHaveAttribute("aria-modal", "true");
    expect(root).toHaveAttribute("data-scope", "fleet");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes focus on arrival and gives it back on the way out", () => {
    seedSettled();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const { container, unmount } = renderReport();
    expect(document.activeElement).toBe(
      container.querySelector("[data-slot='incident-report']"),
    );

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps the console's own controls off the printed page", () => {
    seedSettled();
    renderReport();
    expect(screen.getByRole("button", { name: "Close incident report" }).className).toContain(
      "print:hidden",
    );
  });
});
