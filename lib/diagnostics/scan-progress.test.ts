import { describe, expect, it } from "vitest";
import { JOINTS } from "@/sim/engine/constants";
import { DIAG_WALK_PATHS } from "@/sim/engine/diagnostics";
import {
  EXPECTED_CHANNELS,
  EXPECTED_SCAN_UNITS,
  EXPECTED_WALKS,
  scanProgress,
} from "./scan-progress";

/**
 * The bar reads the machine, not a clock.
 *
 * Two things are asserted here and the first matters more: the totals this
 * module declares are the totals the simulator actually emits. The UI does not
 * import those arrays — that would put the engine in the unit page's bundle —
 * so this test is the joint that holds them together, and it fails the moment
 * someone adds a walk path without telling the surface that counts them.
 */

const session = (walks: number, channels: number, report: unknown = null) => ({
  walkLines: Array.from({ length: walks }, (_, i) => `/sys/node/${i}`),
  channels: Array.from({ length: channels }, (_, i) => ({
    joint: `j${i}`,
    wave: [],
    ref: [],
  })),
  report: report as never,
});

describe("the declared totals match the simulator", () => {
  it("counts every walk path the scan streams", () => {
    expect(EXPECTED_WALKS).toBe(DIAG_WALK_PATHS.length);
  });

  it("counts one channel per joint", () => {
    expect(EXPECTED_CHANNELS).toBe(JOINTS.length);
  });
});

describe("scanProgress", () => {
  it("is empty and starting with no session", () => {
    expect(scanProgress(null)).toMatchObject({
      fraction: 0,
      completed: 0,
      stage: "starting",
    });
  });

  it("is starting until the first event lands", () => {
    expect(scanProgress(session(0, 0)).stage).toBe("starting");
  });

  it("counts walk lines through the subsystem stage", () => {
    const p = scanProgress(session(10, 0));
    expect(p.completed).toBe(10);
    expect(p.stage).toBe("subsystems");
    expect(p.fraction).toBeCloseTo(10 / EXPECTED_SCAN_UNITS);
  });

  it("moves to channels once one is measured", () => {
    const p = scanProgress(session(EXPECTED_WALKS, 2));
    expect(p.completed).toBe(EXPECTED_WALKS + 2);
    expect(p.stage).toBe("channels");
  });

  it("settles at the verdict whatever arrived", () => {
    expect(scanProgress(session(3, 1, { joint: "knee_L" }))).toMatchObject({
      fraction: 1,
      stage: "complete",
    });
  });

  it("never runs past its own end when the wire says more than expected", () => {
    const p = scanProgress(session(EXPECTED_WALKS + 5, EXPECTED_CHANNELS + 5));
    expect(p.fraction).toBe(1);
    expect(p.completed).toBe(EXPECTED_SCAN_UNITS);
  });

  it("stalls rather than drifting when nothing more arrives", () => {
    const a = scanProgress(session(7, 0));
    const b = scanProgress(session(7, 0));
    expect(a.fraction).toBe(b.fraction);
  });
});
