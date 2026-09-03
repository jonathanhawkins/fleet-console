import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FleetSnapshotMessage,
  type TelemetryMessage,
  type UnitStatus,
} from "@/lib/schema";
import { resetTrendWatchForTests, useFleetStore } from "@/lib/stores";
import { UNIT_CARD_HEIGHT, type UnitCardProps } from "@/components/console";

interface UnitCardModule {
  UnitCard: (props: UnitCardProps) => React.ReactElement;
  UNIT_CARD_HEIGHT: number;
}

/**
 * The rail's two contracts.
 *
 * The visible one: eight homes in snapshot order — or, filtered and ordered
 * at the operator's choice (fleet-rail-controls.tsx) — keyboard-traversable,
 * each row a link to its unit.
 *
 * The invisible one, and the reason this file exists: **a row must not
 * re-render when another unit's telemetry arrives.** lib/stores proves the
 * selectors are `Object.is`-stable; this proves the DOM actually spends that
 * stability, because it is trivially easy to lose it later by hoisting a
 * selector into the parent or wrapping a row in something that memoises on the
 * wrong thing. The counter below is the tripwire.
 */

const renders = new Map<string, number>();

// The row is a console primitive, reached through the barrel; the mock is
// keyed to the module itself so the barrel's re-export resolves to it.
vi.mock("@/components/console/unit-card", async () => {
  const actual = (await vi.importActual(
    "@/components/console/unit-card",
  )) as UnitCardModule;
  return {
    ...actual,
    UnitCard: (props: UnitCardProps) => {
      renders.set(props.unitId, (renders.get(props.unitId) ?? 0) + 1);
      return actual.UnitCard(props);
    },
  };
});

const { FleetRail, MAX_VISIBLE_ROWS, MIN_VISIBLE_ROWS, railScrollportHeight } =
  await import("./fleet-rail");
const { FleetRailFilterField, FleetRailOrderToggle, setRailFilter, setRailOrder } =
  await import("./fleet-rail-controls");

const UNITS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "N-01", name: "Cedar Row" },
  { id: "N-02", name: "Maple Hollow" },
  { id: "N-03", name: "Mill Street" },
];

/**
 * One of each attention-first tier, plus a second red to prove the tiebreak:
 * roster order is N-01 (red) N-02 (amber) N-03 (nominal, made to trend by the
 * test) N-04 (plain nominal) N-05 (red) — so attention-first must read
 * N-01, N-05, N-02, N-03, N-04, with the two reds kept in roster order.
 */
const ATTENTION_UNITS: ReadonlyArray<{ id: string; name: string; status: UnitStatus }> = [
  { id: "N-01", name: "Cedar Row", status: "red" },
  { id: "N-02", name: "Maple Hollow", status: "amber" },
  { id: "N-03", name: "Mill Street", status: "nominal" },
  { id: "N-04", name: "Alder Court", status: "nominal" },
  { id: "N-05", name: "Birch Landing", status: "red" },
];

function attentionSnapshot(): FleetSnapshotMessage {
  return {
    t: "fleet_snapshot",
    units: ATTENTION_UNITS.map((u, i) => ({
      id: u.id,
      name: u.name,
      status: u.status,
      battery: 80 - i,
      pos: { lat: 44 + i / 100, lng: -121 - i / 100 },
    })),
  };
}

function snapshot(statuses: Partial<Record<string, UnitStatus>> = {}) {
  const msg: FleetSnapshotMessage = {
    t: "fleet_snapshot",
    units: UNITS.map((u, i) => ({
      id: u.id,
      name: u.name,
      status: statuses[u.id] ?? "nominal",
      battery: 80 - i,
      pos: { lat: 44 + i / 100, lng: -121 - i / 100 },
    })),
  };
  return msg;
}

function telemetry(unitId: string, battery: number): TelemetryMessage {
  return {
    t: "telemetry",
    unitId,
    ts: Date.now(),
    batch: [{ joint: "knee_L", tempC: 40, torqueNm: 1, currentA: 2, battery }],
  };
}

beforeAll(() => {
  // jsdom scaffolding for @tanstack/react-virtual: it sizes its viewport from
  // the scroll element's `offsetHeight` and watches it with a ResizeObserver,
  // and jsdom has neither a layout engine nor that API. Without both, the
  // virtual window is zero rows tall and the rail renders nothing.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 320,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => UNIT_CARD_HEIGHT * 8,
  });
});

// Reset before, not after: an `afterEach` here runs *before* the setup file's
// RTL cleanup, so it would commit a store change into a still-mounted tree and
// earn an "update not wrapped in act" warning for the previous test.
/**
 * `seconds` of 10 Hz batches ending at "now", with `ramps` giving a joint's
 * climb in °C/min — enough evidence for the thermal trend watch to fit against
 * (helper lifted from lib/stores/trendWatch.test.ts, which proves the fit).
 */
function feed(unitId: string, seconds: number, ramps: Record<string, number> = {}): void {
  const startTs = Date.now() - seconds * 1000;
  for (let i = 0; i < seconds * 10; i += 1) {
    const minutes = (i * 100) / 60_000;
    useFleetStore.getState().applyTelemetry({
      t: "telemetry",
      unitId,
      ts: startTs + i * 100,
      batch: [
        {
          joint: "knee_L",
          tempC: 33 + (ramps["knee_L"] ?? 0) * minutes,
          torqueNm: 12,
          currentA: 1.5,
          battery: 80,
        },
      ],
    });
  }
}

beforeEach(() => {
  useFleetStore.getState().reset();
  // Module state, like the store's — the latch and the memo outlive a reset.
  resetTrendWatchForTests();
  renders.clear();
  // Filter and order are module state too (fleet-rail-controls.tsx), same
  // reasoning as the alert feed's own filter: an operator preference, not sim
  // state, so it outlives a reset and has to be pinned back to its default
  // here instead.
  setRailFilter("");
  setRailOrder("roster");
});

describe("FleetRail", () => {
  it("says what the region is for rather than claiming the fleet is empty", () => {
    render(<FleetRail />);
    expect(screen.getByText("Units appear here as the fleet reports in.")).toBeVisible();
  });

  it("renders every unit in snapshot order, as a link to its drill-in route", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetRail />);

    const rows = screen.getAllByRole("link");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute("href"))).toEqual([
      "/unit/N-01",
      "/unit/N-02",
      "/unit/N-03",
    ]);
    expect(within(rows[0]!).getByText("Cedar Row")).toBeInTheDocument();
  });

  it("gives a screen reader one sentence carrying everything the row shows", () => {
    useFleetStore.getState().applySnapshot(snapshot({ "N-01": "amber" }));
    render(<FleetRail />);
    // no telemetry yet, so there is no last-contact clause to state
    expect(screen.getAllByRole("link")[0]).toHaveAccessibleName(
      "N-01, Cedar Row. Attention. Battery 80%.",
    );
  });

  it("states status in operator English and reserves the tinted chip for trouble", () => {
    useFleetStore.getState().applySnapshot(snapshot({ "N-02": "red" }));
    render(<FleetRail />);

    const nominal = screen.getAllByText("Nominal", {
      selector: "[data-slot='status-chip']",
    });
    expect(nominal).toHaveLength(2);
    for (const chip of nominal) expect(chip).toHaveClass("bg-transparent");

    const alert = screen.getByText("Alert", { selector: "[data-slot='status-chip']" });
    expect(alert).toHaveClass("bg-alert-tint");
  });

  it("says nothing about a trend until a joint is actually climbing", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetRail />);
    expect(screen.queryByText("Trending")).not.toBeInTheDocument();

    // a quiet fleet: plenty of samples, flat temperatures
    act(() => {
      feed("N-02", 20);
    });
    expect(screen.queryByText("Trending")).not.toBeInTheDocument();
  });

  it("names the climbing joint on the row, in the operator's vocabulary", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetRail />);

    act(() => {
      feed("N-02", 20, { knee_L: 20 });
    });

    const row = screen.getAllByRole("link")[1]!;
    expect(within(row).getByText("Trending")).toBeVisible();
    // the wire says "knee_L"; the rail never does
    expect(within(row).getByText("left knee +20 °C/min")).toBeVisible();
    expect(row).not.toHaveTextContent("knee_L");

    // and it stays subordinate to the status vocabulary: the unit is nominal,
    // and the watch has not put a second chip on the row to argue with it
    expect(
      within(row).getAllByText("Nominal", { selector: "[data-slot='status-chip']" }),
    ).toHaveLength(1);
    expect(
      within(row).queryAllByText("Trending", { selector: "[data-slot='status-chip']" }),
    ).toHaveLength(0);

    // the other two rows are untouched
    expect(screen.getAllByText("Trending")).toHaveLength(1);
  });

  it("carries the trend in the row's accessible name, as one more clause", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetRail />);

    act(() => {
      feed("N-02", 20, { knee_L: 20 });
    });

    const name = screen.getAllByRole("link")[1]!.getAttribute("aria-label") ?? "";
    expect(name).toContain("N-02, Maple Hollow.");
    expect(name).toContain("Nominal.");
    // spelled out, like "Battery 79 percent" — "°C/min" is not reliably spoken
    expect(name).toContain("Trending: left knee climbing 20 degrees Celsius per minute.");
  });

  it("stands the row's trend line down the moment the unit alerts", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetRail />);
    act(() => {
      feed("N-02", 20, { knee_L: 20 });
    });
    expect(screen.getByText("Trending")).toBeVisible();

    act(() => {
      useFleetStore.getState().applyAlert({
        t: "alert",
        alert: {
          id: "al-002",
          unitId: "N-02",
          severity: "amber",
          message: "Maple Hollow: left knee actuator running hot",
          ts: Date.now(),
        },
      });
    });

    // the alert owns the story now — one severity on the row, not two
    expect(screen.queryByText("Trending")).not.toBeInTheDocument();
    expect(screen.getByText("Attention")).toBeInTheDocument();
  });

  it("renders once per battery move for its own unit, and not at all for anyone else's", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetRail />);
    renders.clear();

    // ten batches for N-01, flushed one at a time, each moving its battery a
    // whole percent — one per-unit notification each, zero store commits for
    // the batch itself, so one render each for exactly one row
    for (let i = 0; i < 10; i += 1) {
      act(() => {
        useFleetStore.getState().applyTelemetry(telemetry("N-01", 70 - i));
      });
    }

    expect(renders.get("N-01")).toBe(10);
    expect(renders.get("N-02") ?? 0).toBe(0);
    expect(renders.get("N-03") ?? 0).toBe(0);
  });

  it("re-renders only the unit whose status the alert changed", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetRail />);
    renders.clear();

    act(() => {
      useFleetStore.getState().applyAlert({
        t: "alert",
        alert: {
          id: "al-001",
          unitId: "N-03",
          severity: "amber",
          message: "Mill Street: left knee actuator running hot",
          ts: Date.now(),
        },
      });
    });

    expect(renders.get("N-03") ?? 0).toBeGreaterThan(0);
    expect(renders.get("N-01") ?? 0).toBe(0);
    expect(renders.get("N-02") ?? 0).toBe(0);
    expect(screen.getByText("Attention")).toBeInTheDocument();
  });

  it("keeps the same per-row isolation once a filter has narrowed the list", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(
      <>
        <FleetRailFilterField />
        <FleetRail />
      </>,
    );
    // "o": Cedar Row and Maple Hollow, not Mill Street — the row still on
    // screen is N-01's, not N-03's.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "o" } });
    renders.clear();

    act(() => {
      useFleetStore.getState().applyTelemetry(telemetry("N-01", 65));
    });

    expect(renders.get("N-01")).toBe(1);
    expect(renders.get("N-02") ?? 0).toBe(0);
  });

  it("keeps the same per-row isolation once the order is attention-first", () => {
    // All three nominal: attention-first ties every unit at the same rank, so
    // the order stays roster and a telemetry batch — which never touches
    // `units` and so can never re-rank anyone — cannot move a row. (An alert
    // is a different story: it can change a unit's rank and legitimately
    // shift OTHER rows' index props, which is reordering doing its job, not a
    // telemetry leak — that is not what this tripwire is about.)
    useFleetStore.getState().applySnapshot(snapshot());
    render(
      <>
        <FleetRailOrderToggle />
        <FleetRail />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Attention first" }));
    renders.clear();

    act(() => {
      useFleetStore.getState().applyTelemetry(telemetry("N-01", 65));
    });

    expect(renders.get("N-01")).toBe(1);
    expect(renders.get("N-02") ?? 0).toBe(0);
    expect(renders.get("N-03") ?? 0).toBe(0);
  });

  it("filters by unit id, case-insensitively", async () => {
    const user = userEvent.setup();
    useFleetStore.getState().applySnapshot(snapshot());
    render(
      <>
        <FleetRailFilterField />
        <FleetRail />
      </>,
    );

    await user.type(screen.getByRole("searchbox"), "n-02");
    expect(screen.getAllByRole("link").map((r) => r.getAttribute("href"))).toEqual([
      "/unit/N-02",
    ]);
  });

  it("filters by home name, case-insensitively", async () => {
    const user = userEvent.setup();
    useFleetStore.getState().applySnapshot(snapshot());
    render(
      <>
        <FleetRailFilterField />
        <FleetRail />
      </>,
    );

    await user.type(screen.getByRole("searchbox"), "CEDAR");
    expect(screen.getAllByRole("link").map((r) => r.getAttribute("href"))).toEqual([
      "/unit/N-01",
    ]);
  });

  it("says what to do next when a filter matches nothing, without looking like a fault", async () => {
    const user = userEvent.setup();
    useFleetStore.getState().applySnapshot(snapshot());
    render(
      <>
        <FleetRailFilterField />
        <FleetRail />
      </>,
    );

    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    const note = document.querySelector('[data-slot="region-note"]');
    expect(note?.textContent).toBe("No units match “zzz.” Clear the search to see all 3.");

    // the floor holds for a filtered-empty list exactly like an empty fleet
    const scrollport = document.querySelector<HTMLElement>(
      '[data-slot="fleet-rail-scrollport"]',
    );
    expect(scrollport?.style.height).toBe(`${UNIT_CARD_HEIGHT * MIN_VISIBLE_ROWS}px`);

    // and it says what to do next, not just that there is nothing
    await user.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  it("defaults to roster order, and the toggle names both states plainly", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(
      <>
        <FleetRailOrderToggle />
        <FleetRail />
      </>,
    );

    expect(screen.getByRole("button", { name: "Roster" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Attention first" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getAllByRole("link").map((r) => r.getAttribute("href"))).toEqual([
      "/unit/N-01",
      "/unit/N-02",
      "/unit/N-03",
    ]);
  });

  it("orders alert before attention before trending before nominal, roster order as the tiebreak", () => {
    useFleetStore.getState().applySnapshot(attentionSnapshot());
    render(
      <>
        <FleetRailOrderToggle />
        <FleetRail />
      </>,
    );

    act(() => {
      feed("N-03", 20, { knee_L: 20 });
    });
    expect(screen.getByText("Trending")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Attention first" }));
    expect(screen.getByRole("button", { name: "Attention first" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // N-01 and N-05 are both red: rank ties on roster order, so N-01 (earlier
    // in the snapshot) leads N-05, not the other way round.
    expect(screen.getAllByRole("link").map((r) => r.getAttribute("href"))).toEqual([
      "/unit/N-01",
      "/unit/N-05",
      "/unit/N-02",
      "/unit/N-03",
      "/unit/N-04",
    ]);

    // and switching back to Roster restores the snapshot's own order
    fireEvent.click(screen.getByRole("button", { name: "Roster" }));
    expect(screen.getAllByRole("link").map((r) => r.getAttribute("href"))).toEqual([
      "/unit/N-01",
      "/unit/N-02",
      "/unit/N-03",
      "/unit/N-04",
      "/unit/N-05",
    ]);
  });

  it("Escape clears the filter and keeps focus in the field", async () => {
    const user = userEvent.setup();
    useFleetStore.getState().applySnapshot(snapshot());
    render(
      <>
        <FleetRailFilterField />
        <FleetRail />
      </>,
    );

    const field = screen.getByRole("searchbox");
    await user.type(field, "maple");
    expect(screen.getAllByRole("link")).toHaveLength(1);

    await user.keyboard("{Escape}");
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  it("keeps one tab stop in the list however long it gets, and walks it with arrows", async () => {
    const user = userEvent.setup();
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetRail />);

    const rows = screen.getAllByRole("link");
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

    await user.tab();
    expect(rows[0]).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(rows[1]).toHaveFocus());
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);

    await user.keyboard("{End}");
    await waitFor(() => expect(rows[2]).toHaveFocus());

    // and it does not wrap past the ends
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(rows[2]).toHaveFocus());

    await user.keyboard("{Home}");
    await waitFor(() => expect(rows[0]).toHaveFocus());
  });

  it("keeps arrow/home/end traversal inside a filtered list, never on a row it removed", async () => {
    const user = userEvent.setup();
    useFleetStore.getState().applySnapshot(snapshot());
    render(
      <>
        <FleetRailFilterField />
        <FleetRail />
      </>,
    );

    // "o": Cedar Row and Maple Hollow — Mill Street is filtered out
    await user.type(screen.getByRole("searchbox"), "o");
    const rows = screen.getAllByRole("link");
    expect(rows.map((r) => r.getAttribute("href"))).toEqual(["/unit/N-01", "/unit/N-02"]);

    rows[0]!.focus();
    expect(rows[0]).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(rows[1]).toHaveFocus());

    // the filtered-out third row is not reachable — End is already here
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(rows[1]).toHaveFocus());
    await user.keyboard("{End}");
    await waitFor(() => expect(rows[1]).toHaveFocus());

    await user.keyboard("{Home}");
    await waitFor(() => expect(rows[0]).toHaveFocus());
  });
});

describe("rail height", () => {
  const scrollport = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('[data-slot="fleet-rail-scrollport"]');
    if (!el) throw new Error("no scrollport");
    return el;
  };

  it("derives its height from its rows: a fleet that fits is shown whole", () => {
    expect(railScrollportHeight(5, () => UNIT_CARD_HEIGHT)).toBe(5 * UNIT_CARD_HEIGHT);
    // a row that grew a line grows the rail by that line, not by a scroll
    expect(railScrollportHeight(5, (i) => (i === 1 ? 94 : UNIT_CARD_HEIGHT))).toBe(
      UNIT_CARD_HEIGHT * 4 + 94,
    );
  });

  it("floors at MIN_VISIBLE_ROWS, so an empty or tiny fleet does not fold the shell up", () => {
    const floor = UNIT_CARD_HEIGHT * MIN_VISIBLE_ROWS;
    expect(railScrollportHeight(0, () => UNIT_CARD_HEIGHT)).toBe(floor);
    expect(railScrollportHeight(3, () => UNIT_CARD_HEIGHT)).toBe(floor);
    expect(railScrollportHeight(MIN_VISIBLE_ROWS, () => UNIT_CARD_HEIGHT)).toBe(floor);
  });

  it("caps at MAX_VISIBLE_ROWS of standard rows, so a stress fleet stays a bounded scrollport", () => {
    expect(railScrollportHeight(500, () => UNIT_CARD_HEIGHT)).toBe(
      UNIT_CARD_HEIGHT * MAX_VISIBLE_ROWS,
    );
    // the cap is a fixed figure — a trending row in a big fleet does not nudge it
    expect(railScrollportHeight(MAX_VISIBLE_ROWS + 1, () => 94)).toBe(
      UNIT_CARD_HEIGHT * MAX_VISIBLE_ROWS,
    );
    // …and exactly MAX_VISIBLE_ROWS is still "fits", measured from its rows
    expect(railScrollportHeight(MAX_VISIBLE_ROWS, () => UNIT_CARD_HEIGHT)).toBe(
      UNIT_CARD_HEIGHT * MAX_VISIBLE_ROWS,
    );
  });

  it("sizes the scrollport to whole rows in the DOM, and re-sizes when a row starts trending", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetRail />);
    const floor = UNIT_CARD_HEIGHT * MIN_VISIBLE_ROWS;
    // three units sit on the floor; the rows are whole, the card keeps its shape
    expect(scrollport().style.height).toBe(`${floor}px`);

    act(() => {
      feed("N-02", 20, { knee_L: 20 });
    });
    expect(screen.getByText("Trending")).toBeVisible();
    expect(scrollport().style.height).toBe(
      `${Math.max(floor, 2 * UNIT_CARD_HEIGHT + 94)}px`,
    );
  });

  it("holds a fleet larger than the cap to MAX_VISIBLE_ROWS tall and virtualizes the rest", () => {
    const many = 40;
    useFleetStore.getState().applySnapshot({
      t: "fleet_snapshot",
      units: Array.from({ length: many }, (_, i) => ({
        id: `N-${String(i + 1).padStart(2, "0")}`,
        name: `Home ${i + 1}`,
        status: "nominal" as const,
        battery: 80,
        pos: { lat: 44 + i / 1000, lng: -121 },
      })),
    });
    render(<FleetRail />);

    expect(scrollport().style.height).toBe(`${UNIT_CARD_HEIGHT * MAX_VISIBLE_ROWS}px`);
    // the list inside is the whole fleet tall (that is what there is to scroll)…
    expect(scrollport().firstElementChild).toHaveStyle({
      height: `${many * UNIT_CARD_HEIGHT}px`,
    });
    // …but the DOM holds a viewport of rows plus overscan, not forty
    const mounted = screen.getAllByRole("link").length;
    expect(mounted).toBeGreaterThanOrEqual(MAX_VISIBLE_ROWS);
    expect(mounted).toBeLessThan(many);
  });
});
