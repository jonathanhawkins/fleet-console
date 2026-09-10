import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type FleetSnapshotMessage,
  type TelemetryMessage,
  type UnitStatus,
} from "@/lib/schema";
import { resetTrendWatchForTests, useFleetStore } from "@/lib/stores";
import { type ConnectionStatus as TransportStatus } from "@/lib/transport/types";
import { CONNECTION_VIEW, FleetKpis, LiveConnectionStatus } from "./fleet-kpis";

/**
 * KPIs are the one place on this page where a wrong number would be believed
 * without checking, so the tests are mostly about honesty: no invented zeros
 * before the fleet has reported in, and a count that agrees with the feed.
 */

function snapshot(statuses: UnitStatus[]): FleetSnapshotMessage {
  return {
    t: "fleet_snapshot",
    units: statuses.map((status, i) => ({
      id: `N-0${i + 1}`,
      name: `House ${i + 1}`,
      status,
      battery: 80,
      pos: { lat: 44, lng: -121 },
    })),
  };
}

function telemetry(unitId: string, battery: number): TelemetryMessage {
  return {
    t: "telemetry",
    unitId,
    ts: Date.now(),
    batch: [{ joint: "knee_L", tempC: 40, torqueNm: 1, currentA: 2, battery }],
  };
}

/**
 * `seconds` of 10 Hz batches for one unit, with `ramps` giving a joint's climb
 * in °C/min — the shape the thermal trend watch fits against (the helper is
 * lifted from lib/stores/trendWatch.test.ts, where the fit itself is proved).
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
});

/** The figure under a given KPI label — three numbers on one row collide often. */
function figure(label: string): HTMLElement {
  const group = screen.getByText(label).closest("[data-slot='stat-group']");
  const dd = group?.querySelector("dd");
  if (!dd) throw new Error(`no KPI figure for "${label}"`);
  return dd as HTMLElement;
}

describe("FleetKpis", () => {
  it("renders em-dashes, not zeros, before the fleet has reported in", () => {
    render(
      <dl>
        <FleetKpis />
      </dl>,
    );
    expect(screen.getAllByText("—")).toHaveLength(4);
    expect(screen.getAllByText("No data yet")).toHaveLength(4);
  });

  it("counts nominal units against the size of the fleet", () => {
    useFleetStore.getState().applySnapshot(snapshot(["nominal", "nominal", "red"]));
    render(
      <dl>
        <FleetKpis />
      </dl>,
    );
    expect(figure("Units nominal")).toHaveTextContent("2of 3");
  });

  it("keeps the alert count quiet at zero and clay above it", () => {
    useFleetStore.getState().applySnapshot(snapshot(["nominal", "nominal"]));
    render(
      <dl>
        <FleetKpis />
      </dl>,
    );
    const alerts = figure("Units alerting");
    expect(alerts).toHaveTextContent("0");
    expect(alerts).toHaveClass("text-ink");
    expect(alerts).not.toHaveClass("text-alert-ink");

    act(() => {
      useFleetStore.getState().applyAlert({
        t: "alert",
        alert: {
          id: "al-001",
          unitId: "N-02",
          severity: "red",
          message: "House 2: left knee actuator overheating",
          ts: Date.now(),
        },
      });
    });

    expect(figure("Units alerting")).toHaveTextContent("1");
    expect(figure("Units alerting")).toHaveClass("text-alert-ink");
  });

  /**
   * The band's two watched numbers move rarely and mean something when they
   * do, so each carries the change beat; the other two move as bookkeeping and
   * must not, or the row would acknowledge the passage of time. The arrival is
   * excluded on purpose — the em-dash inking up is already one gesture, and a
   * second on top of it would stage two arrivals for one piece of news.
   */
  it("draws the eye to a count that moved, and not to one that has just arrived", () => {
    render(
      <dl>
        <FleetKpis />
      </dl>,
    );

    act(() => {
      useFleetStore.getState().applySnapshot(snapshot(["nominal", "nominal"]));
    });
    expect(figure("Units alerting")).toHaveTextContent("0");
    expect(figure("Units alerting")).not.toHaveAttribute("data-ack");

    act(() => {
      useFleetStore.getState().applyAlert({
        t: "alert",
        alert: {
          id: "al-001",
          unitId: "N-02",
          severity: "red",
          message: "House 2: left knee actuator overheating",
          ts: Date.now(),
        },
      });
    });

    expect(figure("Units alerting")).toHaveAttribute("data-ack");
    // nominal moved too — as alerting's inverse — and stays silent, so one
    // piece of news lights one place on the row
    expect(figure("Units nominal")).not.toHaveClass("stat-group__ack");
    expect(figure("Avg battery")).not.toHaveClass("stat-group__ack");
  });

  it("gives the trend count the same beat, in its own quieter ink", () => {
    useFleetStore.getState().applySnapshot(snapshot(["nominal", "nominal"]));
    render(
      <dl>
        <FleetKpis />
      </dl>,
    );
    expect(figure("Trending")).not.toHaveAttribute("data-ack");

    act(() => {
      feed("N-01", 20, { knee_L: 20 });
    });

    const trending = figure("Trending");
    expect(trending).toHaveTextContent("1");
    expect(trending).toHaveAttribute("data-ack");
    // the mark paints in currentColor, so warn ink is what makes it one step
    // under the alert count's — the ordering lives in the tone, not in a
    // second set of colours
    expect(trending).toHaveClass("stat-group__ack", "text-warn-ink");
  });

  it("names the currency it counts: units, not alert events", () => {
    useFleetStore.getState().applySnapshot(snapshot(["nominal", "nominal"]));
    render(
      <dl>
        <FleetKpis />
      </dl>,
    );

    // One robot, two alerts — the escalation shape. The feed below prints
    // "2 events · 1 unit"; this band must print the unit half and say so.
    act(() => {
      for (const [i, severity] of (["amber", "red"] as const).entries()) {
        useFleetStore.getState().applyAlert({
          t: "alert",
          alert: {
            id: `al-00${i + 1}`,
            unitId: "N-02",
            severity,
            message: "House 2: left knee actuator overheating",
            ts: Date.now(),
          },
        });
      }
    });

    expect(screen.queryByText("Active alerts")).not.toBeInTheDocument();
    expect(figure("Units alerting")).toHaveTextContent("1");
  });

  it("keeps the trend count soft at zero — a watch with nothing to report recedes", () => {
    useFleetStore.getState().applySnapshot(snapshot(["nominal", "nominal"]));
    render(
      <dl>
        <FleetKpis />
      </dl>,
    );

    const trending = figure("Trending");
    expect(trending).toHaveTextContent("0");
    expect(trending).toHaveClass("text-ink-soft");
    // and no denominator: the watch is a subset, not a partition
    expect(trending).not.toHaveTextContent("of");
  });

  it("counts a climbing joint in warn ink — one step under the alert count", () => {
    useFleetStore.getState().applySnapshot(snapshot(["nominal", "nominal"]));
    render(
      <dl>
        <FleetKpis />
      </dl>,
    );

    act(() => {
      feed("N-01", 20, { knee_L: 20 });
    });

    const trending = figure("Trending");
    expect(trending).toHaveTextContent("1");
    expect(trending).toHaveClass("text-warn-ink");
    // the load-bearing half: it must not borrow the alert treatment
    expect(trending).not.toHaveClass("text-alert-ink");
    // and the unit is still nominal, so the alert count has not moved
    expect(figure("Units alerting")).toHaveTextContent("0");
  });

  it("averages battery from live telemetry, not the stale snapshot", () => {
    useFleetStore.getState().applySnapshot(snapshot(["nominal", "nominal"]));
    render(
      <dl>
        <FleetKpis />
      </dl>,
    );
    expect(figure("Avg battery")).toHaveTextContent("80%");

    act(() => {
      useFleetStore.getState().applyTelemetry(telemetry("N-01", 60));
    });

    // (60 + 80) / 2
    expect(figure("Avg battery")).toHaveTextContent("70%");
  });
});

describe("LiveConnectionStatus", () => {
  it("maps five transport states onto the four an operator is told about", () => {
    const expected: Record<TransportStatus, string> = {
      idle: "idle",
      connecting: "connecting",
      open: "live",
      // a reconnect is, from the operator's side of the glass, a link that is
      // currently down — the numbers on the page have stopped arriving
      reconnecting: "lost",
      closed: "lost",
    };
    expect(CONNECTION_VIEW).toEqual(expected);
  });

  it("renders the store's connection state, and updates when it moves", () => {
    render(<LiveConnectionStatus />);
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "idle");

    act(() => {
      useFleetStore.getState().setConnection("open");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Live");

    act(() => {
      useFleetStore.getState().setConnection("reconnecting");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Connection lost");
  });
});
