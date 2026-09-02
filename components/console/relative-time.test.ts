import { describe, expect, it } from "vitest";
import { formatRecency, isoTime } from "./relative-time";

/**
 * Coarse on purpose. The label answers "is this fresh?", and a figure that
 * resolved to the second would imply a precision the 10 Hz batch cadence does
 * not have.
 */

const NOW = 1_700_000_000_000;
const at = (secondsAgo: number) => formatRecency(NOW - secondsAgo * 1000, NOW);

describe("formatRecency", () => {
  it("calls anything inside five seconds fresh", () => {
    expect(at(0)).toBe("just now");
    expect(at(4)).toBe("just now");
  });

  it("counts seconds, then minutes, then hours, then days", () => {
    expect(at(5)).toBe("5s ago");
    expect(at(59)).toBe("59s ago");
    expect(at(60)).toBe("1m ago");
    expect(at(59 * 60)).toBe("59m ago");
    expect(at(60 * 60)).toBe("1h ago");
    expect(at(23 * 3600)).toBe("23h ago");
    expect(at(48 * 3600)).toBe("2d ago");
  });

  it("never renders a negative age from a clock that ran ahead", () => {
    expect(formatRecency(NOW + 5_000, NOW)).toBe("just now");
  });

  it("says nothing rather than something wrong", () => {
    // no timestamp: the unit has never reported
    expect(formatRecency(undefined, NOW)).toBeNull();
    // no clock: server render, where a relative label would hydrate stale
    expect(formatRecency(NOW, 0)).toBeNull();
    expect(formatRecency(Number.NaN, NOW)).toBeNull();
  });
});

describe("isoTime", () => {
  it("gives <time> something machine-readable, or nothing at all", () => {
    expect(isoTime(NOW)).toBe(new Date(NOW).toISOString());
    expect(isoTime(undefined)).toBeUndefined();
    expect(isoTime(Number.NaN)).toBeUndefined();
  });
});
