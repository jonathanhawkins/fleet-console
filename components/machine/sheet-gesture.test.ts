// @vitest-environment node
import { spring } from "framer-motion";
import { describe, expect, it } from "vitest";
import {
  COMMIT_FRACTION,
  DRAG_SLOP_PX,
  FLICK_VELOCITY_PX_S,
  releaseSpring,
  RUBBER_CEILING_PX,
  sheetOffset,
  sheetRelease,
  SPRING_MINIMIZE_S,
  SPRING_RESTORE_S,
  SPRING_SETTLE_S,
  springTransition,
  type SheetSpring,
} from "./sheet-gesture";

/**
 * / The verdict sheet's release decision, which runs once per
 * gesture inside a pointerup handler and has exactly one chance to be right.
 *
 * The height throughout is 744 px — what a 390×844 phone actually renders the
 * sheet at between the session header and the status rule, measured rather than
 * assumed, so the thresholds below are the ones a thumb meets.
 */
const H = 744;
const commitAt = H * COMMIT_FRACTION; // 260.4px

/** framer's spring generator, aimed the way the sheet aims it. Time in ms. */
const generator = (s: SheetSpring) =>
  spring({
    keyframes: [s.from, s.to],
    velocity: s.velocity,
    ...springTransition(s.response),
  });

describe("tracking", () => {
  it("follows the finger 1:1 downward, with no resistance at all", () => {
    expect(sheetOffset(0)).toBe(0);
    expect(sheetOffset(120)).toBe(120);
    expect(sheetOffset(700)).toBe(700);
  });

  it("rubber-bands upward against a small budget", () => {
    // 112px of upward pull yields about 27px of travel — enough to read as
    // resistance, never enough to reach the session header above it.
    expect(sheetOffset(-112)).toBeCloseTo(-27, 0);
    expect(sheetOffset(-40)).toBeGreaterThan(-40);
  });

  it("can never travel above full by more than the ceiling", () => {
    expect(Math.abs(sheetOffset(-10_000))).toBeLessThan(RUBBER_CEILING_PX);
    expect(Math.abs(sheetOffset(-500))).toBeLessThan(RUBBER_CEILING_PX);
  });
});

describe("release: velocity beats position", () => {
  it("commits a flick from near the top, where position says settle", () => {
    // 40px down — 5% of the sheet — but thrown. The gesture said what it meant.
    expect(sheetRelease({ offset: 40, velocity: 1800, height: H })).toBe("minimize");
    expect(40).toBeLessThan(commitAt);
  });

  it("settles an upward flick from below the commit line, where position says minimize", () => {
    expect(sheetRelease({ offset: 500, velocity: -1200, height: H })).toBe("settle");
    expect(500).toBeGreaterThan(commitAt);
  });

  it("switches at the flick threshold itself", () => {
    const at = (v: number) => sheetRelease({ offset: 30, velocity: v, height: H });
    expect(at(FLICK_VELOCITY_PX_S)).toBe("minimize");
    expect(at(FLICK_VELOCITY_PX_S - 1)).toBe("settle");
  });
});

describe("release: projection decides the slow drags", () => {
  it("uses where the gesture is going, not where it stopped", () => {
    // Parked 40px short of the line but still drifting down: 200px/s projects
    // ~40px at the sheet's deceleration rate, which carries it over.
    const offset = commitAt - 40;
    expect(sheetRelease({ offset, velocity: 0, height: H })).toBe("settle");
    expect(sheetRelease({ offset, velocity: 250, height: H })).toBe("minimize");
  });

  it("keeps a sheet that was carefully parked exactly where it was parked", () => {
    // A finger that stopped before lifting reports zero (trailVelocity), so a
    // sheet held just short of the line comes home rather than committing.
    expect(sheetRelease({ offset: commitAt - 1, velocity: 0, height: H })).toBe("settle");
    expect(sheetRelease({ offset: commitAt + 1, velocity: 0, height: H })).toBe(
      "minimize",
    );
  });

  it("settles anything released inside the rubber band", () => {
    expect(sheetRelease({ offset: -20, velocity: 0, height: H })).toBe("settle");
    expect(sheetRelease({ offset: -20, velocity: 300, height: H })).toBe("settle");
  });

  it("scales its threshold with the sheet, not with a fixed pixel count", () => {
    // The same absolute offset means different things on a phone and a tablet.
    expect(sheetRelease({ offset: 300, velocity: 0, height: 744 })).toBe("minimize");
    expect(sheetRelease({ offset: 300, velocity: 0, height: 1000 })).toBe("settle");
  });
});

describe("the spring the release hands off to", () => {
  it("starts from the sheet's live offset at the finger's live speed", () => {
    const input = { offset: 210, velocity: 640, height: H };
    const spring = releaseSpring(input, "minimize");
    expect(spring.from).toBe(210);
    expect(spring.velocity).toBe(640);
    expect(spring.to).toBe(H);
    // Which means frame zero of the animation is exactly the last frame of the
    // drag: no stutter at the seam.
    const first = generator(spring);
    expect(first.next(0).value).toBeCloseTo(210, 9);
    expect(first.velocity?.(0)).toBeCloseTo(640, 9);
  });

  it("aims a settle at rest and a minimize at the far edge", () => {
    const input = { offset: 120, velocity: -80, height: H };
    expect(releaseSpring(input, "settle").to).toBe(0);
    expect(releaseSpring(input, "minimize").to).toBe(H);
  });
});

describe("the physics a response becomes", () => {
  it("is critically damped: the fastest return that cannot overshoot", () => {
    for (const response of [SPRING_SETTLE_S, SPRING_MINIMIZE_S, SPRING_RESTORE_S]) {
      const { stiffness, damping, mass } = springTransition(response);
      expect(damping).toBeCloseTo(2 * Math.sqrt(stiffness * mass), 9);
    }
  });

  it("reads `response` as the period: 95% of travel at 4.74/ω", () => {
    const t95 = (response: number) => (4.74 / (2 * Math.PI)) * response * 1000;
    for (const response of [SPRING_SETTLE_S, SPRING_MINIMIZE_S, SPRING_RESTORE_S]) {
      const at = generator({ from: 0, to: H, velocity: 0, response }).next(
        t95(response),
      ).value;
      expect(at / H).toBeGreaterThan(0.94);
      expect(at / H).toBeLessThan(0.96);
    }
  });

  it("carries a throw through to the far edge without passing it", () => {
    const gen = generator({
      from: 210,
      to: H,
      velocity: 2000,
      response: SPRING_SETTLE_S,
    });
    let prev = 210;
    for (let t = 0; t <= 1000; t += 4) {
      const { value } = gen.next(t);
      expect(value).toBeLessThanOrEqual(H + 1e-9);
      expect(value).toBeGreaterThanOrEqual(prev - 1e-9); // monotonic: no bounce
      prev = value;
    }
    expect(prev).toBe(H);
  });
});

describe("the constants keep the promises the docs make", () => {
  it("puts every un-gestured path inside the PRD's 120–180ms micro band", () => {
    // "Complete" = 95% of travel, the point the eye stops following.
    const t95 = (response: number) => (4.74 / (2 * Math.PI)) * response * 1000;
    expect(t95(SPRING_MINIMIZE_S)).toBeGreaterThan(120);
    expect(t95(SPRING_MINIMIZE_S)).toBeLessThan(180);
    expect(t95(SPRING_RESTORE_S)).toBeLessThan(200);
    // …and the return is slower than the exit, as the descent's own two halves
    // are (PRD §5).
    expect(SPRING_RESTORE_S).toBeGreaterThan(SPRING_MINIMIZE_S);
  });

  it("gives a released gesture a longer, gentler spring than a tapped control", () => {
    // A throw has its own momentum to spend; a button press has none to carry.
    expect(SPRING_SETTLE_S).toBeGreaterThan(SPRING_MINIMIZE_S);
  });

  it("keeps the tap threshold at the platform's ten pixels", () => {
    expect(DRAG_SLOP_PX).toBe(10);
  });
});
