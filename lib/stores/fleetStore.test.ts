// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AlertMessage,
  type FleetSnapshotMessage,
  type TelemetryMessage,
  type UnitUpdateMessage,
} from "@/lib/schema";
import { useAuditStore } from "./auditStore";
import {
  selectAlertMeta,
  selectKpiAlerts,
  selectKpiAvgBattery,
  selectKpiNominal,
  selectUnit,
  selectUnitFirstRaisedAt,
  useFleetStore,
} from "./fleetStore";
import { RingBuffer } from "./ringBuffer";
import {
  getUnitBattery,
  getUnitBuffers,
  getUnitLastContact,
  getUnitTelemetryVersion,
  subscribeUnitTelemetry,
  TELEMETRY_RING_CAPACITY,
  telemetryBatchCount,
} from "./telemetryChannel";

/** The effective battery a `useUnitBattery(id)` host renders: live, else snapshot, else 0. */
const batteryOf = (unitId: string): number =>
  getUnitBattery(unitId) ?? useFleetStore.getState().units[unitId]?.battery ?? 0;

const snapshot: FleetSnapshotMessage = {
  t: "fleet_snapshot",
  units: [
    {
      id: "N-01",
      name: "Cedar Row",
      status: "nominal",
      battery: 90,
      pos: { lat: 44.06, lng: -121.31 },
    },
    {
      id: "N-07",
      name: "Sagebrush House",
      status: "nominal",
      battery: 70,
      pos: { lat: 44.05, lng: -121.28 },
    },
  ],
};

function telemetry(unitId: string, ts: number, battery = 80): TelemetryMessage {
  const joints = ["hip_L", "hip_R", "knee_L", "knee_R", "ankle_L", "ankle_R"];
  return {
    t: "telemetry",
    unitId,
    ts,
    batch: joints.map((joint, i) => ({
      joint,
      tempC: 30 + i,
      torqueNm: 10 + i,
      currentA: 1 + i / 10,
      battery,
    })),
  };
}

const amberAlert: AlertMessage = {
  t: "alert",
  alert: {
    id: "al-001",
    unitId: "N-07",
    severity: "amber",
    message: "Sagebrush House: left knee actuator running hot",
    ts: 58_000,
  },
};

beforeEach(() => {
  useFleetStore.getState().reset();
});

describe("ring buffer", () => {
  it("wraps around at capacity, keeping the newest samples in order", () => {
    const ring = new RingBuffer(5);
    for (let i = 1; i <= 8; i += 1) ring.push(i);
    expect(ring.length).toBe(5);
    expect(ring.toArray()).toEqual([4, 5, 6, 7, 8]);
    expect(ring.at(0)).toBe(4);
    expect(ring.last()).toBe(8);
    expect(Number.isNaN(ring.at(5))).toBe(true);

    const scratch = new Float64Array(5);
    expect(ring.copyInto(scratch)).toBe(5);
    expect([...scratch]).toEqual([4, 5, 6, 7, 8]);
  });

  it("reads a tail without copying the history behind it", () => {
    const ring = new RingBuffer(5);
    for (let i = 1; i <= 8; i += 1) ring.push(i); // [4,5,6,7,8], wrapped
    const scratch = new Float64Array(5).fill(-1);

    // The newest three, oldest→newest, at the head of the scratch — the rest
    // of the buffer is the caller's business and stays untouched.
    expect(ring.copyTail(scratch, 3)).toBe(3);
    expect([...scratch]).toEqual([6, 7, 8, -1, -1]);

    // Clamped three ways: by the ring's length, by the target, and at zero.
    expect(ring.copyTail(scratch, 99)).toBe(5);
    expect([...scratch]).toEqual([4, 5, 6, 7, 8]);
    expect(ring.copyTail(new Float64Array(2), 4)).toBe(2);
    expect(ring.copyTail(scratch, 0)).toBe(0);
    expect(ring.copyTail(scratch, -3)).toBe(0);
    expect(new RingBuffer(4).copyTail(scratch, 2)).toBe(0);
  });

  it("store rings wrap after capacity batches", () => {
    const { applyTelemetry } = useFleetStore.getState();
    for (let i = 0; i < TELEMETRY_RING_CAPACITY + 50; i += 1) {
      applyTelemetry(telemetry("N-07", i * 100));
    }
    const rings = getUnitBuffers("N-07")!;
    expect(rings.ts.length).toBe(TELEMETRY_RING_CAPACITY);
    expect(rings.ts.at(0)).toBe(50 * 100); // oldest 50 batches aged out
    expect(rings.joints.get("knee_L")!.tempC.length).toBe(TELEMETRY_RING_CAPACITY);
    expect(telemetryBatchCount()).toBe(TELEMETRY_RING_CAPACITY + 50);
    expect(getUnitTelemetryVersion("N-07")).toBe(TELEMETRY_RING_CAPACITY + 50);
  });
});

describe("fleet store — batching (PRD §7)", () => {
  it("a pure-telemetry batch is zero zustand commits and one per-unit notification", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    let commits = 0;
    let n07 = 0;
    let n01 = 0;
    const unsubStore = useFleetStore.subscribe(() => {
      commits += 1;
    });
    const unsubN07 = subscribeUnitTelemetry("N-07", () => {
      n07 += 1;
    });
    const unsubN01 = subscribeUnitTelemetry("N-01", () => {
      n01 += 1;
    });
    // Six points, one batch: the rings take six pushes, the channel wakes
    // N-07's subscribers once, and zustand hears nothing — the battery is
    // the snapshot's figure and nothing is trending.
    useFleetStore.getState().applyTelemetry(telemetry("N-07", 100, 70));
    expect(commits).toBe(0);
    expect(n07).toBe(1);
    expect(n01).toBe(0);

    const rings = getUnitBuffers("N-07")!;
    expect(rings.joints.size).toBe(6);
    expect(rings.joints.get("knee_L")!.tempC.length).toBe(1);
    expect(rings.battery.length).toBe(1);
    unsubStore();
    unsubN07();
    unsubN01();
  });

  it("a unit's batch does not disturb another unit's values or summary identity", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    useFleetStore.getState().applyTelemetry(telemetry("N-01", 100, 90));

    const n07Version = getUnitTelemetryVersion("N-07");
    const n07Unit = selectUnit("N-07")(useFleetStore.getState());
    const n07Battery = batteryOf("N-07");

    useFleetStore.getState().applyTelemetry(telemetry("N-01", 200, 89.9));

    // Object.is-equal reads == the per-unit hooks skip the re-render
    expect(getUnitTelemetryVersion("N-07")).toBe(n07Version);
    expect(selectUnit("N-07")(useFleetStore.getState())).toBe(n07Unit);
    expect(batteryOf("N-07")).toBe(n07Battery);
    // while N-01 moved
    expect(getUnitTelemetryVersion("N-01")).toBe(2);
    expect(batteryOf("N-01")).toBe(89.9);
  });

  it("quantizes battery to 0.1 %: the value holds until the rounded figure moves", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    useFleetStore.getState().applyTelemetry(telemetry("N-01", 100, 90.04));
    expect(getUnitBattery("N-01")).toBe(90);

    useFleetStore.getState().applyTelemetry(telemetry("N-01", 200, 90.02)); // rounds to 90.0 again
    expect(getUnitBattery("N-01")).toBe(90);

    useFleetStore.getState().applyTelemetry(telemetry("N-01", 300, 89.9)); // the VALUE moves
    expect(getUnitBattery("N-01")).toBe(89.9);
  });

  it("a quiet batch bumps the unit's version and commits nothing", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    useFleetStore.getState().applyTelemetry(telemetry("N-07", 61_100, 70));
    const s1 = useFleetStore.getState();

    let commits = 0;
    const unsub = useFleetStore.subscribe(() => {
      commits += 1;
    });
    // A "quiet" batch: same rounded battery, same contact second — the version
    // bump is the only thing it changes, and a version is not reactive state.
    useFleetStore.getState().applyTelemetry(telemetry("N-07", 61_200, 70));
    unsub();

    expect(commits).toBe(0);
    expect(useFleetStore.getState()).toBe(s1); // not even a top-level identity change
    expect(getUnitTelemetryVersion("N-07")).toBe(2);
    expect(getUnitTelemetryVersion("N-01")).toBe(0);
  });

  it("commits only when a reactive fact moves: the rounded fleet average", () => {
    useFleetStore.getState().applySnapshot(snapshot); // avg (90 + 70) / 2 = 80
    let commits = 0;
    const unsub = useFleetStore.subscribe(() => {
      commits += 1;
    });
    useFleetStore.getState().applyTelemetry(telemetry("N-01", 100, 89.9)); // 79.95 → still 80
    expect(commits).toBe(0);
    useFleetStore.getState().applyTelemetry(telemetry("N-01", 200, 50)); // 60
    expect(commits).toBe(1);
    unsub();
    expect(selectKpiAvgBattery(useFleetStore.getState())).toBe(60);
  });

  it("reset empties the channel — a fresh run cannot inherit counters or primitives", () => {
    useFleetStore.getState().applyTelemetry(telemetry("N-07", 100));
    expect(getUnitTelemetryVersion("N-07")).toBe(1);

    useFleetStore.getState().reset();
    expect(getUnitTelemetryVersion("N-07")).toBe(0);
    expect(getUnitBattery("N-07")).toBeUndefined();
    expect(getUnitLastContact("N-07")).toBeUndefined();
    expect(telemetryBatchCount()).toBe(0);

    useFleetStore.getState().applyTelemetry(telemetry("N-07", 200));
    expect(getUnitTelemetryVersion("N-07")).toBe(1);
  });
});

describe("fleet store — last contact (1 s quantization)", () => {
  it("is undefined until the unit's first batch, then the batch second", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    expect(getUnitLastContact("N-07")).toBeUndefined();

    useFleetStore.getState().applyTelemetry(telemetry("N-07", 61_234));
    expect(getUnitLastContact("N-07")).toBe(61_000);
    expect(getUnitLastContact("N-01")).toBeUndefined();
  });

  it("moves only on the second boundary", () => {
    useFleetStore.getState().applyTelemetry(telemetry("N-07", 61_000));

    // nine more batches of the same second: the value holds still
    for (let ts = 61_100; ts < 62_000; ts += 100) {
      useFleetStore.getState().applyTelemetry(telemetry("N-07", ts));
    }
    expect(getUnitLastContact("N-07")).toBe(61_000);

    // first batch of the next second: the quantized VALUE moves
    useFleetStore.getState().applyTelemetry(telemetry("N-07", 62_000));
    expect(getUnitLastContact("N-07")).toBe(62_000);
  });

  it("last-contact subscribers re-render at most once per second (every batch still notifies)", () => {
    useFleetStore.getState().applyTelemetry(telemetry("N-07", 61_000));

    // What `useUnitLastContact` does per notification: re-read the value,
    // bail on Object.is. Count both the notifications and the survivors.
    let notifications = 0;
    let renders = 0;
    let lastSeen = getUnitLastContact("N-07");
    const unsub = subscribeUnitTelemetry("N-07", () => {
      notifications += 1;
      const v = getUnitLastContact("N-07");
      if (!Object.is(v, lastSeen)) {
        lastSeen = v;
        renders += 1;
      }
    });
    // nineteen batches spanning one second boundary (61.1 s … 62.9 s)
    for (let ts = 61_100; ts <= 62_900; ts += 100) {
      useFleetStore.getState().applyTelemetry(telemetry("N-07", ts));
    }
    unsub();

    expect(notifications).toBe(19); // one honest notification per batch
    expect(renders).toBe(1); // exactly one value move: 61_000 → 62_000
    expect(lastSeen).toBe(62_000);
  });

  it("a fresh snapshot clears last contact and battery (telemetry repopulates them)", () => {
    useFleetStore.getState().applyTelemetry(telemetry("N-07", 61_000, 55));
    let woke = 0;
    const unsub = subscribeUnitTelemetry("N-07", () => {
      woke += 1;
    });
    useFleetStore.getState().applySnapshot(snapshot); // RESET_SIM broadcast
    unsub();
    expect(woke).toBe(1); // the restatement wakes the unit's hooks once
    expect(getUnitLastContact("N-07")).toBeUndefined();
    expect(getUnitBattery("N-07")).toBeUndefined();
    expect(batteryOf("N-07")).toBe(70); // back to the snapshot's figure
    expect(getUnitTelemetryVersion("N-07")).toBe(1); // the canvases keep their counter
  });
});

describe("fleet store — kpiAvgBattery in O(1) on telemetry", () => {
  it("tracks battery moves exactly as a full recompute would", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    expect(selectKpiAvgBattery(useFleetStore.getState())).toBe(80); // (90 + 70) / 2

    useFleetStore.getState().applyTelemetry(telemetry("N-01", 100, 50));
    expect(selectKpiAvgBattery(useFleetStore.getState())).toBe(60); // (50 + 70) / 2

    useFleetStore.getState().applyTelemetry(telemetry("N-07", 100, 79.96)); // rounds to 80
    expect(selectKpiAvgBattery(useFleetStore.getState())).toBe(65); // (50 + 80) / 2
  });

  it("leaves the KPI untouched when a 0.1 % move cannot shift the rounded average", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    const before = selectKpiAvgBattery(useFleetStore.getState()); // 80

    useFleetStore.getState().applyTelemetry(telemetry("N-01", 100, 89.9));
    const s = useFleetStore.getState();
    // (89.9 + 70) / 2 = 79.95 → still rounds to 80: the KPI value holds, so
    // nothing commits — while the unit's own battery moved in the channel.
    expect(selectKpiAvgBattery(s)).toBe(before);
    expect(batteryOf("N-01")).toBe(89.9);
  });

  it("records batteries for units outside the snapshot without counting them", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    useFleetStore.getState().applyTelemetry(telemetry("N-99", 100, 10));
    const s = useFleetStore.getState();
    expect(batteryOf("N-99")).toBe(10);
    expect(selectKpiAvgBattery(s)).toBe(80); // the fleet average counts snapshot units only
  });

  it("stays consistent across the full-recompute paths (alert, snapshot)", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    useFleetStore.getState().applyTelemetry(telemetry("N-01", 100, 50)); // avg 60

    // applyAlert recomputes KPIs from the records — same average, and the
    // re-seeded running sum keeps the next incremental move exact
    useFleetStore.getState().applyAlert(amberAlert);
    expect(selectKpiAvgBattery(useFleetStore.getState())).toBe(60);
    useFleetStore.getState().applyTelemetry(telemetry("N-07", 100, 30));
    expect(selectKpiAvgBattery(useFleetStore.getState())).toBe(40); // (50 + 30) / 2

    // a fresh snapshot restates the world: back to snapshot batteries
    useFleetStore.getState().applySnapshot(snapshot);
    expect(selectKpiAvgBattery(useFleetStore.getState())).toBe(80);
    useFleetStore.getState().applyTelemetry(telemetry("N-01", 100, 70));
    expect(selectKpiAvgBattery(useFleetStore.getState())).toBe(70); // (70 + 70) / 2
  });
});

describe("fleet store — snapshot, alerts, kpis", () => {
  it("applySnapshot populates units, order, and KPIs", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    const s = useFleetStore.getState();
    expect(s.unitIds).toEqual(["N-01", "N-07"]);
    expect(selectUnit("N-07")(s)?.name).toBe("Sagebrush House");
    expect(selectKpiNominal(s)).toBe(2);
    expect(selectKpiAlerts(s)).toBe(0);
    expect(selectKpiAvgBattery(s)).toBe(80); // (90 + 70) / 2
  });

  it("applyAlert prepends, flips the unit status, updates KPIs, and dedupes by id", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    useFleetStore.getState().applyAlert(amberAlert);

    let s = useFleetStore.getState();
    expect(s.alerts.map((a) => a.id)).toEqual(["al-001"]);
    expect(selectUnit("N-07")(s)?.status).toBe("amber");
    expect(selectUnit("N-01")(s)?.status).toBe("nominal");
    expect(selectKpiNominal(s)).toBe(1);
    expect(selectKpiAlerts(s)).toBe(1);

    useFleetStore.getState().applyAlert(amberAlert); // replayed duplicate
    s = useFleetStore.getState();
    expect(s.alerts).toHaveLength(1);

    const red: AlertMessage = {
      t: "alert",
      alert: { ...amberAlert.alert, id: "al-002", severity: "red", ts: 72_000 },
    };
    useFleetStore.getState().applyAlert(red);
    s = useFleetStore.getState();
    expect(s.alerts.map((a) => a.id)).toEqual(["al-002", "al-001"]); // newest first
    expect(selectUnit("N-07")(s)?.status).toBe("red");
    // kpiAlerts counts alerted UNITS, not events: amber + red on N-07 is 1
    expect(selectKpiAlerts(s)).toBe(1);
  });

  it("kpiAlerts counts units with active alerts, not alert events", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    useFleetStore.getState().applyAlert(amberAlert);
    useFleetStore.getState().applyAlert({
      t: "alert",
      alert: { ...amberAlert.alert, id: "al-002", severity: "red", ts: 72_000 },
    });
    let s = useFleetStore.getState();
    expect(s.alerts).toHaveLength(2); // the feed keeps its event count
    expect(selectKpiAlerts(s)).toBe(1); // one troubled unit

    useFleetStore.getState().applyAlert({
      t: "alert",
      alert: {
        id: "al-003",
        unitId: "N-01",
        severity: "amber",
        message: "Cedar Row: battery below threshold",
        ts: 80_000,
      },
    });
    s = useFleetStore.getState();
    expect(s.alerts).toHaveLength(3);
    expect(selectKpiAlerts(s)).toBe(2); // second unit joins the count
  });

  it("an alert changes only the alerted unit's summary identity", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    const before = selectUnit("N-01")(useFleetStore.getState());
    useFleetStore.getState().applyAlert(amberAlert);
    expect(selectUnit("N-01")(useFleetStore.getState())).toBe(before);
  });

  it("a fresh snapshot clears the alert feed (server replays active ones)", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    useFleetStore.getState().applyAlert(amberAlert);
    useFleetStore.getState().applySnapshot(snapshot); // RESET_SIM broadcast
    const s = useFleetStore.getState();
    expect(s.alerts).toEqual([]);
    expect(selectUnit("N-07")(s)?.status).toBe("nominal");
  });

  it("marks the seam between runs: a snapshot records where each ring's history ends", () => {
    const s = () => useFleetStore.getState();
    s().applySnapshot(snapshot);
    // Nothing has reported in, so there is no seam to mark yet.
    expect(s().telemetryEpochTs).toEqual({});

    s().applyTelemetry(telemetry("N-07", 100));
    s().applyTelemetry(telemetry("N-07", 200));
    s().applyTelemetry(telemetry("N-01", 150));
    const before = s().telemetryEpochTs;
    // …but telemetry is not a restatement: the seam only moves on a snapshot.
    expect(before).toEqual({});

    s().applySnapshot(snapshot); // RESET_SIM: the storyline replays from the top
    // The rings deliberately survive it (the charts draw across the seam), so
    // what a re-runnable storyline needs is a record of where the last run
    // ended — per unit, at its own newest sample.
    expect(s().telemetryEpochTs).toEqual({ "N-07": 200, "N-01": 150 });
    expect(getUnitBuffers("N-07")?.ts.length).toBe(2);
    // Replaced, not mutated in place: the new identity is the signal
    // derivations key their own reset on (trendWatch.ts).
    expect(s().telemetryEpochTs).not.toBe(before);
  });

  it("reset clears state and ring buffers", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    useFleetStore.getState().applyTelemetry(telemetry("N-07", 100));
    useFleetStore.getState().reset();
    expect(useFleetStore.getState().telemetryEpochTs).toEqual({});
    expect(useFleetStore.getState().unitIds).toEqual([]);
    expect(telemetryBatchCount()).toBe(0);
    expect(getUnitBuffers("N-07")).toBeUndefined();
  });
});

describe("fleet store — unit_update (posture reaches a live client)", () => {
  /** N-07 as the settle beat would restate it: same summary, posture flipped. */
  const seated = (posture: "walking" | "sitting" = "sitting"): UnitUpdateMessage => ({
    t: "unit_update",
    unit: {
      id: "N-07",
      name: "Sagebrush House",
      status: "nominal",
      battery: 70,
      pos: { lat: 44.05, lng: -121.28 },
      posture,
    },
  });

  it("replaces only that unit's entry: posture flips live, the rest of the fleet keeps identity", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    const before = useFleetStore.getState();
    const untouched = selectUnit("N-01")(before);

    useFleetStore.getState().applyUnitUpdate(seated());
    const s = useFleetStore.getState();
    expect(selectUnit("N-07")(s)?.posture).toBe("sitting");
    expect(selectUnit("N-01")(s)).toBe(untouched);
    expect(s.unitIds).toEqual(before.unitIds); // the snapshot owns row order
  });

  it("is idempotent: a content-equal restatement changes nothing, not even identity", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    useFleetStore.getState().applyUnitUpdate(seated());
    const before = useFleetStore.getState();
    useFleetStore.getState().applyUnitUpdate(seated()); // duplicate delivery
    expect(useFleetStore.getState()).toBe(before); // zero commits, zero re-renders
  });

  it("ignores an id the snapshot never introduced", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    const before = useFleetStore.getState();
    useFleetStore.getState().applyUnitUpdate({
      t: "unit_update",
      unit: {
        id: "N-99",
        name: "Ghost House",
        status: "nominal",
        battery: 50,
        pos: { lat: 44, lng: -121 },
        posture: "sitting",
      },
    });
    expect(useFleetStore.getState()).toBe(before);
  });

  it("recomputes KPIs when the restatement moves status — it is a general unit restatement", () => {
    useFleetStore.getState().applySnapshot(snapshot);
    expect(selectKpiNominal(useFleetStore.getState())).toBe(2);
    useFleetStore.getState().applyUnitUpdate({
      t: "unit_update",
      unit: { ...seated().unit, status: "red" },
    });
    const s = useFleetStore.getState();
    expect(selectKpiNominal(s)).toBe(1);
    expect(selectKpiAvgBattery(s)).toBe(80); // battery unchanged: (90 + 70) / 2
  });
});

describe("fleet store — unit_update carries firmware ( amendment)", () => {
  // The regression this block pins: the content-equality short-circuit once
  // compared everything EXCEPT fw/fwPending, so a firmware-only restatement
  // was dropped as "unchanged" and landed only when battery happened to drift
  // in the same message. Both reachable paths get a test, plus the guard that
  // the fix does not over-fire.
  const fwSnapshot: FleetSnapshotMessage = {
    t: "fleet_snapshot",
    units: [
      {
        id: "N-02",
        name: "Maple Hollow",
        status: "nominal",
        battery: 84,
        pos: { lat: 44.04, lng: -121.29 },
        posture: "walking",
        fw: "2.4.1",
      },
      {
        id: "N-05",
        name: "Orchard Lane",
        status: "nominal",
        battery: 77,
        pos: { lat: 44.04, lng: -121.32 },
        posture: "walking",
        fw: "2.3.7",
        fwPending: "2.4.1",
      },
    ],
  };
  const restated = (unit: UnitUpdateMessage["unit"]): UnitUpdateMessage => ({
    t: "unit_update",
    unit,
  });

  it("lands a firmware-ONLY restatement — the rollback of a unit whose alert never raised", () => {
    useFleetStore.getState().applySnapshot(fwSnapshot);
    const before = selectUnit("N-02")(useFleetStore.getState())!;
    useFleetStore.getState().applyUnitUpdate(restated({ ...before, fw: "2.3.7" }));
    const after = selectUnit("N-02")(useFleetStore.getState());
    expect(after?.fw).toBe("2.3.7");
    expect(after).not.toBe(before); // the entry moved: subscribers wake
  });

  it("lands an fwPending-ONLY clear — HALT_ROLLOUT's visible save", () => {
    useFleetStore.getState().applySnapshot(fwSnapshot);
    const before = selectUnit("N-05")(useFleetStore.getState())!;
    expect(before.fwPending).toBe("2.4.1");
    const saved = { ...before };
    delete saved.fwPending; // the halt's restatement: identical but for the badge
    useFleetStore.getState().applyUnitUpdate(restated(saved));
    const after = selectUnit("N-05")(useFleetStore.getState());
    expect(after?.fw).toBe("2.3.7"); // still the baseline — that IS the save
    expect(after?.fwPending).toBeUndefined();
    expect(after).not.toBe(before);
  });

  it("still short-circuits a content-identical restatement, firmware fields included: zero commits", () => {
    useFleetStore.getState().applySnapshot(fwSnapshot);
    const before = useFleetStore.getState();
    // fresh objects, equal content — fw and fwPending equal too
    useFleetStore
      .getState()
      .applyUnitUpdate(restated({ ...selectUnit("N-05")(before)! }));
    useFleetStore
      .getState()
      .applyUnitUpdate(restated({ ...selectUnit("N-02")(before)! }));
    expect(useFleetStore.getState()).toBe(before); // zero commits, zero re-renders
  });
});

describe("alert lifecycle", () => {
  const redAlert: AlertMessage = {
    t: "alert",
    alert: {
      id: "al-002",
      unitId: "N-07",
      severity: "red",
      message: "Sagebrush House: left knee actuator overheating, torque ripple detected",
      ts: 72_000,
    },
  };

  beforeEach(() => {
    useAuditStore.getState().reset();
    useFleetStore.getState().applySnapshot(snapshot);
  });

  it("acks an alert once, with operator attribution and an audit entry", () => {
    useFleetStore.getState().applyAlert(amberAlert);
    useFleetStore.getState().ackAlert("al-001");
    const meta = selectAlertMeta("al-001")(useFleetStore.getState());
    expect(meta?.ackedBy).toBe("Operator");
    expect(meta?.ackedAt).toBeTypeOf("number");

    // idempotent: a second ack changes nothing, logs nothing
    const before = useFleetStore.getState().alertMeta;
    useFleetStore.getState().ackAlert("al-001", "Someone Else");
    expect(useFleetStore.getState().alertMeta).toBe(before);
    const acks = useAuditStore.getState().entries.filter((e) => e.kind === "alert-acked");
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({
      unitId: "N-07",
      summary: "Acknowledged by Operator",
      ref: "al-001",
    });
  });

  it("ignores acks and resolutions for unknown alert ids", () => {
    useFleetStore.getState().ackAlert("al-999");
    useFleetStore.getState().resolveAlert("al-999", { via: "operator" });
    expect(useFleetStore.getState().alertMeta).toEqual({});
    expect(useAuditStore.getState().entries).toHaveLength(0);
  });

  it("resolves with linkage to what closed it, keeping the alert in the feed", () => {
    useFleetStore.getState().applyAlert(amberAlert);
    useFleetStore
      .getState()
      .resolveAlert("al-001", { via: "safe-sit", ref: "COMMAND_SAFE_SIT#1" });
    const meta = selectAlertMeta("al-001")(useFleetStore.getState());
    expect(meta?.resolvedAt).toBeTypeOf("number");
    expect(meta?.resolution).toEqual({ via: "safe-sit", ref: "COMMAND_SAFE_SIT#1" });
    expect(useFleetStore.getState().alerts).toHaveLength(1); // the wire owns the feed

    const res = useAuditStore.getState().entries.find((e) => e.kind === "resolution");
    expect(res).toMatchObject({
      unitId: "N-07",
      summary: "Resolved — unit commanded to safe sit",
      ref: "al-001",
    });
  });

  it("audits raises, and a red-after-amber as an escalation", () => {
    useFleetStore.getState().applyAlert(amberAlert);
    useFleetStore.getState().applyAlert(redAlert);
    const kinds = useAuditStore.getState().entries.map((e) => e.kind);
    expect(kinds).toEqual(["escalation", "alert-raised", "alert-raised"]); // newest first
    const esc = useAuditStore.getState().entries[0]!;
    expect(esc).toMatchObject({
      unitId: "N-07",
      summary: "Escalated amber → red",
      ref: "al-002",
      ts: 72_000,
    });
  });

  it("does not double-log replayed alerts after a snapshot cleared the feed", () => {
    useFleetStore.getState().applyAlert(amberAlert);
    useFleetStore.getState().applyAlert(redAlert);
    useFleetStore.getState().applySnapshot(snapshot); // reconnect
    useFleetStore.getState().applyAlert(amberAlert); // server replays the run's alerts
    useFleetStore.getState().applyAlert(redAlert);
    const entries = useAuditStore.getState().entries;
    expect(entries.filter((e) => e.kind === "alert-raised")).toHaveLength(2);
    expect(entries.filter((e) => e.kind === "escalation")).toHaveLength(1);
    // and the ack survived the snapshot (alertMeta is session-scoped)
    useFleetStore.getState().ackAlert("al-001");
    useFleetStore.getState().applySnapshot(snapshot);
    expect(selectAlertMeta("al-001")(useFleetStore.getState())?.ackedAt).toBeDefined();
  });

  it("resolving a unit's only alert drops it from kpiAlerts; feed and badge keep it", () => {
    useFleetStore.getState().applyAlert(amberAlert);
    expect(selectKpiAlerts(useFleetStore.getState())).toBe(1);

    useFleetStore.getState().resolveAlert("al-001", { via: "operator" });
    const s = useFleetStore.getState();
    expect(selectKpiAlerts(s)).toBe(0); // no longer alerting
    expect(s.alerts).toHaveLength(1); // the feed is audit truth — row stays
    expect(selectUnit("N-07")(s)?.status).toBe("amber"); // condition persists until reset
  });

  it("an ack alone leaves kpiAlerts unchanged — acked is owned, not closed", () => {
    useFleetStore.getState().applyAlert(amberAlert);
    useFleetStore.getState().ackAlert("al-001");
    expect(selectKpiAlerts(useFleetStore.getState())).toBe(1);
  });

  it("an escalated pair resolved together drops the unit from kpiAlerts once", () => {
    useFleetStore.getState().applyAlert(amberAlert);
    useFleetStore.getState().applyAlert(redAlert);
    expect(selectKpiAlerts(useFleetStore.getState())).toBe(1); // one troubled unit

    useFleetStore.getState().resolveAlert("al-001", { via: "operator" });
    // The red still stands: the unit is still alerting.
    expect(selectKpiAlerts(useFleetStore.getState())).toBe(1);

    useFleetStore.getState().resolveAlert("al-002", { via: "operator" });
    expect(selectKpiAlerts(useFleetStore.getState())).toBe(0); // drops exactly once
  });

  it("a fresh alert after resolution counts the unit as alerting again", () => {
    useFleetStore.getState().applyAlert(amberAlert);
    useFleetStore.getState().resolveAlert("al-001", { via: "operator" });
    expect(selectKpiAlerts(useFleetStore.getState())).toBe(0);

    useFleetStore.getState().applyAlert({
      t: "alert",
      alert: { ...amberAlert.alert, id: "al-010", ts: 90_000 },
    });
    // The resolved al-001 stays resolved; the new alert alone carries the count.
    expect(selectKpiAlerts(useFleetStore.getState())).toBe(1);
  });

  it("derives firstRaisedAt per unit from the oldest active alert", () => {
    const s = () => useFleetStore.getState();
    expect(selectUnitFirstRaisedAt("N-07")(s())).toBeUndefined();
    s().applyAlert(amberAlert); // ts 58_000
    s().applyAlert(redAlert); // ts 72_000
    expect(selectUnitFirstRaisedAt("N-07")(s())).toBe(58_000);
    expect(selectUnitFirstRaisedAt("N-01")(s())).toBeUndefined();
    s().applySnapshot(snapshot); // RESET_SIM: trouble over, duration anchor gone
    expect(selectUnitFirstRaisedAt("N-07")(s())).toBeUndefined();
  });
});
