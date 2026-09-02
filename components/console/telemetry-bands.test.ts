import { describe, expect, it } from "vitest";
import { RingBuffer } from "@/lib/stores";
import { envelope, METRIC_SPEC } from "./joint-spec";
import {
  breachRuns,
  breachRunScratch,
  MAX_BREACH_RUNS,
  sampleAt,
  timeAxis,
  valueAxis,
} from "./telemetry-bands";

/**
 * One envelope, three readings of it.
 *
 * The tint on the trace, the wash under it and the figures on the expanded
 * axis all answer "is this measure inside its operating envelope", and they
 * have to answer it the same way or the instrument contradicts itself in front
 * of an operator. Everything here is derived from `envelope()` and nothing is
 * given a threshold of its own.
 */

const fill = (values: number[]) => {
  const out = new Float64Array(Math.max(1, values.length));
  values.forEach((v, i) => (out[i] = v));
  return out;
};

describe("breachRuns", () => {
  const healthy = envelope("knee_L", "tempC").healthy; // 44

  it("finds one run per contiguous stretch above the ceiling", () => {
    const out = new Int32Array(16);
    const samples = fill([30, 30, 50, 51, 30, 30, 60, 30]);
    expect(breachRuns(samples, 8, healthy, out)).toBe(2);
    expect([...out.slice(0, 4)]).toEqual([2, 3, 6, 6]);
  });

  it("closes a run that is still open at the newest sample", () => {
    const out = new Int32Array(16);
    const samples = fill([30, 50, 51, 52]);
    expect(breachRuns(samples, 4, healthy, out)).toBe(1);
    expect([...out.slice(0, 2)]).toEqual([1, 3]);
  });

  it("treats the ceiling itself as inside the envelope", () => {
    const out = new Int32Array(16);
    // The guide line is where a healthy joint *stays under*, and a reading
    // exactly on it is the definition of in-spec — the same comparison
    // `breachedRecently` makes, so a strip cannot be washed and un-tinted.
    expect(breachRuns(fill([healthy, healthy, healthy]), 3, healthy, out)).toBe(0);
    expect(breachRuns(fill([healthy + 0.1]), 1, healthy, out)).toBe(1);
  });

  it("reads only the first n samples, not the whole scratch array", () => {
    const out = new Int32Array(16);
    const samples = new Float64Array(600); // zeros past the data
    samples[0] = 99;
    expect(breachRuns(samples, 1, healthy, out)).toBe(1);
    expect([...out.slice(0, 2)]).toEqual([0, 0]);
  });

  /**
   * A knee under load crosses its torque ceiling on the peak of every step, so
   * the raw runs are a hairline per stride. Drawn literally that is a barcode:
   * it reads as a rendering fault and it hides the only answer that mattered —
   * the joint was out of band *for this whole stretch*.
   */
  it("merges runs closer together than the gap into one region", () => {
    const out = new Int32Array(16);
    // three excursions a couple of samples apart, then a long calm, then one more
    const samples = fill([
      50, 30, 50, 30, 50, // 0..4
      ...Array.from({ length: 20 }, () => 30), // 5..24
      50, // 25
    ]);
    expect(breachRuns(samples, 26, healthy, out, 5)).toBe(2);
    expect([...out.slice(0, 4)]).toEqual([0, 4, 25, 25]);
  });

  it("leaves runs alone when no gap is asked for", () => {
    const out = new Int32Array(16);
    const samples = fill([50, 30, 50]);
    expect(breachRuns(samples, 3, healthy, out)).toBe(2);
    expect([...out.slice(0, 4)]).toEqual([0, 0, 2, 2]);
  });

  it("stops at the cap rather than growing, and finds nothing in an empty ring", () => {
    const out = new Int32Array(MAX_BREACH_RUNS * 2);
    const alternating = new Float64Array(600);
    for (let i = 0; i < 600; i += 1) alternating[i] = i % 2 === 0 ? 99 : 30;
    expect(breachRuns(alternating, 600, healthy, out)).toBe(MAX_BREACH_RUNS);
    expect(breachRuns(fill([]), 0, healthy, out)).toBe(0);
  });

  /**
   * The zero-allocation contract, asserted the only way it can be from a test:
   * the default output is one module-level array, and a thousand calls hand
   * back the same one. If this ever starts returning a fresh array the grid's
   * hover path begins allocating at pointer rate, which is precisely the cost
   * the whole canvas layer exists to avoid.
   */
  it("writes into one shared array, however many times it is called", () => {
    const first = breachRunScratch();
    const samples = fill([30, 99, 30]);
    for (let i = 0; i < 1_000; i += 1) breachRuns(samples, 3, healthy);
    expect(breachRunScratch()).toBe(first);
    expect([...first.slice(0, 2)]).toEqual([1, 1]);
  });
});

describe("valueAxis", () => {
  it("prints the envelope, top down, and names the line that matters", () => {
    const axis = valueAxis(envelope("knee_L", "tempC"), METRIC_SPEC.tempC);
    expect(axis.map((a) => a.text)).toEqual(["60 °C", "44 °C", "26 °C"]);
    expect(axis.filter((a) => a.reference).map((a) => a.value)).toEqual([44]);
  });

  it("keeps a decimal only where the envelope actually has one", () => {
    // Current's ceilings are tenths and rounding them would print a limit the
    // hardware does not have; temperature's are whole numbers and a trailing
    // ".0" would imply a precision the spec sheet never claimed.
    expect(valueAxis(envelope("knee_L", "currentA"), METRIC_SPEC.currentA)[1]!.text).toBe(
      "2.4 A",
    );
    expect(valueAxis(envelope("hip_L", "torqueNm"), METRIC_SPEC.torqueNm)[1]!.text).toBe(
      "23 N·m",
    );
  });

  it("scales a left/right pair identically", () => {
    expect(valueAxis(envelope("knee_L", "torqueNm"), METRIC_SPEC.torqueNm)).toEqual(
      valueAxis(envelope("knee_R", "torqueNm"), METRIC_SPEC.torqueNm),
    );
  });
});

describe("timeAxis", () => {
  it("states the window in seconds, newest on the right", () => {
    expect(timeAxis(600)).toEqual([
      { offset: -599, text: "−60 s", anchor: "start" },
      { offset: -300, text: "−30 s", anchor: "middle" },
      { offset: 0, text: "now", anchor: "end" },
    ]);
  });
});

describe("sampleAt", () => {
  const ring = (values: number[]) => {
    const r = new RingBuffer(600);
    for (const v of values) r.push(v);
    return r;
  };

  it("counts back from the newest sample, the way the cursor does", () => {
    const r = ring([10, 20, 30, 40]);
    expect(sampleAt(r, 0)).toBe(40);
    expect(sampleAt(r, -3)).toBe(10);
  });

  it("returns nothing off either end rather than a plausible wrong number", () => {
    const r = ring([10, 20]);
    expect(sampleAt(r, -2)).toBeUndefined();
    expect(sampleAt(r, 1)).toBeUndefined();
    expect(sampleAt(ring([]), 0)).toBeUndefined();
  });
});
