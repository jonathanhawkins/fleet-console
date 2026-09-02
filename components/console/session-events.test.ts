import { describe, expect, it } from "vitest";
import { type AuditEntry } from "@/lib/stores";
import {
  commandLabel,
  deriveSessionEvents,
  estimateLabelWidth,
  eventBoxWidth,
  groupAuditEntries,
  LABEL_LANES,
  offsetLabel,
  packEvents,
  sessionMeasures,
  spanLabel,
  TIME_W,
  type SessionEvent,
} from "./session-events";
import { type UnitStatusHistory } from "./status-history";

/**
 * The seam and the packer.
 *
 * `deriveSessionEvents` is deliberately the only thing that knows where a beat
 * came from, and it now reads three journals: the status spans for state, the
 * audit slice in `lib/stores` for actions, and the console's own recorder for
 * the session and its link. Everything below the seam — the packing, the
 * timeline, its spoken description — is written against `SessionEvent[]` and
 * would not notice if all three were replaced. These tests are the contract
 * that makes that true, so they are written against the *shape* rather than
 * against any one source.
 */

const T0 = 1_700_000_000_000;

function entry(kind: AuditEntry["kind"], ts: number): AuditEntry {
  return { id: `${kind}-${ts}`, ts, kind, unitId: "N-07", summary: kind };
}

function history(over: Partial<UnitStatusHistory> = {}): UnitStatusHistory {
  return {
    startedAt: T0,
    spans: [{ status: "nominal", from: T0, to: null }],
    marks: [],
    beats: [],
    ...over,
  };
}

describe("deriveSessionEvents", () => {
  it("always opens with the session, even on a quiet unit", () => {
    expect(deriveSessionEvents(history())).toEqual([
      { id: "start", ts: T0, kind: "start", label: "Session start" },
    ]);
  });

  /**
   * The opening span is not an event. It is the state the console *found* the
   * unit in, and a tick claiming "went to Attention" at t=0 would be inventing
   * a transition nobody witnessed — the same rule the old strip applied to
   * alerts replayed from before the session.
   */
  it("does not tick the state it arrived to, only the changes it saw", () => {
    const events = deriveSessionEvents(
      history({
        spans: [
          { status: "amber", from: T0, to: T0 + 10_000 },
          { status: "red", from: T0 + 10_000, to: null },
        ],
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(["start", "red"]);
    expect(events[1]?.label).toBe("Alert");
  });

  it("uses the console's own words for a status, not the wire's", () => {
    const events = deriveSessionEvents(
      history({
        spans: [
          { status: "nominal", from: T0, to: T0 + 1 },
          { status: "amber", from: T0 + 1, to: T0 + 2 },
          { status: "nominal", from: T0 + 2, to: null },
        ],
      }),
    );
    expect(events.map((e) => e.label)).toEqual([
      "Session start",
      "Attention",
      "Nominal", // the recovery is a beat too; a band alone cannot say it
    ]);
  });

  it("merges all three sources into one chronology", () => {
    const events = deriveSessionEvents(
      history({
        spans: [
          { status: "nominal", from: T0, to: T0 + 20_000 },
          { status: "red", from: T0 + 20_000, to: null },
        ],
        beats: [{ id: "link-lost-1", ts: T0 + 10_000, kind: "link-lost" }],
      }),
      [
        entry("diag-verdict", T0 + 40_000),
        entry("diag-start", T0 + 30_000),
        entry("alert-acked", T0 + 25_000),
      ],
    );
    expect(events.map((e) => e.label)).toEqual([
      "Session start",
      "Link lost",
      "Alert",
      "Acknowledged",
      "Diagnostic",
      "Verdict",
    ]);
    expect(events.map((e) => e.ts)).toEqual(
      [...events.map((e) => e.ts)].sort((a, b) => a - b),
    );
  });

  /**
   * The audit log is the single source for what an operator or a machine *did*
   * — but not for what state a unit was in. `alert-raised` carries no severity,
   * so it cannot tell Attention from Alert; `escalation` shares its instant and
   * its ref with the raise that caused it, so admitting both would put two
   * marks on one moment; and neither has anything to say about the beat with no
   * alert behind it, the recovery. The band's own spans cover all three.
   */
  it("leaves state to the spans and takes only the actions from the audit log", () => {
    const events = deriveSessionEvents(
      history({
        spans: [
          { status: "nominal", from: T0, to: T0 + 10_000 },
          { status: "amber", from: T0 + 10_000, to: T0 + 20_000 },
          { status: "red", from: T0 + 20_000, to: null },
        ],
      }),
      [
        { ...entry("alert-raised", T0 + 10_000), ref: "al-001" },
        { ...entry("alert-raised", T0 + 20_000), ref: "al-002" },
        { ...entry("escalation", T0 + 20_000), ref: "al-002" },
      ],
    );
    expect(events.map((e) => e.label)).toEqual(["Session start", "Attention", "Alert"]);
  });

  it("names a command from its ref rather than calling everything a command", () => {
    const events = deriveSessionEvents(history(), [
      { ...entry("command-accepted", T0 + 5_000), ref: "COMMAND_SAFE_SIT#3" },
      { ...entry("command-failed", T0 + 9_000), ref: "COMMAND_SAFE_SIT#4" },
    ]);
    expect(events.map((e) => e.label)).toEqual(["Session start", "Safe sit", "Refused"]);
  });

  /**
   * `command-complete` lands about four seconds after `command-accepted`. A
   * timeline that ticked both would spend two of its beats saying the operator
   * pressed one button.
   */
  it("ticks a command once, at the moment it was issued", () => {
    const events = deriveSessionEvents(history(), [
      { ...entry("command-accepted", T0 + 5_000), ref: "COMMAND_SAFE_SIT#3" },
      { ...entry("command-complete", T0 + 9_000), ref: "COMMAND_SAFE_SIT#3" },
    ]);
    expect(events).toHaveLength(2);
  });

  /**
   * Archiving a diagnostic closes every alert standing on the unit in
   * one synchronous pass, so the scripted incident's amber and red produce two
   * resolution entries a millisecond apart. Ticked separately they landed on
   * the same pixel and stacked the word "Resolved" on itself.
   */
  it("ticks two alerts closing on one press as one beat", () => {
    const events = deriveSessionEvents(history(), [
      { ...entry("resolution", T0 + 30_001), ref: "al-002" },
      { ...entry("resolution", T0 + 30_000), ref: "al-001" },
    ]);
    expect(events.map((e) => e.label)).toEqual(["Session start", "Resolved"]);
  });

  it("keeps two closures that were two decisions", () => {
    const events = deriveSessionEvents(history(), [
      {
        ...entry("resolution", T0 + 40_000),
        summary: "Resolved by operator",
        ref: "al-002",
      },
      {
        ...entry("resolution", T0 + 30_000),
        summary: "Resolved — diagnostic incident logged",
        ref: "al-001",
      },
    ]);
    expect(events.map((e) => e.label)).toEqual(["Session start", "Resolved", "Resolved"]);
  });

  it("drops anything dated before the console was open", () => {
    // The sim replays the run's active alerts to every joiner, carrying their
    // original wire timestamps — a console that connected a minute into an
    // incident did not witness them.
    const events = deriveSessionEvents(
      history({ beats: [{ id: "old", ts: T0 - 60_000, kind: "link-lost" }] }),
      [entry("diag-verdict", T0 - 30_000)],
    );
    expect(events).toHaveLength(1);
  });

  it("gives every event a stable id, so a re-render is not a new tick", () => {
    const h = history({
      spans: [
        { status: "nominal", from: T0, to: T0 + 1_000 },
        { status: "amber", from: T0 + 1_000, to: null },
      ],
    });
    const log = [entry("diag-start", T0 + 2_000)];
    expect(deriveSessionEvents(h, log).map((e) => e.id)).toEqual(
      deriveSessionEvents(h, log).map((e) => e.id),
    );
    expect(new Set(deriveSessionEvents(h, log).map((e) => e.id)).size).toBe(3);
  });
});

/**
 * the grouping math.
 *
 * The rule is deliberately narrow: identical sentences, adjacent, inside one
 * window, of a kind whose plural line someone has actually written. Everything
 * outside that stays as many rows as the store has entries, because a log that
 * merges on a hunch is a log an operator cannot cite.
 */
describe("groupAuditEntries", () => {
  const resolution = (ts: number, summary = "Resolved — diagnostic incident logged") => ({
    ...entry("resolution", ts),
    id: `res-${ts}`,
    summary,
  });

  it("leaves a lone entry exactly as it found it", () => {
    const rows = groupAuditEntries([resolution(T0)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
    expect(rows[0]?.entry.id).toBe(`res-${T0}`);
  });

  it("collapses the cluster and counts it", () => {
    const rows = groupAuditEntries([
      resolution(T0),
      resolution(T0 + 1),
      resolution(T0 + 2),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
  });

  it("keeps the earliest of the cluster, so the row is stamped when it happened", () => {
    const rows = groupAuditEntries([resolution(T0), resolution(T0 + 900)]);
    expect(rows[0]?.entry.ts).toBe(T0);
  });

  it("never loses an entry — the counts add up to the log", () => {
    const log = [
      entry("alert-raised", T0),
      resolution(T0 + 10_000),
      resolution(T0 + 10_001),
      entry("diag-start", T0 + 20_000),
    ];
    expect(groupAuditEntries(log).reduce((n, g) => n + g.count, 0)).toBe(log.length);
  });

  it("does not merge two closures that said different things", () => {
    const rows = groupAuditEntries([
      resolution(T0),
      resolution(T0 + 1, "Resolved — unit commanded to safe sit"),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("does not merge across the window — two minutes apart is two decisions", () => {
    expect(groupAuditEntries([resolution(T0), resolution(T0 + 120_000)])).toHaveLength(2);
  });

  it("does not reach past an intervening beat to merge", () => {
    // Merging here would print the two closures on one row *before* the command
    // that separated them, which reorders the record to tidy it.
    const rows = groupAuditEntries([
      resolution(T0),
      entry("command-accepted", T0 + 1),
      resolution(T0 + 2),
    ]);
    expect(rows.map((g) => g.count)).toEqual([1, 1, 1]);
  });

  it("collapses nothing but resolutions, however identical", () => {
    const twice = [entry("diag-start", T0), { ...entry("diag-start", T0 + 1), id: "d2" }];
    expect(groupAuditEntries(twice)).toHaveLength(2);
  });
});

describe("commandLabel", () => {
  it("says the wire's name in operator words", () => {
    expect(commandLabel("COMMAND_SAFE_SIT#3")).toBe("Safe sit");
  });

  /**
   * Derived rather than looked up, so the next command to exist appears on the
   * timeline under its own name without this file being edited. The fallback is
   * the raw name — never a lie, just terser than it should be.
   */
  it("falls back to the raw name, and to a word, rather than to nothing", () => {
    expect(commandLabel("COMMAND_RETURN_TO_DOCK#1")).toBe("Return to dock");
    expect(commandLabel("STOP")).toBe("Stop");
    expect(commandLabel(undefined)).toBe("Command");
  });
});

describe("packEvents", () => {
  const at = (seconds: number, label: string): SessionEvent => ({
    id: `${seconds}-${label}`,
    ts: T0 + seconds * 1_000,
    kind: "start",
    label,
  });
  const WIDTH = 600;
  const end = T0 + 100_000;

  it("puts the tick where the moment is", () => {
    const [first, mid, last] = packEvents(
      [at(0, "Session start"), at(50, "Alert"), at(100, "Verdict")],
      WIDTH,
      T0,
      end,
    );
    expect(first?.pct).toBe(0);
    expect(mid?.pct).toBe(50);
    expect(last?.pct).toBe(100);
  });

  it("keeps every label in one lane while they do not touch", () => {
    const placed = packEvents(
      [at(0, "Session start"), at(50, "Alert"), at(100, "Verdict")],
      WIDTH,
      T0,
      end,
    );
    expect(placed.map((e) => e.lane)).toEqual([0, 0, 0]);
  });

  it("clamps the first and last labels inside the track instead of overhanging", () => {
    const placed = packEvents(
      [at(0, "Session start"), at(100, "Verdict")],
      WIDTH,
      T0,
      end,
    );
    expect(placed[0]?.labelX).toBe(0);
    expect(placed[1]?.labelX).toBe(WIDTH - eventBoxWidth("Verdict"));
  });

  /**
   * The label carries its clock on a second line, so the packer packs
   * boxes: a short beat is now as wide as the timestamp under it, and packing
   * on the word alone would let "Verdict" sit 8px from its neighbour and print
   * two clocks into each other.
   */
  it("packs the box, not the word — a short beat is as wide as its clock", () => {
    expect(eventBoxWidth("Verdict")).toBe(TIME_W);
    expect(eventBoxWidth("Session start")).toBe(estimateLabelWidth("Session start"));
    expect(eventBoxWidth("Session start")).toBeGreaterThan(TIME_W);
  });

  it("staggers into the second lane rather than letting words collide", () => {
    const placed = packEvents(
      [at(40, "Diagnostic"), at(44, "Verdict"), at(48, "Attention")],
      WIDTH,
      T0,
      end,
    );
    const lanes = placed.map((e) => e.lane);
    expect(new Set(lanes).size).toBeGreaterThan(1);
    expect(Math.max(...lanes)).toBeLessThan(LABEL_LANES);
  });

  /**
   * A crowded timeline is a timeline with an incident on it, and the beats an
   * operator needs are the ones at the end. So labels are placed session-start
   * first — it anchors the left edge — and then newest first, and the word that
   * gets dropped is the one in the middle of the calm opening rather than the
   * verdict.
   */
  it("spends the last lane on the newest beats, and keeps the session's anchor", () => {
    const events = [
      at(0, "Session start"),
      at(30, "Attention"),
      at(33, "Alert"),
      at(36, "Diagnostic"),
      at(39, "Verdict"),
    ];
    const placed = packEvents(events, 220, T0, end);
    const labelled = placed.filter((e) => e.lane >= 0).map((e) => e.label);
    expect(labelled).toContain("Session start");
    expect(labelled).toContain("Verdict");
    expect(labelled.length).toBeLessThan(events.length);
  });

  /**
   * A second-lane tick has to cross the first lane to reach its word. Where
   * another beat's label is sitting at that x, the hairline draws straight
   * through its type — a struck-out word, not a leader line.
   */
  it("will not run a tick down through somebody else's word", () => {
    const placed = packEvents(
      [at(0, "Session start"), at(99, "Verdict"), at(100, "Resolved")],
      WIDTH,
      T0,
      end,
    );
    const crowded = placed.filter((e) => e.lane > 0);
    expect(crowded.length).toBeGreaterThan(0);
    expect(crowded.every((e) => e.descends)).toBe(false);
    // The word is still placed; only the leader is withheld.
    expect(crowded.every((e) => e.lane >= 0)).toBe(true);
  });

  it("lets a tick reach its own word when the lane above it is clear", () => {
    const placed = packEvents(
      [at(0, "Session start"), at(50, "Alert"), at(100, "Verdict")],
      WIDTH,
      T0,
      end,
    );
    expect(placed.every((e) => e.descends)).toBe(true);
  });

  it("still places every tick when no label fits at all", () => {
    const events = [at(0, "Session start"), at(1, "Attention"), at(2, "Alert")];
    const placed = packEvents(events, 20, T0, end);
    expect(placed).toHaveLength(3);
    expect(placed.every((e) => Number.isFinite(e.pct))).toBe(true);
  });

  it("survives a track it has not been measured for yet", () => {
    const placed = packEvents([at(0, "Session start")], 0, T0, end);
    expect(placed[0]?.lane).toBe(0);
    expect(placed[0]?.labelX).toBe(0);
  });
});

/**
 * the measures.
 *
 * The user's complaint was that a ninety-three minute wait between an alert
 * being raised and anyone running a diagnostic was invisible: both moments had
 * a tick, and the distance between them read as "a while". These are the two
 * spans that make that distance a number.
 */
describe("spanLabel", () => {
  it("is read at a glance, not counted — no seconds", () => {
    expect(spanLabel(93 * 60_000)).toBe("1h 33m");
    expect(spanLabel(12 * 60_000 + 30_000)).toBe("13m");
    expect(spanLabel(60_000)).toBe("1m");
  });

  it("does not disagree with itself about which side of the hour a span fell on", () => {
    // 59m 42s rounds to 60 minutes; printing "59m 42s" beside a rounded "1h"
    // elsewhere is the sort of thing that makes a record unciteable.
    expect(spanLabel(59 * 60_000 + 42_000)).toBe("1h 00m");
    expect(spanLabel(3 * 3_600_000 + 5 * 60_000)).toBe("3h 05m");
  });
});

describe("sessionMeasures", () => {
  const beat = (kind: SessionEvent["kind"], seconds: number): SessionEvent => ({
    id: `${kind}-${seconds}`,
    ts: T0 + seconds * 1_000,
    kind,
    label: kind,
  });

  it("measures the wait an operator could not otherwise read off the band", () => {
    const measured = sessionMeasures([
      beat("start", 0),
      beat("amber", 10),
      beat("diagnostic", 5_600),
      beat("resolved", 5_800),
    ]);
    expect(measured.map((m) => m.id)).toEqual(["response", "diagnosis"]);
    expect(measured[0]?.label).toBe("1h 33m");
    expect(measured[1]?.label).toBe("3m");
  });

  it("measures from the moment the unit became a problem, not from the session", () => {
    const measured = sessionMeasures([
      beat("start", 0),
      beat("red", 100),
      beat("diagnostic", 5_000),
    ]);
    expect(measured[0]?.from.kind).toBe("red");
  });

  it("draws nothing against an open end — both beats or no bracket", () => {
    expect(sessionMeasures([beat("start", 0), beat("amber", 10)])).toEqual([]);
    expect(sessionMeasures([beat("start", 0), beat("diagnostic", 10)])).toEqual([]);
  });

  it("skips the spans the two ticks had already said — under a minute is noise", () => {
    const measured = sessionMeasures([
      beat("start", 0),
      beat("amber", 10),
      beat("diagnostic", 45),
      beat("resolved", 200),
    ]);
    expect(measured.map((m) => m.id)).toEqual(["diagnosis"]);
  });

  it("never measures backwards", () => {
    // A resolution logged before the diagnostic (a replayed wire ts, a clock
    // skew) must not produce a bracket running right to left.
    const measured = sessionMeasures([
      beat("resolved", 10),
      beat("amber", 20),
      beat("diagnostic", 5_000),
    ]);
    expect(measured.map((m) => m.id)).toEqual(["response"]);
  });

  it("speaks each span, so the brackets are not sighted-only", () => {
    const [response] = sessionMeasures([
      beat("start", 0),
      beat("amber", 10),
      beat("diagnostic", 5_600),
    ]);
    expect(response?.spoken).toBe("1h 33m from the alert to the diagnostic");
  });
});

describe("offsetLabel", () => {
  it("counts from the session's own start, in minutes and seconds", () => {
    expect(offsetLabel(T0, T0)).toBe("+0:00");
    expect(offsetLabel(T0 + 7_000, T0)).toBe("+0:07");
    expect(offsetLabel(T0 + 67_000, T0)).toBe("+1:07");
    expect(offsetLabel(T0 - 5_000, T0)).toBe("+0:00"); // never negative
  });
});
