import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type UnitStatus } from "@/lib/schema";
import { useFleetStore } from "@/lib/stores";
import { UnitDetail } from "./unit-detail";

/**
 * The two shapes of a drill-in, and the difference between them: "the fleet has
 * not reported in yet" and "there is no such unit" look identical in the store
 * — an empty `units` map — and telling an operator their robot does not exist
 * because a socket took a moment would be the worst lie this page could tell.
 *
 * The waiting case is also where this route's CLS lived, so the
 * first test below pins the shape as well as the copy: the page waits *as
 * itself*, at its settled size, rather than as a centred sentence that a
 * snapshot then replaces with two metres of instruments.
 */

function snapshot(ids: Array<[string, string, UnitStatus]>) {
  act(() => {
    useFleetStore.getState().applySnapshot({
      t: "fleet_snapshot",
      units: ids.map(([id, name, status], i) => ({
        id,
        name,
        status,
        battery: 80 - i,
        pos: { lat: 44 + i / 100, lng: -121 - i / 100 },
      })),
    });
  });
}

beforeEach(() => {
  useFleetStore.getState().reset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom has no canvas backend. Returning null rather than letting it warn
  // eighteen times per test also exercises the strip's own guard: no context,
  // no drawing, no crash. The drawing itself is covered against a recording
  // context in components/console/telemetry-strip.test.tsx.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

describe("UnitDetail", () => {
  it("waits as the page it is about to be, rather than denying the unit exists", () => {
    const { container } = render(<UnitDetail unitId="N-07" />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("N-07");
    expect(screen.getByText("Waiting for the fleet")).toBeVisible();
    expect(screen.queryByText(/No unit with this id/)).not.toBeInTheDocument();
    // no dead end offered while the answer is still coming
    expect(screen.queryByRole("link", { name: "Back to fleet" })).not.toBeInTheDocument();

    // The stack is already standing at its settled size, so the first snapshot
    // fills these boxes instead of pushing the page (and the footer) down.
    expect(screen.getByRole("heading", { name: "Status timeline" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Joint telemetry" })).toBeVisible();
    expect(container.querySelectorAll("canvas")).toHaveLength(18);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("says so calmly, with a way out, once the fleet is known and the id is not", () => {
    snapshot([["N-01", "Cedar Row", "nominal"]]);
    render(<UnitDetail unitId="N-99" />);

    expect(screen.getByText(/No unit with this id/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to fleet" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.queryByText("Joint telemetry")).not.toBeInTheDocument();
  });

  it("renders the identity, the timeline and six joints' worth of instruments", () => {
    snapshot([["N-07", "Sagebrush House", "nominal"]]);
    const { container } = render(<UnitDetail unitId="N-07" />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("N-07");
    expect(screen.getByText("Sagebrush House")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Status timeline" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Joint telemetry" })).toBeVisible();

    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual([
      "Left hip",
      "Left knee",
      "Left ankle",
      "Right hip",
      "Right knee",
      "Right ankle",
    ]);
    // six joints x temp, torque, current — and not one chart DOM node
    expect(container.querySelectorAll("canvas")).toHaveLength(18);
    expect(screen.getByRole("link", { name: "Fleet" })).toHaveAttribute("href", "/");
  });

  it("keeps the incident banner off a healthy unit", () => {
    snapshot([["N-07", "Sagebrush House", "nominal"]]);
    const { container } = render(<UnitDetail unitId="N-07" />);
    expect(container.querySelector('[data-slot="incident-banner"]')).toBeNull();
  });
});
