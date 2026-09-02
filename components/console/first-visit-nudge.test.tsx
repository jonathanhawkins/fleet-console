import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Alert, type FleetSnapshotMessage, type UnitSummary } from "@/lib/schema";
import {
  resetCohortDerivation,
  useAuditStore,
  useCommandStore,
  useFleetStore,
} from "@/lib/stores";
import { deriveAlertViews } from "./alert-lifecycle";
import { AlertRail, setAlertFilter } from "./alert-rail";
import { resetCohortMembership } from "./cohort-membership";
import {
  hasVisitedUnit,
  markUnitVisited,
  resetVisitedUnits,
  selectNudgeAlertId,
} from "./first-visit-nudge";

/**
 * the first-visit bias.
 *
 * A first-time viewer opens the console cold, watches the alert land, and
 * then clicks a robot with nothing wrong with it. The nudge is the smallest
 * honest answer: one row wears a mark until the operator has been to the unit
 * it names.
 *
 * The suite is mostly about what the mark must NOT do, because that is where a
 * "look here" affordance goes wrong: it must not survive the visit, must not
 * point at an alert somebody already owns, must not point at a row the feed is
 * simultaneously receding, must not appear twice, and must not argue with the
 * fleet incident card about where the operator should be looking.
 */

const BASE = 1_700_000_000_000;
const NOW = BASE + 30_000;

const SIGNATURE = "Balance reflex latency above threshold";
const SUSPECT = "2.4.1";
const BASELINE = "2.3.7";

function unit(id: string, fw: string): UnitSummary {
  return {
    id,
    name: `${id} House`,
    status: "nominal",
    battery: 80,
    pos: { lat: 44.06, lng: -121.31 },
    fw,
  };
}

/** Four units on the suspect build, so a cohort is reachable when wanted. */
const SNAPSHOT: FleetSnapshotMessage = {
  t: "fleet_snapshot",
  units: [
    unit("N-01", BASELINE),
    unit("N-02", SUSPECT),
    unit("N-03", BASELINE),
    unit("N-04", SUSPECT),
    unit("N-06", SUSPECT),
    unit("N-07", BASELINE),
    unit("N-08", SUSPECT),
  ],
};

function raise(over: Partial<Alert> = {}): Alert {
  const alert: Alert = {
    id: "al-001",
    unitId: "N-07",
    severity: "amber",
    message: "N-07 House: left knee actuator running hot",
    ts: BASE,
    ...over,
  };
  act(() => {
    useFleetStore.getState().applyAlert({ t: "alert", alert });
  });
  return alert;
}

/** Four robots saying the same words on the same build — the fleet incident. */
function formCohort(): void {
  ["N-02", "N-04", "N-06", "N-08"].forEach((id, i) => {
    raise({ id: `al-${id}`, unitId: id, message: SIGNATURE, ts: BASE + i * 1_000 });
  });
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-slot='alert-row']"));
}

function marked(): HTMLElement[] {
  return rows().filter((row) => row.dataset.nudge === "true");
}

/** The one row wearing the mark, by unit id — the assertion most cases want. */
function markedUnit(): string | undefined {
  return marked()[0]?.querySelector("[class*='tnum']")?.textContent ?? undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setAlertFilter("open");
  resetVisitedUnits();
  useFleetStore.getState().reset();
  useCommandStore.getState().reset();
  useAuditStore.getState().reset();
  resetCohortDerivation();
  resetCohortMembership();
  useFleetStore.getState().applySnapshot(SNAPSHOT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("first-visit nudge — who wears the mark", () => {
  it("marks the newest live alert on a unit the operator has not opened", () => {
    raise({ id: "al-001" });
    render(<AlertRail />);

    expect(marked()).toHaveLength(1);
    expect(markedUnit()).toBe("N-07");
  });

  it("marks exactly one row, however many alerts are standing", () => {
    // Three different faults, not three restatements of one: identical messages
    // across three units IS a cohort (COHORT_THRESHOLD is 3), and the fleet
    // incident suppresses the mark entirely — asserted in its own case below.
    raise({ id: "al-001", unitId: "N-07", message: "left knee running hot", ts: BASE });
    raise({ id: "al-002", unitId: "N-03", message: "gripper slip", ts: BASE + 1_000 });
    raise({ id: "al-003", unitId: "N-01", message: "battery low", ts: BASE + 2_000 });
    render(<AlertRail />);

    expect(rows()).toHaveLength(3);
    expect(marked()).toHaveLength(1);
    // Newest first, so the newest qualifying row is the top one.
    expect(markedUnit()).toBe("N-01");
  });

  it("falls through to the next unvisited unit when the newest is already seen", () => {
    raise({ id: "al-001", unitId: "N-07", message: "left knee running hot", ts: BASE });
    raise({ id: "al-002", unitId: "N-03", message: "gripper slip", ts: BASE + 1_000 });
    markUnitVisited("N-03");
    render(<AlertRail />);

    // The mark walks down the feed as the operator works rather than switching
    // off at the top: N-03 is dealt with, N-07 has still never been opened.
    expect(marked()).toHaveLength(1);
    expect(markedUnit()).toBe("N-07");
  });

  it("says nothing at all once every alerting unit has been visited", () => {
    raise({ id: "al-001", unitId: "N-07" });
    markUnitVisited("N-07");
    render(<AlertRail />);

    expect(rows()).toHaveLength(1);
    expect(marked()).toHaveLength(0);
  });
});

describe("first-visit nudge — clearing", () => {
  it("clears the moment the unit is visited, with the feed still mounted", () => {
    raise({ id: "al-001", unitId: "N-07" });
    render(<AlertRail />);
    expect(marked()).toHaveLength(1);

    // What /unit/[id] does on mount. The feed is subscribed to the set, so the
    // mark leaves in the same commit rather than on the next store tick.
    act(() => {
      markUnitVisited("N-07");
    });

    expect(marked()).toHaveLength(0);
    expect(hasVisitedUnit("N-07")).toBe(true);
  });

  it("stays cleared when the same unit raises again — the visit is not spent", () => {
    raise({ id: "al-001", unitId: "N-07", ts: BASE });
    render(<AlertRail />);
    act(() => {
      markUnitVisited("N-07");
    });

    raise({ id: "al-002", unitId: "N-07", severity: "red", ts: BASE + 5_000 });

    expect(rows()).toHaveLength(2);
    expect(marked()).toHaveLength(0);
  });

  it("does not clear a different unit's mark", () => {
    raise({ id: "al-001", unitId: "N-07" });
    render(<AlertRail />);

    act(() => {
      markUnitVisited("N-03");
    });

    expect(markedUnit()).toBe("N-07");
  });
});

describe("first-visit nudge — what it refuses to point at", () => {
  it("drops the mark the moment somebody acknowledges the alert", () => {
    raise({ id: "al-001", unitId: "N-07" });
    render(<AlertRail />);
    expect(marked()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Acknowledge alert on N-07/ }));

    // Ownership is not closure — the row stays in the working view — but
    // telling an operator to go and look at the thing they just claimed is the
    // console not listening.
    expect(rows()[0]).toHaveAttribute("data-lifecycle", "acked");
    expect(marked()).toHaveLength(0);
  });

  it("never marks a resolved alert, even with the feed showing All", () => {
    raise({ id: "al-001", unitId: "N-07" });
    render(<AlertRail />);

    act(() => {
      useFleetStore.getState().resolveAlert("al-001", { via: "incident", ref: "inc-1" });
    });
    act(() => {
      setAlertFilter("all");
    });

    expect(rows()).toHaveLength(1);
    expect(marked()).toHaveLength(0);
  });

  it("marks the red and not the amber it took over", () => {
    raise({ id: "al-001", unitId: "N-07", ts: BASE });
    raise({
      id: "al-002",
      unitId: "N-07",
      severity: "red",
      message: "N-07 House: left knee actuator overheating",
      ts: BASE + 5_000,
    });
    render(<AlertRail />);

    const [red, amber] = rows();
    // A superseded amber is a row the feed is already receding; marking it
    // would be the same surface saying "settled" and "start here" at once.
    expect(amber).toHaveAttribute("data-escalated", "true");
    expect(amber).not.toHaveAttribute("data-nudge");
    expect(red).toHaveAttribute("data-nudge", "true");
  });

  it("holds its peace while a fleet incident is on the page", () => {
    formCohort();
    render(<AlertRail />);

    // Four rows, all live, all on units nobody has opened — and no mark. The
    // cohort card above the feed has already changed the subject of the page.
    expect(rows()).toHaveLength(4);
    expect(marked()).toHaveLength(0);
  });

  it("comes back if the incident clears with an alert still standing", () => {
    formCohort();
    render(<AlertRail />);
    expect(marked()).toHaveLength(0);

    // The rollback restores three of the four; the derivation drops below
    // threshold and the card's subject goes with it.
    act(() => {
      for (const id of ["N-02", "N-04", "N-06"]) {
        useFleetStore.getState().resolveAlert(`al-${id}`, { via: "rollback" });
      }
    });

    expect(marked()).toHaveLength(1);
    expect(markedUnit()).toBe("N-08");
  });
});

describe("first-visit nudge — how it reads", () => {
  it("is drawn in the alert's own severity colour, on the row's leading edge", () => {
    raise({ id: "al-001", unitId: "N-07", severity: "red", message: "overheating" });
    render(<AlertRail />);

    // The same 3px inset geometry UnitCard uses for the cohort mark — an inset
    // shadow, so a marked row and an unmarked one measure identically.
    expect(marked()[0]).toHaveClass("shadow-[inset_3px_0_0_var(--alert)]");
  });

  it("uses the warn tone for an amber", () => {
    raise({ id: "al-001", unitId: "N-07", severity: "amber" });
    render(<AlertRail />);
    expect(marked()[0]).toHaveClass("shadow-[inset_3px_0_0_var(--warn)]");
  });

  it("adds nothing to the row's accessible name — it is emphasis, not a fact", () => {
    raise({ id: "al-001", unitId: "N-07" });
    render(<AlertRail />);

    const link = screen.getByRole("link");
    expect(link).toHaveAccessibleName(/left knee actuator running hot/);
    expect(link).not.toHaveAccessibleName(/nudge|start here|unvisited/i);
    // And the route is untouched: the mark never becomes a second control.
    expect(link).toHaveAttribute("href", "/unit/N-07");
    expect(screen.queryByRole("link", { name: /view unit/i })).not.toBeInTheDocument();
  });
});

describe("selectNudgeAlertId", () => {
  const views = (alerts: Alert[], meta = {}) => deriveAlertViews(alerts, meta);

  function alert(over: Partial<Alert> = {}): Alert {
    return {
      id: "a",
      unitId: "N-07",
      severity: "amber",
      message: "hot",
      ts: BASE,
      ...over,
    };
  }

  it("returns null on an empty feed", () => {
    expect(selectNudgeAlertId([], new Set())).toBeNull();
  });

  it("takes the first qualifying view, since the feed arrives newest first", () => {
    const list = views([
      alert({ id: "new", unitId: "N-03", ts: BASE + 1_000 }),
      alert({ id: "old", unitId: "N-07", ts: BASE }),
    ]);
    expect(selectNudgeAlertId(list, new Set())).toBe("new");
    expect(selectNudgeAlertId(list, new Set(["N-03"]))).toBe("old");
    expect(selectNudgeAlertId(list, new Set(["N-03", "N-07"]))).toBeNull();
  });

  it("skips an acked alert and keeps looking", () => {
    const list = views(
      [
        alert({ id: "taken", unitId: "N-03", ts: BASE + 1_000 }),
        alert({ id: "free", unitId: "N-07", ts: BASE }),
      ],
      { taken: { ackedAt: NOW, ackedBy: "Operator" } },
    );
    expect(selectNudgeAlertId(list, new Set())).toBe("free");
  });
});
