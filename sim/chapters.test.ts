// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fleetMessageSchema, type AlertMessage, type FleetMessage } from "@/lib/schema";
import {
  ADVANCE_LEAD_MS,
  BATCH_INTERVAL_MS,
  CHAPTER_LEAD_MS,
  COHORT_ALERT_MESSAGE,
  chapterAdvanceMs,
  chapterBeatMs,
  chapterSeekMs,
  createSimEngine,
  DEFAULT_COHORT_TIMELINE,
  DEFAULT_NAV_TIMELINE,
  DEFAULT_OFFSET_TIMELINE,
  DEFAULT_TIMELINE,
  NAV_UNIT_ID,
  OFFSET_UNIT_ID,
  STORYLINE_CHAPTERS,
  type SimEngine,
  type StorylineChapter,
} from "./engine";

/**
 * Chapter seeking.
 *
 * Four storylines share one clock and the last of them opens at 5:30, which is
 * longer than anyone watches a demo they did not build. The seek is what makes
 * the other three reachable, so what it owes is precise: land short of the
 * chapter (not on it — the arrival is the thing worth watching), arrive
 * carrying the history a run to that point would have written, and land in the
 * same place every time regardless of where the clock was when it was pressed.
 */

const alertsOf = (msgs: FleetMessage[]) => msgs.filter((m) => m.t === "alert");
const statusOf = (msgs: FleetMessage[], unitId: string) => {
  const snap = msgs.find((m) => m.t === "fleet_snapshot");
  if (snap?.t !== "fleet_snapshot") return undefined;
  return snap.units.find((u) => u.id === unitId)?.status;
};

/** Run the engine forward to a storyline instant, discarding what it says. */
function runTo(engine: SimEngine, ms: number): void {
  for (let t = BATCH_INTERVAL_MS; t <= ms; t += BATCH_INTERVAL_MS) engine.advance(t);
}

describe("seeking to a storyline chapter", () => {
  it("resolves each chapter against the engine's own timelines", () => {
    const cfg = {
      timeline: DEFAULT_TIMELINE,
      navTimeline: DEFAULT_NAV_TIMELINE,
      cohortTimeline: DEFAULT_COHORT_TIMELINE,
      offsetTimeline: DEFAULT_OFFSET_TIMELINE,
    } as Parameters<typeof chapterBeatMs>[0];

    // The knee's beat is its amber: the onset is inside the history a run is
    // handed, and the first thing anyone sees is the unit turning.
    expect(chapterBeatMs(cfg, "knee")).toBe(DEFAULT_TIMELINE.amberAtMs);
    expect(chapterBeatMs(cfg, "nav")).toBe(DEFAULT_NAV_TIMELINE.blockAtMs);
    expect(chapterBeatMs(cfg, "cohort")).toBe(DEFAULT_COHORT_TIMELINE.onsetMs);
    expect(chapterBeatMs(cfg, "offset")).toBe(DEFAULT_OFFSET_TIMELINE.alertAtMs);
  });

  it("lands short of the beat, never on it, and never below zero", () => {
    const cfg = {
      timeline: { ...DEFAULT_TIMELINE, onsetMs: 0, amberAtMs: 1_000 },
      navTimeline: DEFAULT_NAV_TIMELINE,
      cohortTimeline: DEFAULT_COHORT_TIMELINE,
      offsetTimeline: DEFAULT_OFFSET_TIMELINE,
    } as Parameters<typeof chapterSeekMs>[0];

    // The lead-in is what makes the alert arrive while someone is watching.
    expect(chapterSeekMs(cfg, "offset")).toBe(
      DEFAULT_OFFSET_TIMELINE.alertAtMs - CHAPTER_LEAD_MS,
    );
    // A chapter closer to zero than the lead-in clamps rather than going negative.
    expect(chapterSeekMs(cfg, "knee")).toBe(0);
  });

  it("puts N-03's blocked route seconds away instead of two minutes", () => {
    const engine = createSimEngine({ seed: 7 });
    runTo(engine, 2_000);

    const out = engine.handle({ c: "SEEK_STORYLINE", chapter: "nav" });
    // Nothing has happened to N-03 yet: the seek stops short of the block.
    expect(statusOf(out, NAV_UNIT_ID)).toBe("nominal");
    expect(alertsOf(out).some((a) => a.alert.unitId === NAV_UNIT_ID)).toBe(false);

    // ...and it arrives inside the lead-in rather than at some later minute.
    const after: FleetMessage[] = [];
    for (let t = 2_100; t <= 2_000 + CHAPTER_LEAD_MS + 500; t += BATCH_INTERVAL_MS) {
      after.push(...engine.advance(t));
    }
    expect(alertsOf(after).some((a) => a.alert.unitId === NAV_UNIT_ID)).toBe(true);
  });

  it("arrives carrying the history a run to that point would have written", () => {
    const engine = createSimEngine({ seed: 7 });
    runTo(engine, 2_000);

    // By 3:00 the knee has been red for two minutes. A cohort seek that showed
    // a clean fleet would be showing a moment that never existed.
    const out = engine.handle({ c: "SEEK_STORYLINE", chapter: "cohort" });
    expect(alertsOf(out).length).toBeGreaterThan(0);
    expect(engine.activeAlerts().length).toBeGreaterThan(0);
  });

  it("lands in the same place whenever it is pressed", () => {
    const early = createSimEngine({ seed: 7 });
    runTo(early, 1_000);
    const fromEarly = early.handle({ c: "SEEK_STORYLINE", chapter: "offset" });

    // The same seek from well past the chapter: beats do not un-fire, so this
    // is the case that forces the reset.
    const late = createSimEngine({ seed: 7 });
    runTo(late, DEFAULT_OFFSET_TIMELINE.alertAtMs + 30_000);
    const fromLate = late.handle({ c: "SEEK_STORYLINE", chapter: "offset" });

    expect(statusOf(fromLate, OFFSET_UNIT_ID)).toBe(statusOf(fromEarly, OFFSET_UNIT_ID));
    expect(alertsOf(fromLate).map((a) => a.alert.message)).toEqual(
      alertsOf(fromEarly).map((a) => a.alert.message),
    );
    expect(late.activeAlerts().map((a) => a.alert.message)).toEqual(
      early.activeAlerts().map((a) => a.alert.message),
    );
  });

  it("emits nothing the wire schema will not carry, for every chapter", () => {
    for (const chapter of STORYLINE_CHAPTERS satisfies readonly StorylineChapter[]) {
      const engine = createSimEngine({ seed: 3 });
      runTo(engine, 5_000);
      for (const msg of engine.handle({ c: "SEEK_STORYLINE", chapter })) {
        expect(() => fleetMessageSchema.parse(msg), chapter).not.toThrow();
      }
    }
  });

  it("leaves the telemetry clock monotonic across the jump", () => {
    const engine = createSimEngine({ seed: 7 });
    runTo(engine, 5_000);
    engine.handle({ c: "SEEK_STORYLINE", chapter: "cohort" });

    let last = -Infinity;
    for (let t = 5_100; t <= 8_000; t += BATCH_INTERVAL_MS) {
      for (const msg of engine.advance(t)) {
        if (msg.t !== "telemetry") continue;
        expect(msg.ts).toBeGreaterThanOrEqual(last);
        last = msg.ts;
      }
    }
    expect(last).toBeGreaterThan(-Infinity);
  });
});

/**
 * Advancing, as distinct from seeking: the operator has just finished with
 * something, and the next act should meet them without undoing it.
 */
describe("advancing the storyline to a chapter", () => {
  const raised = (msgs: FleetMessage[]) =>
    msgs.filter((m): m is AlertMessage => m.t === "alert");

  it("brings the cohort forward to meet the operator without rebuilding the fleet", () => {
    const engine = createSimEngine({ seed: 7 });
    // A minute in: the knee has gone amber and red; nothing else has happened.
    runTo(engine, 60_000);
    const before = engine.snapshot().units.find((u) => u.id === "N-07");

    const out = engine.handle({ c: "ADVANCE_STORYLINE", chapter: "cohort" });

    // Not a reset: no fresh snapshot, and N-07 is the unit it was.
    expect(out.some((m) => m.t === "fleet_snapshot")).toBe(false);
    expect(engine.snapshot().units.find((u) => u.id === "N-07")).toEqual(before);
    // The skipped span fired once, as history: N-03's route blocked on the way.
    expect(raised(out).filter((m) => m.alert.unitId === NAV_UNIT_ID)).toHaveLength(1);
    // …and the knee's beats, already behind us, did not fire again.
    expect(raised(out).filter((m) => m.alert.unitId === "N-07")).toHaveLength(0);
    // The chapter itself is still ahead, by exactly the lead.
    expect(raised(out).some((m) => m.alert.message === COHORT_ALERT_MESSAGE)).toBe(false);
    const soon: FleetMessage[] = [];
    for (
      let t = 60_000 + BATCH_INTERVAL_MS;
      t <= 60_000 + ADVANCE_LEAD_MS + 500;
      t += BATCH_INTERVAL_MS
    ) {
      soon.push(...engine.advance(t));
    }
    const first = raised(soon).find((m) => m.alert.message === COHORT_ALERT_MESSAGE);
    expect(first?.alert.unitId).toBe("N-02");
    for (const m of [...out, ...soon])
      expect(fleetMessageSchema.safeParse(m).success).toBe(true);
  });

  it("is a no-op once the chapter is at hand or behind, so a second filing moves nothing", () => {
    const engine = createSimEngine({ seed: 7 });
    runTo(engine, 60_000);
    engine.handle({ c: "ADVANCE_STORYLINE", chapter: "cohort" });
    expect(engine.handle({ c: "ADVANCE_STORYLINE", chapter: "cohort" })).toEqual([]);
    expect(engine.handle({ c: "ADVANCE_STORYLINE", chapter: "knee" })).toEqual([]);
  });

  it("lands short of the beat by its own, shorter lead", () => {
    const cfg = {
      timeline: DEFAULT_TIMELINE,
      navTimeline: DEFAULT_NAV_TIMELINE,
      cohortTimeline: DEFAULT_COHORT_TIMELINE,
      offsetTimeline: DEFAULT_OFFSET_TIMELINE,
    } as Parameters<typeof chapterAdvanceMs>[0];
    expect(ADVANCE_LEAD_MS).toBeLessThan(CHAPTER_LEAD_MS);
    expect(chapterAdvanceMs(cfg, "cohort")).toBe(
      DEFAULT_COHORT_TIMELINE.onsetMs - ADVANCE_LEAD_MS,
    );
  });
});
