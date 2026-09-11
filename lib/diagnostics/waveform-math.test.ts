// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  channelTone,
  gainRatio,
  RMS_FAILING,
  RMS_HEALTHY,
  rmsDelta,
  TONE_BY_INDEX,
  writeSampleTones,
} from "./waveform-math";

/**
 * These thresholds are the simulator's tested contract, not this module's
 * opinion: sim/diagnostics.test.ts asserts every healthy channel under 0.05 RMS
 * of its reference and the failing knee over 0.12. The tests below pin the
 * console to the same two numbers, so the strip that tints a trace, the board
 * that flips a chip and the log that prints a reading can never disagree about
 * whether a channel is healthy.
 */

/** Three gait cycles, shaped like the sim's reference table. */
const reference = (n = 120): number[] =>
  Array.from({ length: n }, (_, i) => {
    const theta = (2 * Math.PI * 3 * i) / n;
    return 0.55 * (0.78 * Math.sin(theta) + 0.22 * Math.sin(2 * theta + 0.9));
  });

/** The scripted fault: gain ramping 1.35x → 1.8x across the window. */
const ramped = (ref: number[], from = 1.35, to = 1.8): number[] =>
  ref.map((v, i) => v * (from + (to - from) * (i / (ref.length - 1))));

describe("rmsDelta", () => {
  it("is zero for a trace that matches its reference", () => {
    const ref = reference();
    expect(rmsDelta(ref, ref)).toBe(0);
  });

  it("clamps a window that reaches past either end", () => {
    const ref = reference(10);
    expect(rmsDelta(ref, ref, -50, 500)).toBe(0);
    expect(rmsDelta(ref, ref, 5, 5)).toBe(0);
  });

  it("reproduces the sim contract's two sides", () => {
    const ref = reference();
    const healthy = ref.map((v) => v * 1.02);
    const failing = ramped(ref);
    expect(rmsDelta(healthy, ref)).toBeLessThan(RMS_HEALTHY);
    expect(rmsDelta(failing, ref)).toBeGreaterThan(RMS_FAILING);
  });

  it("grows across the fault's window, because the fault does", () => {
    const ref = reference();
    const failing = ramped(ref);
    const first = rmsDelta(failing, ref, 0, 60);
    const second = rmsDelta(failing, ref, 60, 120);
    expect(second).toBeGreaterThan(first * 1.2);
  });
});

describe("channelTone", () => {
  it("maps the two thresholds onto the three machine-space slots", () => {
    expect(channelTone(0)).toBe("nominal");
    expect(channelTone(RMS_HEALTHY)).toBe("nominal");
    expect(channelTone(0.08)).toBe("warn");
    expect(channelTone(RMS_FAILING)).toBe("warn");
    expect(channelTone(0.2)).toBe("alert");
  });
});

describe("gainRatio", () => {
  it("reads a pure gain fault as its peak ratio", () => {
    const ref = reference();
    expect(
      gainRatio(
        ref.map((v) => v * 1.6),
        ref,
      ),
    ).toBeCloseTo(1.6, 2);
    expect(gainRatio(ref, ref)).toBeCloseTo(1, 5);
  });

  it("does not divide by a silent reference", () => {
    expect(gainRatio([0.5, 0.5], [0, 0])).toBe(1);
  });
});

describe("writeSampleTones", () => {
  it("keeps a healthy channel phosphor from end to end", () => {
    const ref = reference();
    const out = new Uint8Array(ref.length);
    writeSampleTones(
      ref.map((v) => v * 1.02),
      ref,
      out,
    );
    expect([...out].every((t) => t === 0)).toBe(true);
  });

  it("walks the failing channel through amber into red, and never back", () => {
    const ref = reference();
    const out = new Uint8Array(ref.length);
    writeSampleTones(ramped(ref), ref, out);

    // It is the *developing* fault that has to read: the trace leaves in a
    // lower tone than it arrives in.
    expect(out[0]).toBeLessThan(out[out.length - 1]!);
    expect(out[out.length - 1]).toBe(2); // alert by the end

    // A gain that only ramps upward must never tint back down — a trace that
    // recovered mid-sweep would be telling the operator the fault healed.
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]!);
    }

    // …and there is a real amber lead-in, not a one-sample rounding artefact.
    expect([...out].filter((t) => t === 1).length).toBeGreaterThan(3);
  });

  it("writes only as far as the buffer it was given", () => {
    const ref = reference();
    const out = new Uint8Array(10);
    writeSampleTones(ramped(ref), ref, out);
    expect(out).toHaveLength(10);
  });

  it("indexes into the tone names the strip paints with", () => {
    expect(TONE_BY_INDEX).toEqual(["nominal", "warn", "alert"]);
  });
});
