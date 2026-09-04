// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStorylineSession,
  markIncidents,
  markStorylinePosition,
  readPersistedIncidents,
  readStorylineResumeMs,
} from "./storyline-session";

/**
 * The sitting that survives a reload.
 *
 * What this owes is mostly about *not* trusting itself: the value in
 * sessionStorage was written by some earlier page — possibly an older build,
 * possibly a person with devtools open — so every path out of storage has to
 * end in either a validated value or the same answer as an empty store. A
 * demo that white-screens because its own resume blob went stale would be
 * worse than one that simply starts again.
 */

const KEY = "fleet-console.session";

const record = (id: string) => ({
  id,
  unitId: "N-07",
  report: {
    unitId: "N-07",
    joint: "knee_L",
    component: "actuator_A07",
    anomaly: "gain",
    summary: "LEFT KNEE ACTUATOR A-07: GAIN ANOMALY.",
    recommendations: ["Recalibrate joint"],
    ts: 1_700_000_000_000,
  },
  acknowledged: [],
});

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("the persisted sitting", () => {
  it("reads as a fresh run when nothing has been stored", () => {
    expect(readStorylineResumeMs()).toBe(0);
    expect(readPersistedIncidents()).toEqual([]);
  });

  it("round-trips the storyline position", () => {
    markStorylinePosition(43_002);
    expect(readStorylineResumeMs()).toBe(43_002);
  });

  it("keeps the clock and the incidents from overwriting each other", () => {
    // The two are written by different callers on different schedules — a 1 s
    // interval and a store subscription — so neither may clear the other.
    markStorylinePosition(12_000);
    markIncidents([record("INC-1")]);
    expect(readStorylineResumeMs()).toBe(12_000);
    expect(readPersistedIncidents()).toHaveLength(1);

    markStorylinePosition(13_000);
    expect(readPersistedIncidents()).toHaveLength(1);
    expect(readStorylineResumeMs()).toBe(13_000);
  });

  it("clamps a stale position rather than resuming past the whole story", () => {
    markStorylinePosition(9 * 60 * 60 * 1000);
    expect(readStorylineResumeMs()).toBe(30 * 60 * 1000);
  });

  it("refuses a negative position", () => {
    markStorylinePosition(-5000);
    expect(readStorylineResumeMs()).toBe(0);
  });

  it("treats an unparseable blob as no blob", () => {
    window.sessionStorage.setItem(KEY, "{not json");
    expect(readStorylineResumeMs()).toBe(0);
    expect(readPersistedIncidents()).toEqual([]);
  });

  it("treats a blob from another shape as no blob", () => {
    // A previous build's format, or a hand edit. Either way: start fresh.
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ version: 99, elapsed: 1000, incidents: "all of them" }),
    );
    expect(readStorylineResumeMs()).toBe(0);
    expect(readPersistedIncidents()).toEqual([]);
  });

  it("drops an incident list with a malformed record rather than half-trusting it", () => {
    markIncidents([record("INC-1"), { id: "INC-2" }]);
    expect(readPersistedIncidents()).toEqual([]);
  });

  it("forgets everything on a deliberate restart", () => {
    markStorylinePosition(20_000);
    markIncidents([record("INC-1")]);
    clearStorylineSession();
    expect(readStorylineResumeMs()).toBe(0);
    expect(readPersistedIncidents()).toEqual([]);
  });

  it("survives a storage that throws on every access", () => {
    // Private windows can throw on the property itself, not just on write.
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("access denied");
    });
    expect(() => markStorylinePosition(1000)).not.toThrow();
    expect(() => markIncidents([record("INC-1")])).not.toThrow();
    expect(() => clearStorylineSession()).not.toThrow();
    expect(readStorylineResumeMs()).toBe(0);
    expect(readPersistedIncidents()).toEqual([]);
  });
});
