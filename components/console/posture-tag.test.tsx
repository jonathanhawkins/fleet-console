import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PostureTag, postureLabel } from "./posture-tag";
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
