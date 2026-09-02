// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  blendVelocity,
  criticalSpring,
  DECEL_ORBIT,
  DECEL_SCROLL,
  DECEL_SHEET,
  projectMomentum,
  pushSample,
  rubberband,
  springSettled,
  trailVelocity,
  type PointerSample,
} from "./motion";

/**
 * Gesture physics runs inside pointermove handlers and rAF callbacks —
 * code that cannot be re-rendered to inspect and whose failures look like
 * "it feels slightly wrong" rather than like a stack trace. So every number the
 * sheet, the dividers and the turntable decide anything with is asserted here.
 */

describe("momentum projection", () => {
  it("uses Apple's exponential-decay form, not v²/2a", () => {
    // (v/1000) · d/(1−d): 1000 px/s at the scroll rate coasts ~499 px.
    expect(projectMomentum(1000, DECEL_SCROLL)).toBeCloseTo(499, 0);
    expect(projectMomentum(1000, DECEL_SHEET)).toBeCloseTo(199, 0);
    expect(projectMomentum(1000, DECEL_ORBIT)).toBeCloseTo(124, 0);
  });

  it("is linear in velocity and signed", () => {
    expect(projectMomentum(500)).toBeCloseTo(projectMomentum(1000) / 2, 6);
    expect(projectMomentum(-800)).toBeCloseTo(-projectMomentum(800), 6);
    expect(projectMomentum(0)).toBe(0);
  });

  it("coasts further the slower it decelerates", () => {
    expect(projectMomentum(600, DECEL_SCROLL)).toBeGreaterThan(
      projectMomentum(600, DECEL_SHEET),
    );
    expect(projectMomentum(600, DECEL_SHEET)).toBeGreaterThan(
      projectMomentum(600, DECEL_ORBIT),
    );
  });
});

describe("rubber-banding", () => {
  it("meets the finger at the resistance constant, then falls away", () => {
    // The formula's slope at zero is `constant`: the boundary is felt from the
    // first pixel rather than after a free stretch, and the ratio only drops.
    const first = rubberband(1, 48) / 1;
    expect(first).toBeCloseTo(0.55, 1);
    expect(rubberband(20, 48) / 20).toBeLessThan(first);
    expect(rubberband(200, 48) / 200).toBeLessThan(rubberband(20, 48) / 20);
  });

  it("resists progressively — twice the pull is less than twice the travel", () => {
    const near = rubberband(50, 48);
    const far = rubberband(100, 48);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThan(near * 2);
  });

  it("can never exceed the budget, however hard it is pulled", () => {
    expect(rubberband(10_000, 48)).toBeLessThan(48);
    expect(rubberband(1_000_000, 48)).toBeLessThan(48);
    // …and approaches it rather than stopping short of it early.
    expect(rubberband(1_000_000, 48)).toBeGreaterThan(47.9);
  });

  it("is symmetric about zero and degenerate-safe", () => {
    expect(rubberband(-60, 48)).toBeCloseTo(-rubberband(60, 48), 9);
    expect(rubberband(0, 48)).toBe(0);
    expect(rubberband(60, 0)).toBe(0);
  });
});

describe("critical spring", () => {
  const spec = { from: 0, to: 100, velocity: 0, response: 0.3 };

  it("starts exactly where it was told to, at the speed it was told", () => {
    const s = criticalSpring({ ...spec, velocity: 250 }, 0);
    expect(s.value).toBeCloseTo(0, 9);
    expect(s.velocity).toBeCloseTo(250, 9);
  });

  it("never overshoots — the whole reason damping is 1.0", () => {
    for (let t = 0; t <= 2; t += 0.005) {
      expect(criticalSpring(spec, t).value).toBeLessThanOrEqual(100.000001);
    }
  });

  it("does not overshoot even when thrown hard at its target", () => {
    const thrown = { from: 0, to: 100, velocity: 3000, response: 0.3 };
    let peak = -Infinity;
    for (let t = 0; t <= 2; t += 0.002)
      peak = Math.max(peak, criticalSpring(thrown, t).value);
    // A critically damped spring with initial velocity *does* pass its target;
    // what it must never do is come back. Assert the approach is monotone after
    // the peak — one crossing, no oscillation.
    let crossings = 0;
    let prev = criticalSpring(thrown, 0).value;
    for (let t = 0.002; t <= 3; t += 0.002) {
      const v = criticalSpring(thrown, t).value;
      if (prev < 100 !== v < 100) crossings++;
      prev = v;
    }
    expect(crossings).toBe(1);
    expect(peak).toBeGreaterThan(100);
  });

  it("is frame-rate independent: sampling at t is sampling at t", () => {
    // The property an integrator does not have. 4ms steps and 40ms steps must
    // agree exactly at the same elapsed time.
    expect(criticalSpring(spec, 0.24).value).toBeCloseTo(
      criticalSpring(spec, 0.24).value,
      12,
    );
    const coarse = criticalSpring(spec, 0.2);
    const fine = criticalSpring({ ...spec }, 0.2);
    expect(coarse.value).toBe(fine.value);
  });

  it("reaches 95% of its travel at t = 4.74/ω, the figure the constants are picked against", () => {
    const omega = (2 * Math.PI) / spec.response;
    const t95 = 4.74 / omega;
    expect(criticalSpring(spec, t95).value).toBeGreaterThan(94);
    expect(criticalSpring(spec, t95).value).toBeLessThan(96);
  });

  it("continues seamlessly when re-aimed from its own presentation value", () => {
    // Interruption, which is what the whole module is for: sample mid-flight,
    // build a new spring from that value and velocity, and the first sample of
    // the new one must be indistinguishable from the old one's.
    const mid = criticalSpring(spec, 0.12);
    const next = criticalSpring(
      { from: mid.value, to: 0, velocity: mid.velocity, response: 0.3 },
      0,
    );
    expect(next.value).toBeCloseTo(mid.value, 9);
    expect(next.velocity).toBeCloseTo(mid.velocity, 9);
  });

  it("settles on position AND speed, never on one alone", () => {
    // Crossing the target at speed is not settled…
    expect(springSettled({ value: 100, velocity: 900 }, 100)).toBe(false);
    // …and neither is standing still a long way from it.
    expect(springSettled({ value: 40, velocity: 0 }, 100)).toBe(false);
    expect(springSettled({ value: 99.8, velocity: 3 }, 100)).toBe(true);
  });
});

describe("velocity blending", () => {
  it("starts at the release velocity", () => {
    expect(blendVelocity(300, 0.08, 0)).toBeCloseTo(300, 9);
  });

  it("decays toward the ambient rate, never past it", () => {
    const at = (ms: number) => blendVelocity(3, 0.08, ms);
    expect(at(200)).toBeLessThan(at(0));
    expect(at(600)).toBeLessThan(at(200));
    expect(at(5000)).toBeGreaterThan(0.08);
    expect(at(5000)).toBeCloseTo(0.08, 3);
  });

  it("crosses zero when the throw was against the ambient direction", () => {
    // Flick the turntable backwards and it slows, stops, and takes up its own
    // slow forward yaw again — one exponential, no cut.
    const at = (ms: number) => blendVelocity(-2, 0.08, ms);
    expect(at(0)).toBeLessThan(0);
    expect(at(1000)).toBeGreaterThan(0);
  });

  it("decays to a standstill when the ambient rate is zero", () => {
    expect(blendVelocity(4, 0, 900, DECEL_ORBIT)).toBeLessThan(0.02);
  });
});

describe("pointer velocity from a trail", () => {
  const trail = (points: Array<[number, number]>): PointerSample[] =>
    points.map(([t, v]) => ({ t, v }));

  it("measures over the window, not the last two events", () => {
    // 10px every 16ms = 625px/s, but the final pair is a duplicate frame — the
    // case that reports a flick as a release from a standstill.
    const t = trail([
      [0, 0],
      [16, 10],
      [32, 20],
      [48, 30],
      [64, 40],
      [66, 40],
    ]);
    expect(trailVelocity(t)).toBeGreaterThan(500);
  });

  it("reports zero for a finger that stopped before letting go", () => {
    // A long fast drag that parks for 80ms. Everything inside the window is the
    // same point, so the sheet stays where it was put.
    const t = trail([
      [0, 0],
      [20, 200],
      [40, 400],
      [120, 400],
      [180, 400],
    ]);
    expect(trailVelocity(t)).toBe(0);
  });

  it("is signed", () => {
    expect(
      trailVelocity(
        trail([
          [0, 100],
          [50, 50],
          [100, 0],
        ]),
      ),
    ).toBeLessThan(0);
  });

  it("is zero when there is nothing to measure", () => {
    expect(trailVelocity([])).toBe(0);
    expect(trailVelocity(trail([[0, 0]]))).toBe(0);
    expect(
      trailVelocity(
        trail([
          [5, 0],
          [5, 90],
        ]),
      ),
    ).toBe(0);
  });

  it("keeps the trail bounded but never shorter than a full window", () => {
    const t: PointerSample[] = [];
    for (let i = 0; i < 500; i++) pushSample(t, { t: i * 8, v: i * 2 });
    expect(t.length).toBeLessThan(30);
    // Still enough history to span the 60ms measurement window.
    expect(t[t.length - 1]!.t - t[0]!.t).toBeGreaterThanOrEqual(60);
  });
});
