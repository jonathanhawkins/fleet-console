import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useFleetStore } from "@/lib/stores";
import { UnitPostureTag } from "./unit-posture-tag";

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
