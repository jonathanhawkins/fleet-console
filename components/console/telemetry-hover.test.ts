import { afterEach, describe, expect, it, vi } from "vitest";
import { stripScales } from "./joint-spec";
import {
  clearCursor,
  cursorOffsetFor,
  currentCursor,
  offsetFromLocalX,
  resetCursor,
  setCursor,
  subscribeCursor,
} from "./telemetry-hover";

/**
 * The shared cursor.
 *
 * Two things are being protected here. The first is correctness: a pixel has to
 * map to the same sample the trace was drawn from, or the readout prints one
 * number while the dot sits on another. The second is the reason this is a
 * module variable rather than React state — a pointer that jitters inside one
 * sample's worth of pixels must not notify anybody, because "notify" means
 * eighteen canvases repaint.
 */

const WIDTH = 300;
const CAPACITY = 600;

afterEach(() => {
  resetCursor();
});

describe("offsetFromLocalX", () => {
  it("is the exact inverse of the scale the trace is drawn with", () => {
    const { x } = stripScales(CAPACITY, WIDTH, 56, {
      floor: 0,
      healthy: 1,
      top: 2,
    });
    for (const offset of [0, -1, -100, -300, -599]) {
      expect(offsetFromLocalX(x(offset), WIDTH, CAPACITY, CAPACITY)).toBe(offset);
    }
  });

  it("puts the newest sample on the right edge", () => {
    expect(offsetFromLocalX(WIDTH, WIDTH, CAPACITY, CAPACITY)).toBe(0);
    expect(offsetFromLocalX(0, WIDTH, CAPACITY, CAPACITY)).toBe(-(CAPACITY - 1));
  });

  it("clamps past either edge instead of reading off the end of the ring", () => {
    expect(offsetFromLocalX(WIDTH + 40, WIDTH, CAPACITY, CAPACITY)).toBe(0);
    expect(offsetFromLocalX(-40, WIDTH, CAPACITY, CAPACITY)).toBe(-(CAPACITY - 1));
  });

  /**
   * The window is sixty seconds wide from the moment the page opens, but the
   * ring is not. Hovering the empty left third of a forty-second-old session
   * sticks to the oldest real sample rather than reading an em-dash: that is
   * what every chart does, and it stays honest because the readout prints the
   * sample's own timestamp, not the pointer's position.
   */
  it("sticks to the oldest sample that exists rather than to the oldest pixel", () => {
    expect(offsetFromLocalX(0, WIDTH, CAPACITY, 40)).toBe(-39);
    expect(offsetFromLocalX(WIDTH, WIDTH, CAPACITY, 40)).toBe(0);
  });

  it("has nothing to say about an empty ring or an unmeasured box", () => {
    expect(offsetFromLocalX(120, WIDTH, CAPACITY, 0)).toBeNull();
    expect(offsetFromLocalX(120, 0, CAPACITY, 400)).toBeNull();
  });
});

describe("the cursor", () => {
  it("belongs to one unit at a time", () => {
    setCursor("N-07", -12, false);
    expect(cursorOffsetFor("N-07")).toBe(-12);
    expect(cursorOffsetFor("N-03")).toBeNull();

    setCursor("N-03", -4, false);
    expect(cursorOffsetFor("N-07")).toBeNull();
    expect(cursorOffsetFor("N-03")).toBe(-4);
  });

  it("reads as absent once cleared, and ignores a clear meant for someone else", () => {
    setCursor("N-07", -12, false);
    clearCursor("N-03");
    expect(cursorOffsetFor("N-07")).toBe(-12);
    clearCursor("N-07");
    expect(currentCursor()).toBeNull();
  });

  /**
   * The move that changes nothing is the common case: a 330 px column carries
   * 600 samples, so a pointer crosses roughly two samples per pixel and most
   * `pointermove` events land on the sample already under the cursor. Notifying
   * on those would dirty eighteen canvases for a cursor that has not moved.
   */
  it("says nothing when the pointer lands on the sample it is already on", () => {
    const seen = vi.fn();
    subscribeCursor(seen);

    setCursor("N-07", -12, false);
    setCursor("N-07", -12, false);
    setCursor("N-07", -12, false);
    expect(seen).toHaveBeenCalledTimes(1);

    setCursor("N-07", -13, false);
    expect(seen).toHaveBeenCalledTimes(2);

    // …but a finger arriving on the same sample a mouse was on is a different
    // state: the grid's chrome switches on `scrubbing`, not on the offset.
    setCursor("N-07", -13, true);
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it("notifies a clear exactly once", () => {
    const seen = vi.fn();
    subscribeCursor(seen);
    setCursor("N-07", -1, false);
    clearCursor();
    clearCursor();
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenLastCalledWith(null);
  });

  it("lets a subscriber leave", () => {
    const seen = vi.fn();
    const stop = subscribeCursor(seen);
    stop();
    setCursor("N-07", -1, false);
    expect(seen).not.toHaveBeenCalled();
  });
});
