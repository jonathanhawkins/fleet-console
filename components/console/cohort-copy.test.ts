import { describe, expect, it } from "vitest";
import { type CohortCanary } from "@/lib/stores";
import {
  canaryLine,
  cohortClosedAt,
  cohortHeadline,
  cohortRecordLine,
  cohortRef,
  haltImpact,
  haltReceipt,
  listUnits,
  refusalNote,
  restoredCount,
  rollbackEstimate,
  rollbackImpact,
  rollbackLine,
  rollbackRoster,
  rollbackRows,
} from "./cohort-copy";

/**
 * Every string the fleet incident card can say, and the two derivations behind
 * what it shows. The point of the file being pure is that the sentences an
 * operator reads before changing four robots' firmware are assertable here
 * rather than only reachable through a rendered card.
 */

const CANARY: CohortCanary[] = [
  { fw: "2.4.1", affected: 4, total: 4 },
  { fw: "2.3.7", affected: 0, total: 4 },
];

describe("the incident, stated", () => {
  it("heads with the count", () => {
    expect(cohortHeadline(4)).toBe("4 units raising the same warning");
  });

  it("changes exactly one word of tense once it is over", () => {
    expect(cohortHeadline(4, true)).toBe("4 units raised the same warning");
  });

  /**
   * What the card leaves behind. Past tense, the build named (the
   * record has no section label to carry it), and deliberately no claim that
   * anything was restored — closing an incident is the operator saying they are
   * done with it, not the console asserting an outcome.
   */
  it("files the incident in the card's own past tense", () => {
    expect(cohortRecordLine(4, "2.4.1")).toBe(
      "4 units raised the same warning on 2.4.1 — incident closed.",
    );
    expect(cohortRecordLine(4, "2.4.1")).not.toContain("restored");
  });

  /**
   * The reference is the card's own door onto the fleet write-up, so
   * it has to read like one an operator could quote down a phone — and it has
   * to be as stable and as unique as the instance id it is derived from.
   */
  it("derives a readable reference from the build and the moment", () => {
    expect(cohortRef("2.4.1", 1_700_000_180_000)).toBe(
      `FLT-241-${(1_700_000_180_000).toString(36).toUpperCase()}`,
    );
  });

  it("names one instance, and never two", () => {
    expect(cohortRef("2.4.1", 100)).toBe(cohortRef("2.4.1", 100));
    expect(cohortRef("2.4.1", 100)).not.toBe(cohortRef("2.4.1", 101));
    expect(cohortRef("2.4.1", 100)).not.toBe(cohortRef("2.3.7", 100));
  });

  it("prints the demo's canary comparison as the argument for a rollback", () => {
    expect(canaryLine(CANARY, "2.4.1")).toBe(
      "All on firmware 2.4.1 — 0 of 4 units on 2.3.7 affected",
    );
  });

  it("finds the suspect by firmware, not by position", () => {
    // The store hands the array suspect-first; the sentence's subject still has
    // to be the build the operator is about to act on if that ever changes.
    expect(canaryLine([...CANARY].reverse(), "2.4.1")).toMatch(
      /^All on firmware 2\.4\.1 —/,
    );
  });

  it("does not claim ALL when the build is only partly affected", () => {
    expect(
      canaryLine(
        [
          { fw: "2.4.1", affected: 4, total: 5 },
          { fw: "2.3.7", affected: 0, total: 3 },
        ],
        "2.4.1",
      ),
    ).toBe("4 of 5 units on firmware 2.4.1 — 0 of 3 units on 2.3.7 affected");
  });

  it("says so when there is nothing to compare against", () => {
    expect(canaryLine([{ fw: "2.4.1", affected: 4, total: 4 }], "2.4.1")).toBe(
      "All on firmware 2.4.1 — no other build in the fleet to compare",
    );
  });

  it("withdraws the accusation when the fault is on both builds", () => {
    // Not a special branch — just the same sentence telling the truth. A
    // comparison row that is not zero is what stops a rollback being obvious.
    expect(
      canaryLine(
        [
          { fw: "2.4.1", affected: 4, total: 4 },
          { fw: "2.3.7", affected: 3, total: 4 },
        ],
        "2.4.1",
      ),
    ).toContain("3 of 4 units on 2.3.7 affected");
  });

  it("lists units in English", () => {
    expect(listUnits(["N-05"])).toBe("N-05");
    expect(listUnits(["N-05", "N-06"])).toBe("N-05 and N-06");
    expect(listUnits(["N-05", "N-06", "N-09"])).toBe("N-05, N-06 and N-09");
  });
});

describe("the confirmations", () => {
  it("names the unit a halt saves, and does not stop at the save", () => {
    const lines = haltImpact(["N-05"], "2.4.1");
    expect(lines[0]!.text).toBe("Prevents the scheduled update on N-05.");
    // The fleet-scale twin of SAFE SIT's "Service still required": halting does
    // nothing for the four units already running the build.
    const warn = lines.filter((l) => l.tone === "warn");
    expect(warn).toHaveLength(1);
    expect(warn[0]!.text).toBe("Roll back the cohort to restore them.");
  });

  it("does not promise a save the fleet is about to refuse", () => {
    const lines = haltImpact([], "2.4.1");
    expect(lines[0]!.text).toBe("No update is still queued — the fleet may refuse this.");
    expect(lines.some((l) => l.text.includes("Prevents"))).toBe(false);
  });

  it("states the staging, the alerts, and the cost of a rollback", () => {
    const lines = rollbackImpact(4, "2.4.1", []);
    expect(lines[0]!.text).toBe("Rolls back 4 units, one at a time — about 16 seconds.");
    expect(lines[1]!.text).toBe("Alerts clear as each unit completes.");
    const warn = lines.filter((l) => l.tone === "warn");
    expect(warn).toHaveLength(1);
    expect(warn[0]!.text).toBe("Reverts the 2.4.1 update on every affected unit.");
  });

  it("discloses that rolling back also cancels a queued install", () => {
    // The engine halts the rollout as a side effect (sim/engine.ts,
    // ROLLBACK_COHORT). A side effect the operator was not told about is a
    // surprise, not a side effect.
    expect(
      rollbackImpact(4, "2.4.1", ["N-05"]).some(
        (l) => l.text === "The queued update on N-05 is canceled too.",
      ),
    ).toBe(true);
  });

  it("scales the estimate with the roster", () => {
    expect(rollbackEstimate(1)).toBe("about 4 seconds");
    expect(rollbackEstimate(5)).toBe("about 20 seconds");
  });
});

describe("receipts and refusals", () => {
  it("reads the engine's receipt in the page's voice", () => {
    expect(haltReceipt("ROLLOUT HALTED — N-05 REMAINS ON 2.3.7")).toBe(
      "Rollout halted — N-05 remains on 2.3.7",
    );
  });

  it("carries an unrecognised receipt through verbatim", () => {
    // The same rule countedResolution follows in audit-line.ts: a line this
    // file does not know is still the machine's line.
    expect(haltReceipt("ROLLOUT PAUSED PENDING REVIEW")).toBe(
      "ROLLOUT PAUSED PENDING REVIEW",
    );
    expect(haltReceipt(null)).toBeNull();
  });

  it("explains the refusal that ends the storyline the other way", () => {
    const note = refusalNote("NO ROLLOUT ACTIVE");
    expect(note).toContain("already installed");
    // The honest answer to a halt that came too late is the other door.
    expect(note).toContain("Rolling back the cohort");
  });

  it("has nothing to add to a reason it does not know", () => {
    expect(refusalNote("SOMETHING NEW")).toBeNull();
    expect(refusalNote(null)).toBeNull();
  });
});

describe("the staged rollback, derived", () => {
  const ROSTER = ["N-02", "N-04", "N-06", "N-08"];
  const fwMap = (entries: Record<string, string>) => (id: string) => entries[id];

  /** Everyone still on the suspect build. */
  const allOnSuspect = fwMap({
    "N-02": "2.4.1",
    "N-04": "2.4.1",
    "N-06": "2.4.1",
    "N-08": "2.4.1",
  });

  it("walks roster order, not cohort raise order", () => {
    // The engine restores units.filter(fw) in snapshot order; a list counting
    // down in raise order would look like it had lost track.
    expect(
      rollbackRoster(
        ["N-02", "N-04", "N-05", "N-06", "N-08"],
        fwMap({
          "N-02": "2.4.1",
          "N-04": "2.4.1",
          "N-05": "2.3.7",
          "N-06": "2.4.1",
          "N-08": "2.4.1",
        }),
        "2.4.1",
      ),
    ).toEqual(ROSTER);
  });

  it("marks exactly one unit underway, and it is the first one left", () => {
    const rows = rollbackRows(ROSTER, allOnSuspect, "2.4.1", "progress");
    expect(rows.map((r) => r.phase)).toEqual([
      "rolling-back",
      "waiting",
      "waiting",
      "waiting",
    ]);
  });

  it("reads restoration off firmware, never off the engine's narration", () => {
    const rows = rollbackRows(
      ROSTER,
      fwMap({
        "N-02": "2.3.7",
        "N-04": "2.3.7",
        "N-06": "2.4.1",
        "N-08": "2.4.1",
      }),
      "2.4.1",
      "progress",
    );
    expect(rows.map((r) => r.phase)).toEqual([
      "restored",
      "restored",
      "rolling-back",
      "waiting",
    ]);
    expect(restoredCount(rows)).toBe(2);
  });

  it("animates nothing when the command was refused or never started", () => {
    for (const phase of ["failed", undefined] as const) {
      const rows = rollbackRows(ROSTER, allOnSuspect, "2.4.1", phase);
      expect(rows.every((r) => r.phase === "waiting")).toBe(true);
    }
  });

  it("takes the engine's word for it at complete", () => {
    // A list still showing a unit as waiting under a line that says the
    // rollback is done would be the console arguing with the machine on screen.
    const rows = rollbackRows(ROSTER, allOnSuspect, "2.4.1", "complete");
    expect(rows.every((r) => r.phase === "restored")).toBe(true);
  });

  it("counts up rather than down, and changes tense exactly once", () => {
    const mid = rollbackRows(
      ROSTER,
      fwMap({ "N-02": "2.3.7", "N-04": "2.4.1", "N-06": "2.4.1", "N-08": "2.4.1" }),
      "2.4.1",
      "progress",
    );
    expect(rollbackLine(mid, "progress", undefined)).toBe(
      "Rolling back 4 units — 1 of 4 restored.",
    );

    const done = rollbackRows(
      ROSTER,
      fwMap({ "N-02": "2.3.7", "N-04": "2.3.7", "N-06": "2.3.7", "N-08": "2.3.7" }),
      "2.4.1",
      "complete",
    );
    expect(rollbackLine(done, "complete", "2.3.7")).toBe(
      "Rollback complete — 4 units restored to 2.3.7.",
    );
  });

  it("never names a baseline the fleet has not reported", () => {
    const done = rollbackRows(ROSTER, () => "2.3.7", "2.4.1", "complete");
    expect(rollbackLine(done, "complete", undefined)).toBe(
      "Rollback complete — 4 units restored.",
    );
  });
});

/* ---------------------------------------------------------------------------
   when the incident closed
--------------------------------------------------------------------------- */

describe("the closing moment", () => {
  const DETECTED = 1_700_000_000_000;
  const complete = (updatedAt: number) => ({ phase: "complete" as const, updatedAt });

  /**
   * The card's header runs a clock while the incident is open and must not once
   * it is over: a settled card counting upwards over a fleet reading "Units
   * alerting 0" is the loudest thing on the page insisting the damage is
   * ongoing. The span it freezes at is read off the journals, never off the
   * console's own clock.
   */
  it("takes the last thing that closed it", () => {
    expect(
      cohortClosedAt(
        [DETECTED + 4_000, DETECTED + 8_000, DETECTED + 12_000],
        complete(DETECTED + 16_000),
      ),
    ).toBe(DETECTED + 16_000);
  });

  it("takes the last alert to clear when the fleet said nothing after it", () => {
    expect(
      cohortClosedAt([DETECTED + 9_000, DETECTED + 3_000], complete(DETECTED + 1_000)),
    ).toBe(DETECTED + 9_000);
  });

  it("ignores a rollback that is still running, or was refused", () => {
    expect(
      cohortClosedAt([], { phase: "progress", updatedAt: DETECTED + 5_000 }),
    ).toBeUndefined();
    expect(
      cohortClosedAt([], { phase: "failed", updatedAt: DETECTED + 5_000 }),
    ).toBeUndefined();
  });

  /**
   * A closure the console cannot date is not one it should put a number on —
   * the header prints no span at all rather than a made-up one, the same rule
   * `durationSince` follows before the client clock exists.
   */
  it("has nothing to say where no journal recorded a moment", () => {
    expect(cohortClosedAt([undefined, undefined], undefined)).toBeUndefined();
  });
});
