// @vitest-environment node
import { PREROLL_MS } from "@/sim/engine";
import { beforeEach, describe, expect, it } from "vitest";
import { type FleetSnapshotMessage, type TelemetryMessage } from "@/lib/schema";
import { useFleetStore } from "./fleetStore";
import {
  TREND_WINDOW_MS,
  resetTrendWatchForTests,
  selectTrendingUnits,
  slopePerMin,
  TREND_ENTER_C_PER_MIN,
  TREND_EXIT_C_PER_MIN,
  trendFitsForTests,
} from "./trendWatch";

/**
 * The watch's contract: it names a climbing joint on a nominal unit before
 * any alert exists, refuses verdicts on thin or stale-shaped evidence, holds
 * through the hysteresis band without flicker, and stands down the moment the
 * unit stops being nominal. Slopes here are given in °C/min directly — the
 * feeds below convert to per-sample steps at 10 Hz.
 */

const JOINTS = ["hip_L", "hip_R", "knee_L", "knee_R", "ankle_L", "ankle_R"];

const snapshot: FleetSnapshotMessage = {
  t: "fleet_snapshot",
  units: [
    {
      id: "N-01",
      name: "Prospect Row",
      status: "nominal",
      battery: 90,
      pos: { lat: 37.51, lng: -122.27 },
    },
    {
      id: "N-07",
      name: "Elm House",
      status: "nominal",
      battery: 70,
      pos: { lat: 37.5, lng: -122.26 },
    },
  ],
};

/**
 * Feed `seconds` of 10 Hz batches; `ramps` maps joint → °C/min climb from
 * `base` °C. The watch judges every batch as it lands, so a feed that
 * continues an earlier one must start where it left off (`after`) — a
 * temperature that steps back to 33 °C between two feeds is a cliff, and a
 * cliff fits as a fall.
 */
function feed(
  unitId: string,
  seconds: number,
  ramps: Record<string, number> = {},
  startTs = 1_000_000,
  base = 33,
): void {
  const { applyTelemetry } = useFleetStore.getState();
  for (let i = 0; i < seconds * 10; i += 1) {
    const ts = startTs + i * 100;
    const minutes = (i * 100) / 60_000;
    const msg: TelemetryMessage = {
      t: "telemetry",
      unitId,
      ts,
      batch: JOINTS.map((joint) => ({
        joint,
        tempC: base + (ramps[joint] ?? 0) * minutes,
        torqueNm: 12,
        currentA: 1.5,
        battery: 80,
      })),
    };
    applyTelemetry(msg);
  }
}

/** Where a `feed` of `seconds` at `cPerMin` from `base` leaves the temperature. */
const after = (base: number, cPerMin: number, seconds: number): number =>
  base + cPerMin * (seconds / 60);

const trending = () => selectTrendingUnits(useFleetStore.getState());

beforeEach(() => {
  useFleetStore.getState().reset();
  resetTrendWatchForTests();
  useFleetStore.getState().applySnapshot(snapshot);
});

describe("slopePerMin", () => {
  it("recovers an exact linear slope in units per minute", () => {
    const xs = [0, 100, 200, 300];
    const ys = xs.map((x) => 5 + (x / 60_000) * 42); // 42 units/min
    expect(slopePerMin(xs, ys)).toBeCloseTo(42, 6);
  });

  it("declines to fit fewer than two points or zero x-variance", () => {
    expect(slopePerMin([1], [1])).toBeNaN();
    expect(slopePerMin([5, 5, 5], [1, 2, 3])).toBeNaN();
  });
});

describe("selectTrendingUnits", () => {
  it("flags a nominal unit whose joint climbs past the enter threshold, naming the joint", () => {
    feed("N-01", 20);
    feed("N-07", 20, { knee_L: 20 });
    expect(trending()).toEqual([{ unitId: "N-07", joint: "knee_L", cPerMin: 20 }]);
  });

  it("stays silent under the enter threshold", () => {
    feed("N-07", 20, { knee_L: TREND_ENTER_C_PER_MIN - 2 });
    expect(trending()).toEqual([]);
  });

  it("withholds any verdict on thin evidence (a young session)", () => {
    feed("N-07", 5, { knee_L: 40 });
    expect(trending()).toEqual([]);
  });

  it("holds through the hysteresis band and releases below exit", () => {
    feed("N-07", 20, { knee_L: 20 });
    expect(trending()).toHaveLength(1);

    // Continue between exit and enter: a fresh unit would not flag, a latched
    // one must hold.
    const between = (TREND_ENTER_C_PER_MIN + TREND_EXIT_C_PER_MIN) / 2;
    const knee = after(33, 20, 20);
    feed("N-07", 20, { knee_L: between }, 1_000_000 + 20_000, knee);
    expect(trending()).toHaveLength(1);

    // Flatten out: below exit, the watch lets go.
    feed("N-07", 20, {}, 1_000_000 + 40_000, after(knee, between, 20));
    expect(trending()).toEqual([]);
  });

  it("stands down the moment the unit stops being nominal — the alert owns it", () => {
    feed("N-07", 20, { knee_L: 30 });
    expect(trending()).toHaveLength(1);

    useFleetStore.getState().applyAlert({
      t: "alert",
      alert: {
        id: "al-100",
        unitId: "N-07",
        severity: "amber",
        message: "Elm House: left knee actuator trending hot",
        ts: 1_020_000,
      },
    });
    expect(trending()).toEqual([]);
  });

  it("keeps the result's identity while trending truth is unchanged", () => {
    feed("N-07", 20, { knee_L: 20 });
    const first = trending();
    // One more quiet batch on the OTHER unit: telemetry moved, truth did not.
    feed("N-01", 0.1, {}, 1_000_000 + 20_000);
    expect(trending()).toBe(first);
  });
});

/**
 * The derivation's SCOPE is a contract, not an implementation detail.
 * A batch carries one unit; a watch that re-judged the whole fleet on every
 * batch, any unit, re-fitted the fleet ten times a second per unit. Measured,
 * that was 0.7 ms of main thread per wall second at eight units and 39
 * SECONDS per wall second at five hundred, on a page that owes 60 fps. The
 * fits below are counted for exactly that reason.
 */
describe("selectTrendingUnits — what one batch costs", () => {
  it("re-fits the unit whose samples moved, and no other", () => {
    feed("N-01", 20);
    feed("N-07", 20, { knee_L: 20 });
    trending();

    // One batch for N-01, a second past its last fit so the quantum lets it
    // through. N-07's clock has not moved, so N-07 is not re-measured.
    const before = trendFitsForTests();
    feed("N-01", 0.1, {}, 1_000_000 + 21_000);
    trending();
    expect(trendFitsForTests() - before).toBe(1);
  });

  it("re-fits a unit once per second of its own clock, not once per batch", () => {
    feed("N-07", 20, { knee_L: 20 });
    trending();

    // A full second of batches, each read as it commits — which is the real
    // shape: one batch, one commit, one notification, one selector pass. That
    // is one re-fit, not ten: over a 15 s window read through a 3 °C/min
    // hysteresis band, the other nine answer with the same number.
    const before = trendFitsForTests();
    for (let i = 0; i < 10; i += 1) {
      feed("N-07", 0.1, {}, 1_000_000 + 20_000 + i * 100);
      trending();
    }
    expect(trendFitsForTests() - before).toBe(1);
  });

  it("re-fits nothing at all while the subscribers read the same commit", () => {
    feed("N-07", 20, { knee_L: 20 });
    trending();
    const before = trendFitsForTests();
    // Two subscribers (the rail and the KPI row) read every commit.
    trending();
    trending();
    expect(trendFitsForTests()).toBe(before);
  });
});

/**
 * RESET_SIM (CLAUDE.md non-negotiable #6: the scripted incident is
 * re-runnable). `applySnapshot` leaves the rings alone — the charts draw
 * across the seam — so everything here is about the watch refusing to read
 * the run that just ended as evidence about the one replaying.
 */
describe("selectTrendingUnits — the seam between runs", () => {
  it("drops the latch and the window on a snapshot: the replay is judged at ENTER", () => {
    feed("N-07", 20, { knee_L: 20 });
    expect(trending()).toHaveLength(1);

    // The reset. The rings still hold the run that just flagged.
    useFleetStore.getState().applySnapshot(snapshot);
    expect(trending()).toEqual([]);

    // The replay, climbing between EXIT and ENTER. A latch that survived the
    // reset would judge this at EXIT and flag the second run at a lower bar
    // than the first; a window that spanned the reset would fit the old run's
    // ramp for 15 s.
    const between = (TREND_ENTER_C_PER_MIN + TREND_EXIT_C_PER_MIN) / 2;
    feed("N-07", 20, { knee_L: between }, 1_020_000);
    expect(trending()).toEqual([]);

    // …and the replay still flags on its own evidence, at the same bar the
    // first run had to clear.
    feed("N-07", 20, { knee_L: 20 }, 1_040_000);
    expect(trending()).toEqual([{ unitId: "N-07", joint: "knee_L", cPerMin: 20 }]);
  });

  it("fits the run it is in after the stream restates itself earlier", () => {
    // A reconnect can restate a stream at timestamps EARLIER than the tail the
    // rings kept (the ordering gate resets on a snapshot). At the seam
    // `newest - previous` goes NEGATIVE, which passes an unclamped "inside the
    // window" test — the walk sails past the discontinuity and fits two runs
    // glued together instead of the twelve honest seconds in front of it.
    feed("N-07", 20);
    feed("N-07", 12, { knee_L: 20 }, 500_000);
    expect(trending()).toEqual([{ unitId: "N-07", joint: "knee_L", cPerMin: 20 }]);
  });
});

describe("the history the watch is handed", () => {
  it("is longer than the window it has to fill", () => {
    // PREROLL_MS is why the rail can name a suspect six seconds after someone
    // opens the page instead of ten: the run arrives with a past. If it ever
    // drops below the fit window the watch is back to refusing to answer until
    // it has accumulated one live, and nobody waits that long.
    expect(PREROLL_MS).toBeGreaterThan(TREND_WINDOW_MS);
    expect(PREROLL_MS - TREND_WINDOW_MS).toBeGreaterThanOrEqual(1_000);
  });
});
