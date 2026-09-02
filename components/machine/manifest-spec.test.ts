// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type DiagSession } from "@/lib/stores";
import {
  buildManifest,
  manifestCleared,
  MANIFEST_ROWS,
  type ManifestEntry,
} from "./manifest-spec";

/**
 * DoD: the board is driven entirely by diag_events.
 *
 * Which reduces, because `buildManifest` is pure, to a claim a test can settle
 * completely: every row's state is a function of the session and of nothing
 * else — no latching, no timers, no seeded optimism — so a page refreshed
 * mid-scan reconstructs the identical board from the prefix the host replays.
 */

const session = (over: Partial<DiagSession> = {}): DiagSession => ({
  unitId: "N-07",
  startedAt: 1_700_000_000_000,
  walkLines: [],
  channels: [],
  flag: null,
  report: null,
  acknowledged: [],
  calibration: null,
  ...over,
});

const channel = (joint: string) => ({ joint, wave: [0, 1], ref: [0, 1] });

const flag = {
  k: "flag" as const,
  joint: "knee_L" as const,
  component: "actuator_A07" as const,
  anomaly: "gain" as const,
};

const stateOf = (entries: ManifestEntry[], id: string) =>
  entries.find((e) => e.row.id === id)?.state;

describe("buildManifest", () => {
  it("starts with every row pending, and nothing claiming to be operating", () => {
    const entries = buildManifest(null);
    expect(entries).toHaveLength(MANIFEST_ROWS.length);
    expect(entries.every((e) => e.state === "pending")).toBe(true);
    expect(manifestCleared(entries)).toBe(0);
  });

  it("numbers rows positionally from 0001", () => {
    const entries = buildManifest(null);
    expect(entries[0]?.ordinal).toBe(1);
    expect(entries.at(-1)?.ordinal).toBe(MANIFEST_ROWS.length);
  });

  it("clears a bus row when its channel is measured, and only its own", () => {
    const entries = buildManifest(session({ channels: [channel("hip_L")] }));
    expect(stateOf(entries, "HIP_L")).toBe("operating");
    expect(stateOf(entries, "HIP_R")).toBe("pending");
    expect(stateOf(entries, "KNEE_L")).toBe("pending");
  });

  it("clears a structure row when the walk reaches its node", () => {
    const entries = buildManifest(
      session({ walkLines: ["/sys/core/power_rail/v48_main"] }),
    );
    expect(stateOf(entries, "POWER_RAIL_48V")).toBe("operating");
    expect(stateOf(entries, "THERMAL_MAP")).toBe("pending");
  });

  it("counts a multi-node row as a fraction until every node is in", () => {
    const partial = buildManifest(
      session({
        walkLines: ["/calib/hip_L/gain_table.bin", "/calib/hip_R/gain_table.bin"],
      }),
    );
    const row = partial.find((e) => e.row.id === "GAIN_TABLES");
    expect(row?.state).toBe("pending");
    expect(row?.detail).toBe("2/6");

    const all = buildManifest(
      session({
        walkLines: ["hip_L", "hip_R", "knee_L", "knee_R", "ankle_L", "ankle_R"].map(
          (j) => `/calib/${j}/gain_table.bin`,
        ),
      }),
    );
    const done = all.find((e) => e.row.id === "GAIN_TABLES");
    expect(done?.state).toBe("operating");
    expect(done?.detail).toBe("6/6");
  });

  it("stamps the flagged joint DAMAGED, outranking its own measurement", () => {
    // The channel arrived and would otherwise read OPERATING; the flag is the
    // authoritative signal and the board does not argue with it.
    const entries = buildManifest(session({ channels: [channel("knee_L")], flag }));
    expect(stateOf(entries, "KNEE_L")).toBe("damaged");
    expect(entries.filter((e) => e.state === "damaged")).toHaveLength(1);
  });

  it("stamps the subject RESTORED once the machine re-measures it clean", () => {
    // The board consumes the recalibration the same way it consumed the flag:
    // both are the machine's own judgement about that channel. A row left
    // DAMAGED under a verdict card saying the channel is back would be the
    // board and the conclusion telling two stories.
    const entries = buildManifest(
      session({
        channels: [channel("knee_L")],
        flag,
        calibration: {
          k: "recalibration",
          joint: "knee_L",
          wave: [0, 1],
          ref: [0, 1],
          outcome: "cleared",
        },
      }),
    );
    expect(stateOf(entries, "KNEE_L")).toBe("restored");
    expect(entries.filter((e) => e.state === "damaged")).toHaveLength(0);
    // Not folded into OPERATING: fourteen rows cleared because they were
    // checked, and this one cleared because it was fixed.
    expect(entries.filter((e) => e.state === "restored")).toHaveLength(1);
  });

  it("holds the stamp at DAMAGED while the correction is only partial", () => {
    const entries = buildManifest(
      session({
        channels: [channel("knee_L")],
        flag,
        calibration: {
          k: "recalibration",
          joint: "knee_L",
          wave: [0, 1],
          ref: [0, 1],
          outcome: "partial",
        },
      }),
    );
    expect(stateOf(entries, "KNEE_L")).toBe("damaged");
  });

  it("counts a damaged row as cleared — it was checked, and it answered", () => {
    const entries = buildManifest(session({ channels: [channel("knee_L")], flag }));
    expect(manifestCleared(entries)).toBe(1);
  });

  it("reconstructs the same board from a replayed prefix", () => {
    const s = session({
      walkLines: ["/sys/actuator_bus/enumerate", "/proprio/imu/fusion_state"],
      channels: [channel("hip_L"), channel("knee_L")],
      flag,
    });
    // The store dedupes redelivery, so "replayed" means the same session object
    // arriving at a freshly-mounted board. Same input, same board.
    expect(buildManifest(s)).toEqual(buildManifest(s));
    expect(stateOf(buildManifest(s), "KNEE_L")).toBe("damaged");
    expect(stateOf(buildManifest(s), "SPINE_BUS")).toBe("operating");
  });

  it("holds no row for a component the scan never checks", () => {
    // The board's one rule. Anything here that the walk and the channels cannot
    // clear would sit PENDING forever or, worse, be seeded OPERATING.
    for (const row of MANIFEST_ROWS) {
      const reachable =
        row.joint !== undefined || row.path !== undefined || row.prefix !== undefined;
      expect(reachable).toBe(true);
    }
    expect(MANIFEST_ROWS.some((r) => r.id === "TORSO_YAW")).toBe(false);
  });

  it("clears the whole board over a complete scan", () => {
    const entries = buildManifest(
      session({
        walkLines: [
          "/sys/core/heartbeat.svc",
          "/sys/core/power_rail/v48_main",
          "/sys/core/thermal/zone_map.cfg",
          "/sys/actuator_bus/enumerate",
          "/firmware/gait/park_pose.ko",
          "/firmware/gait/walk_cycle.ko",
          "/firmware/gait/balance_reflex.ko",
          "/proprio/imu/fusion_state",
          ...["hip_L", "hip_R", "knee_L", "knee_R", "ankle_L", "ankle_R"].map(
            (j) => `/calib/${j}/gain_table.bin`,
          ),
        ],
        channels: ["hip_L", "hip_R", "knee_L", "knee_R", "ankle_L", "ankle_R"].map(
          channel,
        ),
        flag,
      }),
    );
    expect(manifestCleared(entries)).toBe(MANIFEST_ROWS.length);
    expect(entries.filter((e) => e.state === "pending")).toHaveLength(0);
  });
});
