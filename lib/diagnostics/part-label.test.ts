import { describe, expect, it } from "vitest";
import { componentHeadline, componentLabel } from "./part-label";

/**
 * One formatter, because two surfaces name the same part.
 *
 * The hyphen is the whole point: the banner and the panel have to write A-07
 * the same way, and a console that calls it A-07 in one place and A07 in
 * another looks like it is describing two components.
 */

describe("componentLabel", () => {
  it("writes the wire's part the way a work order does", () => {
    expect(componentLabel("actuator_A07")).toBe("actuator A-07");
  });

  it("hyphenates every series letter it finds", () => {
    expect(componentLabel("sensor_B12_bus")).toBe("sensor B-12 bus");
  });

  it("leaves a part with no series number alone", () => {
    expect(componentLabel("harness_main")).toBe("harness main");
  });
});

describe("componentHeadline", () => {
  it("opens a headline with a capital", () => {
    expect(componentHeadline("actuator_A07")).toBe("Actuator A-07");
  });

  it("is safe on an empty string", () => {
    expect(componentHeadline("")).toBe("");
  });
});
