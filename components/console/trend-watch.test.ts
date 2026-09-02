import { describe, expect, it } from "vitest";
import { JOINTS } from "./joint-spec";
import { trendDetail, trendSpeech, type UnitTrend } from "./trend-watch";

/**
 * The watch's operator-space voice. Two rules worth a test rather than a
 * comment: the wire's vocabulary never reaches a human, and the spoken form
 * never leans on a symbol a screen reader may or may not read out.
 */

const trend = (over: Partial<UnitTrend> = {}): UnitTrend => ({
  joint: "knee_L",
  cPerMin: 18,
  ...over,
});

describe("trendDetail", () => {
  it("names the joint the way an operator does, and the number as a rate", () => {
    expect(trendDetail(trend())).toBe("left knee +18 °C/min");
  });

  it("never leaks a wire identifier, for any joint on the robot", () => {
    for (const joint of JOINTS) {
      const line = trendDetail(trend({ joint }));
      expect(line).not.toContain("_");
      expect(line).toMatch(/^(left|right) (hip|knee|ankle) \+18 °C\/min$/);
    }
  });

  it("falls back to the wire name rather than to nothing on an unknown joint", () => {
    // jointLabel's own contract (joint-spec.ts) — a joint the console has never
    // heard of is still a joint the console must be able to name.
    expect(trendDetail(trend({ joint: "wrist_L" }))).toBe("wrist_L +18 °C/min");
  });
});

describe("trendSpeech", () => {
  it("spells the symbols out, the way the row spells out 'percent'", () => {
    expect(trendSpeech(trend())).toBe(
      "Trending: left knee climbing 18 degrees Celsius per minute.",
    );
    expect(trendSpeech(trend())).not.toContain("°");
  });

  it("ends as a sentence, so it composes into a row's accessible name", () => {
    expect(trendSpeech(trend({ joint: "ankle_R", cPerMin: 21 }))).toBe(
      "Trending: right ankle climbing 21 degrees Celsius per minute.",
    );
  });
});
