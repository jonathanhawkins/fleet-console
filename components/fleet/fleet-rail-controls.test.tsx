import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type FleetSnapshotMessage, type UnitStatus } from "@/lib/schema";
import { useFleetStore } from "@/lib/stores";

/**
 * The rail header's own contract, split out of fleet-rail.test.tsx alongside
 * fleet-rail-controls.tsx: the count's copy, and that every control in the
 * header — search, order — stays silent until there is a fleet to act on,
 * the same rule `FleetAlertCount`/`AlertFilterToggle` hold for the alert
 * feed. Filtering and ordering the LIST itself (what the operator sees when
 * these controls are used) is fleet-rail.test.tsx's job — this file is the
 * header in isolation.
 */

const { FleetRailFilterField, FleetRailOrderToggle, FleetUnitCount, setRailFilter, setRailOrder } =
  await import("./fleet-rail-controls");

const UNITS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "N-01", name: "Cedar Row" },
  { id: "N-02", name: "Maple Hollow" },
  { id: "N-03", name: "Mill Street" },
];

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

beforeEach(() => {
  useFleetStore.getState().reset();
  setRailFilter("");
  setRailOrder("roster");
});

describe("FleetUnitCount", () => {
  it("says nothing until the fleet has reported in", () => {
    const { container } = render(<FleetUnitCount />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the fleet, and agrees with itself about plurals", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    const { rerender } = render(<FleetUnitCount />);
    expect(screen.getByText("3 units")).toBeInTheDocument();

    act(() => {
      useFleetStore.getState().applySnapshot({
        t: "fleet_snapshot",
        units: [snapshot().units[0]!],
      });
    });
    rerender(<FleetUnitCount />);
    expect(screen.getByText("1 unit")).toBeInTheDocument();
  });

  it('switches to "shown of total" once a filter narrows the list', async () => {
    const user = userEvent.setup();
    useFleetStore.getState().applySnapshot(snapshot());
    render(
      <>
        <FleetRailFilterField />
        <FleetUnitCount />
      </>,
    );
    expect(screen.getByText("3 units")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "maple");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.queryByText(/ units?$/)).not.toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox"));
    expect(screen.getByText("3 units")).toBeInTheDocument();
  });

  it('says "of" even when the filter happens to match every unit', async () => {
    const user = userEvent.setup();
    useFleetStore.getState().applySnapshot(snapshot());
    render(
      <>
        <FleetRailFilterField />
        <FleetUnitCount />
      </>,
    );

    await user.type(screen.getByRole("searchbox"), "N-0");
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
  });
});

describe("FleetRailFilterField", () => {
  it("says nothing until the fleet has reported in — a search box over nothing is chrome", () => {
    const { container } = render(<FleetRailFilterField />);
    expect(container).toBeEmptyDOMElement();
  });

  it("carries a plain-voice placeholder and a matching accessible name", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetRailFilterField />);
    const field = screen.getByRole("searchbox", { name: "Search units" });
    expect(field).toHaveAttribute("placeholder", "Search units");
  });

  it("stays in sync with the shared filter state across two mounted instances", async () => {
    const user = userEvent.setup();
    useFleetStore.getState().applySnapshot(snapshot());
    render(
      <>
        <FleetRailFilterField />
        <FleetUnitCount />
      </>,
    );
    await user.type(screen.getByRole("searchbox"), "mill");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });
});

describe("FleetRailOrderToggle", () => {
  it("says nothing until the fleet has reported in — nothing to reorder yet", () => {
    const { container } = render(<FleetRailOrderToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names its group for assistive tech, distinct from the alert feed's own switch", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetRailOrderToggle />);
    expect(screen.getByRole("group", { name: "Unit order" })).toBeInTheDocument();
  });
});
