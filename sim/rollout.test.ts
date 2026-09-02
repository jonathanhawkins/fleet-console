// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  fleetMessageSchema,
  type AlertClearMessage,
  type AlertMessage,
  type FleetCommandEventMessage,
  type FleetMessage,
  type UnitUpdateMessage,
} from "@/lib/schema";
import {
  COHORT_ALERT_MESSAGE,
  createSimEngine,
  DEFAULT_COHORT_TIMELINE,
  DEFAULT_NAV_TIMELINE,
  DEFAULT_TIMELINE,
  FW_ROLLOUT,
  FW_STABLE,
  PENDING_UNIT_ID,
  ROLLOUT_REFUSAL_NO_ROLLOUT_ACTIVE,
  ROLLOUT_REFUSAL_ROLLBACK_IN_PROGRESS,
  ROLLOUT_UNIT_IDS,
  type CohortTimeline,
  type SimEngine,
} from "./engine";

/**
 * the firmware rollout cohort — the fleet-wide storyline. Version
 * distribution on the wire, the staggered identical-signature ambers, the
 * queued fifth install and the HALT_ROLLOUT save, the staged serial
 * ROLLBACK_COHORT (per-unit note → unit_update → alert_clear), machine-voice
 * refusals, three storylines coexisting in one session, RESET restoration,
 * late-joiner replay, determinism.
 */

/** N-07 and N-03 parked far beyond every window below: the cohort speaks alone. */
const QUIET = {
  timeline: { onsetMs: 600_000, amberAtMs: 700_000, redAtMs: 800_000 },
  navTimeline: { blockAtMs: 600_000, clearAtMs: 700_000 },
};

/**
 * Cohort beats compressed, every one a multiple of the 50 ms step: raises at
 * 1000/1200/1400/1600, queued install at 3000 (its late alert at 3200),
 * rollback 400 ms per unit.
 */
const FAST_COHORT: CohortTimeline = {
  onsetMs: 1_000,
  staggerMs: 200,
  pendingAtMs: 3_000,
  rollbackPerUnitMs: 400,
};
const STEP_MS = 50;

const isAlert = (m: FleetMessage): m is AlertMessage => m.t === "alert";
const isClear = (m: FleetMessage): m is AlertClearMessage => m.t === "alert_clear";
const isUnitUpdate = (m: FleetMessage): m is UnitUpdateMessage => m.t === "unit_update";
const isFleetEvent = (m: FleetMessage): m is FleetCommandEventMessage =>
  m.t === "fleet_command_event";

interface Arrival {
  t: number;
  msg: FleetMessage;
}

function stepDrain(
  engine: SimEngine,
  fromMs: number,
  toMs: number,
  stepMs = STEP_MS,
): Arrival[] {
  const arrivals: Arrival[] = [];
  for (let t = fromMs + stepMs; t <= toMs; t += stepMs) {
    for (const msg of engine.advance(t)) arrivals.push({ t, msg });
  }
  return arrivals;
}

const cohortEngine = () => createSimEngine({ ...QUIET, cohortTimeline: FAST_COHORT });

const unitOf = (engine: SimEngine, id: string) =>
  engine.snapshot().units.find((u) => u.id === id)!;

describe("rollout — firmware distribution on the wire", () => {
  it("has demo pacing by default: cohort after the knee and nav windows, install at onset + 90 s", () => {
    expect(DEFAULT_COHORT_TIMELINE.onsetMs).toBe(180_000);
    expect(DEFAULT_COHORT_TIMELINE.onsetMs).toBeGreaterThan(DEFAULT_TIMELINE.redAtMs);
    expect(DEFAULT_COHORT_TIMELINE.onsetMs).toBeGreaterThan(
      DEFAULT_NAV_TIMELINE.clearAtMs,
    );
    // four raises span ~30 s of stagger
    expect(DEFAULT_COHORT_TIMELINE.staggerMs * (ROLLOUT_UNIT_IDS.length - 1)).toBe(
      30_000,
    );
    expect(DEFAULT_COHORT_TIMELINE.pendingAtMs).toBe(
      DEFAULT_COHORT_TIMELINE.onsetMs + 90_000,
    );
    expect(DEFAULT_COHORT_TIMELINE.rollbackPerUnitMs).toBe(4_000);
  });

  it("snapshots the 4/4 split: rollout four on 2.4.1, the rest on 2.3.7, N-05 visibly queued", () => {
    const snap = createSimEngine().snapshot();
    expect(() => fleetMessageSchema.parse(snap)).not.toThrow();
    for (const u of snap.units) {
      if (ROLLOUT_UNIT_IDS.includes(u.id)) {
        expect(u.fw).toBe(FW_ROLLOUT);
        expect(u.fwPending).toBeUndefined();
      } else {
        expect(u.fw).toBe(FW_STABLE);
        expect(u.fwPending).toBe(u.id === PENDING_UNIT_ID ? FW_ROLLOUT : undefined);
      }
    }
    // the storyline units stay on the baseline — the canary must read clean
    expect(ROLLOUT_UNIT_IDS).not.toContain("N-07");
    expect(ROLLOUT_UNIT_IDS).not.toContain("N-03");
    expect(PENDING_UNIT_ID).not.toBe("N-07");
  });

  it("keeps generated units on the baseline: the rollout wave touched only the named fleet", () => {
    const snap = createSimEngine({ unitCount: 20 }).snapshot();
    for (const u of snap.units.slice(8)) {
      expect(u.fw).toBe(FW_STABLE);
      expect(u.fwPending).toBeUndefined();
    }
  });
});

describe("rollout — the staggered cohort signature", () => {
  it("raises one amber per rollout unit at onset + i·stagger, message byte-identical, ids distinct", () => {
    const engine = cohortEngine();
    const arrivals = stepDrain(engine, 0, 2_000);
    for (const a of arrivals) expect(() => fleetMessageSchema.parse(a.msg)).not.toThrow();

    const alerts = arrivals.filter((a) => isAlert(a.msg)) as Array<{
      t: number;
      msg: AlertMessage;
    }>;
    expect(alerts.map((a) => a.msg.alert.unitId)).toEqual([...ROLLOUT_UNIT_IDS]);
    expect(alerts.map((a) => a.t)).toEqual([1_000, 1_200, 1_400, 1_600]);
    expect(alerts.map((a) => a.msg.alert.ts)).toEqual([1_000, 1_200, 1_400, 1_600]);
    for (const a of alerts) {
      expect(a.msg.alert.severity).toBe("amber");
      // deliberately NOT name-prefixed: the identical string IS the signature
      expect(a.msg.alert.message).toBe(COHORT_ALERT_MESSAGE);
    }
    expect(new Set(alerts.map((a) => a.msg.alert.id)).size).toBe(4);

    // statuses flipped amber; everyone else untouched
    const snap = engine.snapshot();
    for (const u of snap.units) {
      expect(u.status).toBe(ROLLOUT_UNIT_IDS.includes(u.id) ? "amber" : "nominal");
    }
  });

  it("lands the queued install at pendingAtMs — fw flips via unit_update — and the late fifth alert one stagger later", () => {
    const engine = cohortEngine();
    const arrivals = stepDrain(engine, 0, FAST_COHORT.pendingAtMs);

    const updates = arrivals.filter((a) => isUnitUpdate(a.msg)) as Array<{
      t: number;
      msg: UnitUpdateMessage;
    }>;
    expect(updates).toHaveLength(1);
    expect(updates[0]!.t).toBe(FAST_COHORT.pendingAtMs);
    expect(updates[0]!.msg.unit).toMatchObject({ id: PENDING_UNIT_ID, fw: FW_ROLLOUT });
    expect(updates[0]!.msg.unit.fwPending).toBeUndefined();
    // the restatement says exactly what the snapshot says at its instant
    expect(updates[0]!.msg.unit).toEqual(unitOf(engine, PENDING_UNIT_ID));

    arrivals.push(...stepDrain(engine, FAST_COHORT.pendingAtMs, 3_500));
    const alerts = arrivals.filter((a) => isAlert(a.msg)) as Array<{
      t: number;
      msg: AlertMessage;
    }>;
    expect(alerts).toHaveLength(5);
    const late = alerts.at(-1)!;
    expect(late.t).toBe(FAST_COHORT.pendingAtMs + FAST_COHORT.staggerMs);
    expect(late.msg.alert).toMatchObject({
      unitId: PENDING_UNIT_ID,
      severity: "amber",
      message: COHORT_ALERT_MESSAGE,
    });
    expect(unitOf(engine, PENDING_UNIT_ID).status).toBe("amber");
  });

  it("honors every cohort beat across a long catch-up gap, in order", () => {
    const engine = cohortEngine();
    const msgs = engine.advance(60_000); // 600 slots >> catch-up cap
    const alerts = msgs.filter(isAlert);
    expect(alerts.map((m) => m.alert.unitId)).toEqual([
      ...ROLLOUT_UNIT_IDS,
      PENDING_UNIT_ID,
    ]);
    const upgradeIdx = msgs.findIndex(isUnitUpdate);
    const lateAlertIdx = msgs.findIndex(
      (m) => isAlert(m) && m.alert.unitId === PENDING_UNIT_ID,
    );
    expect(upgradeIdx).toBeGreaterThanOrEqual(0);
    expect(upgradeIdx).toBeLessThan(lateAlertIdx);
    expect(unitOf(engine, PENDING_UNIT_ID).fw).toBe(FW_ROLLOUT);
  });
});

describe("HALT_ROLLOUT — the save", () => {
  it("answers synchronously: accepted, the receipt note, the queued unit's restatement, complete", () => {
    const engine = cohortEngine();
    stepDrain(engine, 0, 2_500); // four ambers in; install still 500 ms out
    const out = engine.handle({ c: "HALT_ROLLOUT" });
    for (const m of out) expect(() => fleetMessageSchema.parse(m)).not.toThrow();

    expect(out.map((m) => m.t)).toEqual([
      "fleet_command_event",
      "fleet_command_event",
      "unit_update",
      "fleet_command_event",
    ]);
    const events = out.filter(isFleetEvent);
    expect(events.map((m) => m.ev.k)).toEqual(["accepted", "progress", "complete"]);
    for (const ev of events) {
      expect(ev.cmd).toBe("HALT_ROLLOUT");
      expect(ev.fw).toBe(FW_ROLLOUT);
      expect(ev.ts).toBe(2_500);
    }
    // seqs strictly ascend within the fleet lane
    expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq);
    expect(events[2]!.seq).toBeGreaterThan(events[1]!.seq);

    // the receipt: the demonstrable non-event, in machine voice
    const progress = events[1]!.ev;
    if (progress.k !== "progress") throw new Error("expected the receipt note");
    expect(progress.pct).toBe(100);
    expect(progress.note).toBe(
      `ROLLOUT HALTED — ${PENDING_UNIT_ID} REMAINS ON ${FW_STABLE}`,
    );

    // the restatement drops fwPending and matches the snapshot exactly
    const update = out.find(isUnitUpdate)!;
    expect(update.unit.id).toBe(PENDING_UNIT_ID);
    expect(update.unit.fw).toBe(FW_STABLE);
    expect(update.unit.fwPending).toBeUndefined();
    expect(update.unit).toEqual(unitOf(engine, PENDING_UNIT_ID));
  });

  it("saves the fifth unit: no install at pendingAtMs, no late alert, fw stays the baseline", () => {
    const engine = cohortEngine();
    stepDrain(engine, 0, 2_500);
    engine.handle({ c: "HALT_ROLLOUT" });
    const after = stepDrain(engine, 2_500, 4_000);

    expect(after.filter((a) => isUnitUpdate(a.msg))).toHaveLength(0);
    expect(after.filter((a) => isAlert(a.msg))).toHaveLength(0);
    const u = unitOf(engine, PENDING_UNIT_ID);
    expect(u.fw).toBe(FW_STABLE);
    expect(u.fwPending).toBeUndefined();
    expect(u.status).toBe("nominal");
    // the four raised cohort alerts stay active — halting stops the spread,
    // it does not resolve the already-affected
    expect(engine.activeAlerts()).toHaveLength(4);
  });

  it("refuses a repeat with NO ROLLOUT ACTIVE — and a halt after the install landed, too", () => {
    const engine = cohortEngine();
    stepDrain(engine, 0, 2_500);
    engine.handle({ c: "HALT_ROLLOUT" });
    const repeat = engine.handle({ c: "HALT_ROLLOUT" });
    expect(repeat).toHaveLength(1);
    if (!isFleetEvent(repeat[0]!)) throw new Error("expected a fleet_command_event");
    expect(repeat[0].ev).toEqual({
      k: "failed",
      reason: ROLLOUT_REFUSAL_NO_ROLLOUT_ACTIVE,
    });

    // fresh engine, no save: the install lands at 3000, so a 3.5 s halt has
    // nothing left to halt — and the late alert still arrives (an installed
    // build is installed)
    const late = cohortEngine();
    stepDrain(late, 0, 3_500);
    const out = late.handle({ c: "HALT_ROLLOUT" });
    if (!isFleetEvent(out[0]!)) throw new Error("expected a fleet_command_event");
    expect(out[0].ev).toEqual({ k: "failed", reason: ROLLOUT_REFUSAL_NO_ROLLOUT_ACTIVE });
    expect(unitOf(late, PENDING_UNIT_ID).fw).toBe(FW_ROLLOUT);
  });
});

describe("ROLLBACK_COHORT — staged serial execution", () => {
  /** Run the storyline to 2.5 s (four ambers), halt, roll back at 3 s. */
  function rollbackRun() {
    const engine = cohortEngine();
    stepDrain(engine, 0, 2_500);
    engine.handle({ c: "HALT_ROLLOUT" });
    stepDrain(engine, 2_500, 3_000);
    const sync = engine.handle({ c: "ROLLBACK_COHORT", fw: FW_ROLLOUT });
    return { engine, sync };
  }

  it("accepts synchronously with the first unit's narration, then restores one unit per window", () => {
    const { engine, sync } = rollbackRun();
    for (const m of sync) expect(() => fleetMessageSchema.parse(m)).not.toThrow();
    expect(sync.map((m) => m.t)).toEqual(["fleet_command_event", "fleet_command_event"]);
    const [accepted, firstNote] = sync.filter(isFleetEvent);
    expect(accepted!.ev).toEqual({ k: "accepted" });
    expect(accepted!.cmd).toBe("ROLLBACK_COHORT");
    expect(accepted!.fw).toBe(FW_ROLLOUT);
    expect(firstNote!.ev).toEqual({
      k: "progress",
      pct: 0,
      note: `ROLLING BACK N-02 ${FW_ROLLOUT}->${FW_STABLE}`,
    });

    const arrivals = stepDrain(engine, 3_000, 3_000 + 4 * FAST_COHORT.rollbackPerUnitMs);
    for (const a of arrivals) expect(() => fleetMessageSchema.parse(a.msg)).not.toThrow();

    // per-unit windows: each closes with unit_update then alert_clear, and
    // the next unit's narration opens in the same drain
    const per = FAST_COHORT.rollbackPerUnitMs;
    const order = ROLLOUT_UNIT_IDS;
    order.forEach((unitId, i) => {
      const doneAt = 3_000 + (i + 1) * per;
      const atInstant = arrivals.filter((a) => a.t === doneAt).map((a) => a.msg);
      const updateIdx = atInstant.findIndex(
        (m) => isUnitUpdate(m) && m.unit.id === unitId,
      );
      const clearIdx = atInstant.findIndex((m) => isClear(m) && m.unitId === unitId);
      expect(updateIdx).toBeGreaterThanOrEqual(0);
      expect(clearIdx).toBe(updateIdx + 1); // order: restatement, then the clear
      const update = atInstant[updateIdx] as UnitUpdateMessage;
      expect(update.unit).toMatchObject({ id: unitId, fw: FW_STABLE, status: "nominal" });
      const clear = atInstant[clearIdx] as AlertClearMessage;
      expect(clear.via).toBe("rollback");
      expect(clear.ts).toBe(doneAt);

      if (i < order.length - 1) {
        const note = atInstant.find(
          (m) => isFleetEvent(m) && m.ev.k === "progress",
        ) as FleetCommandEventMessage;
        expect(note.ev).toEqual({
          k: "progress",
          pct: Math.round((100 * (i + 1)) / order.length),
          note: `ROLLING BACK ${order[i + 1]} ${FW_ROLLOUT}->${FW_STABLE}`,
        });
        expect(atInstant.indexOf(note)).toBeGreaterThan(clearIdx);
      }
    });

    // complete lands with the last unit's restoration, after its clear
    const lastInstant = arrivals.filter((a) => a.t === 3_000 + 4 * per).map((a) => a.msg);
    const complete = lastInstant.find(
      (m) => isFleetEvent(m) && m.ev.k === "complete",
    ) as FleetCommandEventMessage;
    expect(complete).toBeDefined();
    expect(complete.ts).toBe(3_000 + 4 * per);
    expect(lastInstant.indexOf(complete)).toBe(lastInstant.length - 1);

    // the fleet lane's seqs strictly ascend across the whole lifecycle
    const seqs = [
      ...sync.filter(isFleetEvent),
      ...arrivals.map((a) => a.msg).filter(isFleetEvent),
    ].map((m) => m.seq);
    for (let i = 1; i < seqs.length; i += 1)
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);

    // the world after: everyone on the baseline, nominal, no active alerts
    for (const u of engine.snapshot().units) {
      expect(u.fw).toBe(FW_STABLE);
      expect(u.status).toBe("nominal");
    }
    expect(engine.activeAlerts()).toEqual([]);
  });

  it("clears each restored unit's own cohort alert — the alertId the raise minted", () => {
    const engine = cohortEngine();
    const raised = stepDrain(engine, 0, 2_500)
      .map((a) => a.msg)
      .filter(isAlert);
    const idByUnit = new Map(raised.map((m) => [m.alert.unitId, m.alert.id]));
    engine.handle({ c: "ROLLBACK_COHORT", fw: FW_ROLLOUT });
    const clears = stepDrain(engine, 2_500, 2_500 + 4 * FAST_COHORT.rollbackPerUnitMs)
      .map((a) => a.msg)
      .filter(isClear);
    expect(clears).toHaveLength(4);
    for (const clear of clears) {
      expect(clear.alertId).toBe(idByUnit.get(clear.unitId));
    }
  });

  it("implies the halt: a bare rollback cancels the queued install and a later halt refuses", () => {
    const engine = cohortEngine();
    stepDrain(engine, 0, 2_500); // no HALT_ROLLOUT sent
    const sync = engine.handle({ c: "ROLLBACK_COHORT", fw: FW_ROLLOUT });

    // the canceled install is visible in the synchronous answer
    const update = sync.find(isUnitUpdate);
    expect(update).toBeDefined();
    expect(update!.unit.id).toBe(PENDING_UNIT_ID);
    expect(update!.unit.fwPending).toBeUndefined();

    const after = stepDrain(engine, 2_500, 4_500);
    // no install at 3000, no late alert at 3200
    expect(
      after.filter((a) => isUnitUpdate(a.msg) && a.msg.unit.id === PENDING_UNIT_ID),
    ).toHaveLength(0);
    expect(after.filter((a) => isAlert(a.msg))).toHaveLength(0);
    expect(unitOf(engine, PENDING_UNIT_ID).fw).toBe(FW_STABLE);

    const halt = engine.handle({ c: "HALT_ROLLOUT" });
    if (!isFleetEvent(halt[0]!)) throw new Error("expected a fleet_command_event");
    expect(halt[0].ev).toEqual({
      k: "failed",
      reason: ROLLOUT_REFUSAL_NO_ROLLOUT_ACTIVE,
    });
  });

  it("refuses a second rollback mid-flight with ROLLBACK IN PROGRESS", () => {
    const { engine } = rollbackRun();
    stepDrain(engine, 3_000, 3_600); // mid-stage
    const out = engine.handle({ c: "ROLLBACK_COHORT", fw: FW_ROLLOUT });
    expect(out).toHaveLength(1);
    if (!isFleetEvent(out[0]!)) throw new Error("expected a fleet_command_event");
    expect(out[0].ev).toEqual({
      k: "failed",
      reason: ROLLOUT_REFUSAL_ROLLBACK_IN_PROGRESS,
    });
  });

  it("ignores a rollback with nothing to restore: unknown fw, the baseline itself, or an already-restored cohort", () => {
    const engine = cohortEngine();
    stepDrain(engine, 0, 2_500);
    expect(engine.handle({ c: "ROLLBACK_COHORT", fw: "9.9.9" })).toEqual([]);
    expect(engine.handle({ c: "ROLLBACK_COHORT", fw: FW_STABLE })).toEqual([]);

    engine.handle({ c: "ROLLBACK_COHORT", fw: FW_ROLLOUT });
    stepDrain(engine, 2_500, 2_500 + 4 * FAST_COHORT.rollbackPerUnitMs); // complete
    expect(engine.handle({ c: "ROLLBACK_COHORT", fw: FW_ROLLOUT })).toEqual([]);
  });

  it("exposes accepted + notes for late-joiner replay, cleared once complete lands", () => {
    const { engine, sync } = rollbackRun();
    const seen = sync.filter(isFleetEvent);
    expect(engine.activeFleetCommandEvents()).toEqual(seen);

    const arrivals = stepDrain(engine, 3_000, 3_000 + FAST_COHORT.rollbackPerUnitMs);
    seen.push(...arrivals.map((a) => a.msg).filter(isFleetEvent));
    expect(engine.activeFleetCommandEvents()).toEqual(seen); // a joiner replays exactly this
    expect(seen.length).toBe(3); // accepted + two ROLLING BACK notes

    stepDrain(
      engine,
      3_000 + FAST_COHORT.rollbackPerUnitMs,
      3_000 + 5 * FAST_COHORT.rollbackPerUnitMs,
    );
    expect(engine.activeFleetCommandEvents()).toEqual([]); // restoration over
  });

  it("a refusal consumes a seq but leaves no session and is never replayed", () => {
    const { engine, sync } = rollbackRun();
    const accepted = sync.filter(isFleetEvent)[0]!;
    const refusal = engine.handle({ c: "ROLLBACK_COHORT", fw: FW_ROLLOUT });
    if (!isFleetEvent(refusal[0]!)) throw new Error("expected a fleet_command_event");
    expect(refusal[0].seq).toBeGreaterThan(accepted.seq);
    expect(engine.activeFleetCommandEvents()).not.toContainEqual(refusal[0]);
  });
});

describe("rollout — three storylines in one session, zero interference", () => {
  // Knee at 300/500/700, nav at 2000/2600, cohort from 4000 with the install
  // at 6000 — one compressed session where everything speaks.
  const MIXED = {
    timeline: { onsetMs: 300, amberAtMs: 500, redAtMs: 700 },
    navTimeline: { blockAtMs: 2_000, clearAtMs: 2_600 },
    cohortTimeline: {
      onsetMs: 4_000,
      staggerMs: 200,
      pendingAtMs: 6_000,
      rollbackPerUnitMs: 400,
    },
  };

  it("plays knee, nav, and cohort beats side by side; the signature never lands on N-07 or N-03", () => {
    const engine = createSimEngine(MIXED);
    const msgs = stepDrain(engine, 0, 7_000).map((a) => a.msg);

    const alerts = msgs.filter(isAlert).map((m) => m.alert);
    const knee = alerts.filter((a) => a.unitId === "N-07");
    const nav = alerts.filter((a) => a.unitId === "N-03");
    const cohort = alerts.filter((a) => a.message === COHORT_ALERT_MESSAGE);

    expect(knee.map((a) => a.severity)).toEqual(["amber", "red"]); // untouched
    expect(nav).toHaveLength(1);
    expect(msgs.filter(isClear).filter((m) => m.unitId === "N-03")).toHaveLength(1);
    expect(cohort.map((a) => a.unitId)).toEqual([...ROLLOUT_UNIT_IDS, PENDING_UNIT_ID]);
    expect(cohort.map((a) => a.unitId)).not.toContain("N-07");
    expect(cohort.map((a) => a.unitId)).not.toContain("N-03");
    // knee and nav messages are name-prefixed; the signature is not
    for (const a of [...knee, ...nav]) expect(a.message).not.toBe(COHORT_ALERT_MESSAGE);

    // statuses tell all three stories at once
    expect(unitOf(engine, "N-07").status).toBe("red");
    expect(unitOf(engine, "N-03").status).toBe("nominal"); // self-recovered
    expect(unitOf(engine, "N-02").status).toBe("amber"); // cohort
  });

  it("rolling back the cohort clears ONLY the signature alerts — N-07 stays red, broken but honest", () => {
    const engine = createSimEngine(MIXED);
    stepDrain(engine, 0, 7_000);
    engine.handle({ c: "ROLLBACK_COHORT", fw: FW_ROLLOUT });
    const clears = stepDrain(engine, 7_000, 7_000 + 5 * 400 + 200)
      .map((a) => a.msg)
      .filter(isClear);

    // five restored units (the late-installed N-05 included), five clears
    expect(clears).toHaveLength(5);
    expect(clears.map((c) => c.unitId).sort()).toEqual(
      [...ROLLOUT_UNIT_IDS, PENDING_UNIT_ID].sort(),
    );
    expect(unitOf(engine, "N-07").status).toBe("red");
    // active alerts left: exactly N-07's two
    expect(engine.activeAlerts().map((m) => m.alert.unitId)).toEqual(["N-07", "N-07"]);
  });
});

describe("rollout — RESET_SIM restores the initial distribution and un-halts", () => {
  it("after a halt, RESET brings the queued install back and a new halt is accepted again", () => {
    const engine = cohortEngine();
    stepDrain(engine, 0, 2_500);
    engine.handle({ c: "HALT_ROLLOUT" });
    const resetOut = engine.handle({ c: "RESET_SIM" });
    expect(resetOut.map((m) => m.t)).toEqual(["fleet_snapshot"]);

    const snap = engine.snapshot();
    for (const u of snap.units) {
      expect(u.fw).toBe(ROLLOUT_UNIT_IDS.includes(u.id) ? FW_ROLLOUT : FW_STABLE);
    }
    expect(unitOf(engine, PENDING_UNIT_ID).fwPending).toBe(FW_ROLLOUT);

    const halt = engine.handle({ c: "HALT_ROLLOUT" });
    if (!isFleetEvent(halt[0]!)) throw new Error("expected a fleet_command_event");
    expect(halt[0].ev).toEqual({ k: "accepted" });
  });

  it("RESET mid-rollback cancels the staging: no orphaned beats, distribution restored, storyline replays", () => {
    const engine = cohortEngine();
    stepDrain(engine, 0, 2_500);
    engine.handle({ c: "ROLLBACK_COHORT", fw: FW_ROLLOUT });
    stepDrain(engine, 2_500, 3_100); // one unit restored, three staged
    engine.handle({ c: "RESET_SIM" });
    expect(engine.activeFleetCommandEvents()).toEqual([]);

    const after = stepDrain(engine, 3_100, 3_100 + 2 * FAST_COHORT.rollbackPerUnitMs);
    expect(after.map((a) => a.msg).filter(isFleetEvent)).toHaveLength(0);
    expect(after.map((a) => a.msg).filter(isClear)).toHaveLength(0);

    const snap = engine.snapshot();
    for (const u of snap.units) {
      expect(u.fw).toBe(ROLLOUT_UNIT_IDS.includes(u.id) ? FW_ROLLOUT : FW_STABLE);
      expect(u.status).toBe("nominal");
    }
    // the replayed storyline raises the cohort again, fresh ids
    const replay = stepDrain(
      engine,
      3_100 + 2 * FAST_COHORT.rollbackPerUnitMs,
      3_100 + 6_000,
    );
    expect(replay.map((a) => a.msg).filter(isAlert).length).toBeGreaterThanOrEqual(4);
  });
});

describe("rollout — determinism (a timed halt + rollback included)", () => {
  it("same seed and command timing → byte-identical streams; another seed or timing diverges", () => {
    const run = (seed: number, rollbackAt: number) => {
      const engine = createSimEngine({
        seed,
        ...QUIET,
        cohortTimeline: FAST_COHORT,
      });
      const out: FleetMessage[] = [];
      for (let t = STEP_MS; t <= 2_000; t += STEP_MS) out.push(...engine.advance(t));
      out.push(...engine.handle({ c: "HALT_ROLLOUT" }));
      for (let t = 2_000 + STEP_MS; t <= rollbackAt; t += STEP_MS)
        out.push(...engine.advance(t));
      out.push(...engine.handle({ c: "ROLLBACK_COHORT", fw: FW_ROLLOUT }));
      for (let t = rollbackAt + STEP_MS; t <= rollbackAt + 2_500; t += STEP_MS)
        out.push(...engine.advance(t));
      return out;
    };
    const a = run(7, 2_500);
    expect(a.some((m) => isFleetEvent(m) && m.ev.k === "complete")).toBe(true);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(run(7, 2_500)));
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(run(8, 2_500)));
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(run(7, 2_600)));
  });
});
