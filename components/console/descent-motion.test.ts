// @vitest-environment node
import { describe, expect, it } from "vitest";
import { descentDurationMs, descentTimeline, EASE_WIPE, secs } from "./descent-motion";

/**
 * The descent is the demo's signature and its timings are a design decision,
 * not an implementation detail — so they are asserted rather than left to drift
 * the next time someone opens the stage to add a panel.
 */
describe("descent timeline", () => {
  const full = descentTimeline(false);
  const reduced = descentTimeline(true);

  it("runs PRD §5's three beats in order: 200 ms drain, then a 350 ms wipe, then the boot", () => {
    expect(full.dimMs).toBe(200);
    expect(full.wipeAtMs).toBe(full.dimMs); // the wipe starts as the drain lands
    expect(full.wipeMs).toBe(350);
    expect(full.bootAtMs).toBe(full.wipeAtMs + full.wipeMs);
  });

  it("boots eight elements inside the 400-600 ms the brief allows, at a 40-70 ms stagger", () => {
    expect(full.bootStaggerMs).toBeGreaterThanOrEqual(40);
    expect(full.bootStaggerMs).toBeLessThanOrEqual(70);

    const boot = descentDurationMs(full, 8) - full.bootAtMs;
    expect(boot).toBeGreaterThanOrEqual(400);
    expect(boot).toBeLessThanOrEqual(600);
  });

  it("dims the leading edge into the board's frame line, slower than any other beat", () => {
    expect(full.edgeDimMs).toBe(450);
    // The one beat nobody is meant to watch: longer than the wipe it followed,
    // so it never reads as a second event after the surface lands.
    expect(full.edgeDimMs).toBeGreaterThan(full.wipeMs);
    // Nothing leads a crossfade, so there is no edge to dim.
    expect(reduced.edgeDimMs).toBe(0);
  });

  it("takes the board off ahead of the surface, on the same beat in both timelines", () => {
    expect(full.boardExitMs).toBe(120);
    // It has to be gone before the wipe arrives, or the surface carries a
    // half-erased instrument up the screen.
    expect(full.boardExitMs).toBeLessThan(full.ascentWipeMs);
    expect(reduced.boardExitMs).toBeLessThan(reduced.ascentWipeMs);
    // An opacity fade is already the reduced idiom, so it does not collapse.
    expect(reduced.boardExitMs).toBe(full.boardExitMs);
  });

  it("ascends faster than it descends, in both halves", () => {
    expect(full.ascentWipeMs).toBe(250);
    expect(full.ascentWipeMs).toBeLessThan(full.wipeMs);
    expect(full.ascentRestoreMs).toBe(150);
    expect(full.ascentRestoreMs).toBeLessThan(full.dimMs);
  });

  it("wipes on a steep-start, soft-landing curve rather than an ease-in-out", () => {
    const [x1, y1, x2, y2] = EASE_WIPE;
    // Leaves with conviction: the curve is above the diagonal from the start.
    expect(y1).toBeGreaterThan(x1);
    // Settles rather than arrives: the second control point is pinned near the
    // end value while still early in the timeline.
    expect(y2).toBeGreaterThanOrEqual(0.99);
    expect(x2).toBeLessThan(0.5);
  });

  it("collapses to one crossfade with zero offsets under prefers-reduced-motion", () => {
    expect(reduced.reduced).toBe(true);
    expect(reduced.wipeMs).toBe(200);
    // Nothing may wait on a beat that no longer exists.
    expect(reduced.wipeAtMs).toBe(0);
    expect(reduced.bootAtMs).toBe(0);
    expect(reduced.bootStaggerMs).toBe(0);
    // The whole thing is over in the 200 ms the PRD budgets for the swap.
    expect(descentDurationMs(reduced, 8)).toBe(200);
  });

  it("returns stable objects, so a re-render cannot restart a played animation", () => {
    expect(descentTimeline(false)).toBe(full);
    expect(descentTimeline(true)).toBe(reduced);
  });

  it("converts to framer's seconds", () => {
    expect(secs(350)).toBeCloseTo(0.35);
  });
});
