import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useFleetStore } from "@/lib/stores";
import { PostureTag, UnitPostureTag, postureLabel } from "./posture-tag";
import { UnitCard } from "./unit-card";

/**
 *, the quiet half. A completed SAFE SIT has to leave a mark the
 * operator can find *after* leaving machine space — otherwise the maneuver only
 * ever existed inside the surface that ordered it.
 *
 * The mark is deliberately small and deliberately additive: it never replaces
 * status (N-07 stays in fault; broken-but-safe is the whole story) and it never
 * appears for a robot on its feet, because a rail of eight rows each announcing
 * that its occupant is upright is eight labels carrying no information.
 */

describe("PostureTag", () => {
  it("says nothing about a unit on its feet", () => {
    const { container: walking } = render(<PostureTag posture="walking" />);
    expect(walking).toBeEmptyDOMElement();

    // Pre-Phase-10 snapshots have no posture field at all; the wire calls it
    // optional and the console has to read `undefined` as walking, not as a gap.
    const { container: unknown } = render(<PostureTag />);
    expect(unknown).toBeEmptyDOMElement();
    expect(postureLabel(undefined)).toBeNull();
  });

  it("names a seated unit", () => {
    render(<PostureTag posture="sitting" />);
    expect(screen.getByText("Safe sit")).toHaveAttribute("data-posture", "sitting");
    expect(postureLabel("sitting")).toBe("Safe sit");
  });
});

describe("UnitCard posture", () => {
  const row = (posture?: "walking" | "sitting") => (
    <UnitCard
      unitId="N-07"
      name="Sagebrush House"
      status="red"
      battery={84}
      recency="just now"
      posture={posture}
    />
  );

  it("carries the tag beside the status it qualifies, not instead of it", () => {
    render(row("sitting"));
    // Both, and in that order: the maneuver made the unit safe, it did not make
    // it fixed.
    expect(screen.getByText("Safe sit")).toBeInTheDocument();
    expect(screen.getByText("Alert")).toBeInTheDocument();
  });

  it("puts it in the row's accessible name, which replaces the row's content", () => {
    const { rerender } = render(row("sitting"));
    // The label is assembled by hand precisely because aria-label replaces
    // everything the row shows; a fact added to the row and forgotten here is a
    // fact a screen reader loses.
    expect(screen.getByRole("link")).toHaveAccessibleName(
      "N-07, Sagebrush House. Alert. Safe sit. Battery 84 percent. Last contact just now.",
    );

    rerender(row("walking"));
    expect(screen.getByRole("link")).toHaveAccessibleName(
      "N-07, Sagebrush House. Alert. Battery 84 percent. Last contact just now.",
    );
  });
});

/**
 * `UnitSummary.posture` is the wire's single authority: it arrives
 * with every `fleet_snapshot` and live on the settle beat's `unit_update`.
 * The old command-store fallback — reading a completed SAFE SIT because the
 * wire never restated posture between snapshots — is gone with the gap.
 */
describe("useUnitPosture", () => {
  const summary = (posture?: "walking" | "sitting") => ({
    id: "N-07",
    name: "Sagebrush House",
    status: "red" as const,
    battery: 84,
    pos: { lat: 44.06, lng: -121.28 },
    ...(posture ? { posture } : {}),
  });

  const snapshot = (posture?: "walking" | "sitting") =>
    act(() =>
      useFleetStore.getState().applySnapshot({
        t: "fleet_snapshot",
        units: [summary(posture)],
      }),
    );

  const update = (posture: "walking" | "sitting") =>
    act(() =>
      useFleetStore
        .getState()
        .applyUnitUpdate({ t: "unit_update", unit: summary(posture) }),
    );

  beforeEach(() => {
    useFleetStore.getState().reset();
  });

  it("reads the wire's own posture", () => {
    snapshot("sitting");
    render(<UnitPostureTag unitId="N-07" />);
    expect(screen.getByText("Safe sit")).toBeInTheDocument();
  });

  it("sits down live when the settle beat's unit_update lands — no reconnect", () => {
    snapshot("walking");
    const { container } = render(<UnitPostureTag unitId="N-07" />);
    expect(container).toBeEmptyDOMElement();

    update("sitting");
    expect(screen.getByText("Safe sit")).toBeInTheDocument();
  });

  it("stands the unit back up when RESET_SIM's snapshot restates the world", () => {
    snapshot("walking");
    update("sitting");
    const { container } = render(<UnitPostureTag unitId="N-07" />);
    expect(screen.getByText("Safe sit")).toBeInTheDocument();

    snapshot("walking");
    expect(container).toBeEmptyDOMElement();
  });

  it("stays quiet for a unit the store has never seen", () => {
    const { container } = render(<UnitPostureTag unitId="N-99" />);
    expect(container).toBeEmptyDOMElement();
  });
});
