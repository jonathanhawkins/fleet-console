import { describe, expect, it } from "vitest";
import {
  COMPONENT_IDS,
  COMPONENT_LABELS,
  COMPONENT_ORDER,
  componentForJoint,
  componentHighlight,
  componentNamedIn,
  componentStatus,
  cycleSelection,
  emissiveIntensity,
  highlightNeedsFrames,
  PULSE_PERIOD_MS,
  selectionKey,
  SERVICE_DISCLAIMER,
  SERVICE_RECORDS,
  serviceDateLabel,
  serviceDueInDays,
  serviceRecord,
  STEADY_EMISSIVE,
  type ComponentId,
} from "./component-spec";

/**
 * The component view's rules, tested where they live: as pure functions, with
 * no WebGL anywhere near them.
 *
 * That split is the point of this module existing. The thing the section is
 * *for* — pointing at the part an incident implicates, and only when the
 * console genuinely knows which one — is a state machine over two stores, and
 * a state machine is a unit test. What is left in the R3F chunk is meshes,
 * lights and a camera, which are a screenshot.
 */

describe("the eight components", () => {
  it("orders every id exactly once, top-down, actuator after its leg", () => {
    expect([...COMPONENT_ORDER].sort()).toEqual([...COMPONENT_IDS].sort());
    expect(COMPONENT_ORDER.indexOf("knee_actuator_L")).toBe(
      COMPONENT_ORDER.indexOf("leg_L") + 1,
    );
    expect(COMPONENT_ORDER.indexOf("knee_actuator_R")).toBe(
      COMPONENT_ORDER.indexOf("leg_R") + 1,
    );
  });

  it("labels every component in operator voice — sentence case, no wire names", () => {
    for (const id of COMPONENT_IDS) {
      const label = COMPONENT_LABELS[id];
      expect(label).not.toMatch(/_/);
      expect(label[0]).toBe(label[0]?.toUpperCase());
      expect(label.slice(1)).toBe(label.slice(1).toLowerCase());
    }
  });
});

describe("componentForJoint", () => {
  it("resolves a knee to the actuator that drives it — the serviceable item", () => {
    expect(componentForJoint("knee_L")).toBe("knee_actuator_L");
    expect(componentForJoint("knee_R")).toBe("knee_actuator_R");
  });

  it("resolves hips and ankles to the limb that carries them", () => {
    expect(componentForJoint("hip_L")).toBe("leg_L");
    expect(componentForJoint("ankle_R")).toBe("leg_R");
  });

  it("keeps the anatomical side — a front view must never mirror the fault", () => {
    expect(componentForJoint("knee_L")).toMatch(/_L$/);
    expect(componentForJoint("knee_R")).toMatch(/_R$/);
  });

  it("returns null for a joint it does not model, rather than guessing", () => {
    expect(componentForJoint("wrist_L")).toBeNull();
    expect(componentForJoint(null)).toBeNull();
    expect(componentForJoint(undefined)).toBeNull();
  });
});

describe("componentNamedIn", () => {
  it("finds the part the sim's own alert sentence names", () => {
    expect(componentNamedIn("N-07: left knee actuator running hot")).toBe(
      "knee_actuator_L",
    );
    expect(
      componentNamedIn("N-07: left knee actuator overheating, torque ripple detected"),
    ).toBe("knee_actuator_L");
  });

  it("prefers the most specific label, not the first substring that matches", () => {
    // "Left leg" is not in the sentence, but a naive shorter-first match over
    // a growing vocabulary is exactly how a knee fault ends up marked as a leg.
    expect(componentNamedIn("left knee actuator running hot")).toBe("knee_actuator_L");
    expect(componentNamedIn("left leg is dragging")).toBe("leg_L");
  });

  it("is case-insensitive, because the feed capitalises and the page does not", () => {
    expect(componentNamedIn("LEFT KNEE ACTUATOR RUNNING HOT")).toBe("knee_actuator_L");
  });

  it("names nothing when the alert names nothing this viewer can point at", () => {
    expect(componentNamedIn("battery low")).toBeNull();
    expect(componentNamedIn("")).toBeNull();
    expect(componentNamedIn(null)).toBeNull();
  });
});

describe("componentHighlight", () => {
  const quiet = {
    status: "nominal",
    alertMessage: null,
    flaggedJoint: null,
    verdictJoint: null,
  } as const;

  it("lights nothing on a healthy unit", () => {
    expect(componentHighlight(quiet)).toBeNull();
  });

  it("pulses the part an alert names, in the unit's own severity", () => {
    expect(
      componentHighlight({
        ...quiet,
        status: "amber",
        alertMessage: "N-07: left knee actuator running hot",
      }),
    ).toEqual({ id: "knee_actuator_L", mode: "pulse", tone: "warn" });

    expect(
      componentHighlight({
        ...quiet,
        status: "red",
        alertMessage: "N-07: left knee actuator overheating",
      }),
    ).toEqual({ id: "knee_actuator_L", mode: "pulse", tone: "alert" });
  });

  it("ignores a stale alert once the unit is nominal again", () => {
    expect(
      componentHighlight({
        ...quiet,
        status: "nominal",
        alertMessage: "N-07: left knee actuator running hot",
      }),
    ).toBeNull();
  });

  it("invents no suspect when a troubled unit's alert names no part", () => {
    expect(
      componentHighlight({ ...quiet, status: "red", alertMessage: "N-07: link lost" }),
    ).toBeNull();
  });

  it("follows the scan's flag mid-diagnosis, even with no alert on file", () => {
    expect(
      componentHighlight({ ...quiet, status: "red", flaggedJoint: "knee_L" }),
    ).toEqual({ id: "knee_actuator_L", mode: "pulse", tone: "alert" });
  });

  it("holds a steady amber mark once a verdict exists, whatever the unit says", () => {
    // The question has moved from "what is wrong" to "when is someone going
    // out to it" — which is amber, and is what the incident banner says too.
    for (const status of ["nominal", "amber", "red"] as const) {
      expect(
        componentHighlight({
          ...quiet,
          status,
          alertMessage: "N-07: left knee actuator overheating",
          flaggedJoint: "knee_L",
          verdictJoint: "knee_L",
        }),
      ).toEqual({ id: "knee_actuator_L", mode: "steady", tone: "warn" });
    }
  });
});

describe("componentStatus", () => {
  const flagged = { id: "knee_actuator_L", mode: "pulse", tone: "alert" } as const;

  it("gives the implicated part the incident's tone and everything else nominal", () => {
    expect(componentStatus("knee_actuator_L", flagged)).toBe("alert");
    for (const id of COMPONENT_ORDER.filter((c) => c !== "knee_actuator_L")) {
      expect(componentStatus(id, flagged)).toBe("nominal");
    }
  });

  it("is nominal everywhere when nothing is flagged", () => {
    for (const id of COMPONENT_ORDER) expect(componentStatus(id, null)).toBe("nominal");
  });
});

describe("emissiveIntensity", () => {
  it("holds a settled diagnosis at a fixed, unmoving warmth", () => {
    for (const t of [0, 700, PULSE_PERIOD_MS, 9_999]) {
      expect(emissiveIntensity("steady", t)).toBe(STEADY_EMISSIVE);
    }
  });

  it("breathes a live incident between a floor and a ceiling, and repeats", () => {
    const samples = Array.from({ length: 40 }, (_, i) =>
      emissiveIntensity("pulse", (i * PULSE_PERIOD_MS) / 40),
    );
    expect(Math.min(...samples)).toBeGreaterThan(0);
    expect(Math.max(...samples)).toBeLessThan(0.4);
    // One period later, the same value: no drift, no accumulating phase.
    expect(emissiveIntensity("pulse", 400)).toBeCloseTo(
      emissiveIntensity("pulse", 400 + PULSE_PERIOD_MS),
      10,
    );
  });

  it("starts the pulse at its dimmest and peaks halfway through", () => {
    const floor = emissiveIntensity("pulse", 0);
    const ceiling = emissiveIntensity("pulse", PULSE_PERIOD_MS / 2);
    expect(floor).toBeLessThan(ceiling);
    expect(emissiveIntensity("pulse", PULSE_PERIOD_MS / 4)).toBeGreaterThan(floor);
    expect(emissiveIntensity("pulse", PULSE_PERIOD_MS / 4)).toBeLessThan(ceiling);
  });

  it("under reduced motion holds the pulse still, rather than switching it off", () => {
    const held = emissiveIntensity("pulse", 0, true);
    expect(held).toBe(emissiveIntensity("pulse", 1234, true));
    expect(held).toBeGreaterThan(emissiveIntensity("pulse", 0));
    expect(held).toBeLessThan(emissiveIntensity("pulse", PULSE_PERIOD_MS / 2));
  });
});

describe("highlightNeedsFrames", () => {
  const pulse = { id: "knee_actuator_L", mode: "pulse", tone: "alert" } as const;
  const steady = { id: "knee_actuator_L", mode: "steady", tone: "warn" } as const;

  it("owes frames only to a live pulse a viewer can actually see move", () => {
    expect(highlightNeedsFrames(pulse, false)).toBe(true);
    expect(highlightNeedsFrames(pulse, true)).toBe(false);
    expect(highlightNeedsFrames(steady, false)).toBe(false);
    expect(highlightNeedsFrames(null, false)).toBe(false);
  });
});

describe("cycleSelection", () => {
  it("steps onto the ends from nothing: forward to the head, back to the last", () => {
    expect(cycleSelection(null, 1)).toBe(COMPONENT_ORDER[0]);
    expect(cycleSelection(null, -1)).toBe(COMPONENT_ORDER[COMPONENT_ORDER.length - 1]);
  });

  it("walks the whole ring and returns to where it started", () => {
    let at: ComponentId = COMPONENT_ORDER[0];
    const seen: ComponentId[] = [at];
    for (let i = 1; i < COMPONENT_ORDER.length; i++) {
      at = cycleSelection(at, 1);
      seen.push(at);
    }
    expect(seen).toEqual([...COMPONENT_ORDER]);
    expect(cycleSelection(at, 1)).toBe(COMPONENT_ORDER[0]);
  });

  it("wraps backwards too", () => {
    expect(cycleSelection(COMPONENT_ORDER[0], -1)).toBe(
      COMPONENT_ORDER[COMPONENT_ORDER.length - 1],
    );
  });
});

describe("selectionKey", () => {
  it("moves on either axis — the parts are a ring, not a row", () => {
    expect(selectionKey("ArrowRight", null)).toBe(COMPONENT_ORDER[0]);
    expect(selectionKey("ArrowDown", null)).toBe(COMPONENT_ORDER[0]);
    expect(selectionKey("ArrowLeft", null)).toBe(
      COMPONENT_ORDER[COMPONENT_ORDER.length - 1],
    );
    expect(selectionKey("ArrowUp", null)).toBe(
      COMPONENT_ORDER[COMPONENT_ORDER.length - 1],
    );
  });

  it("clears on Escape, and only when there is something to clear", () => {
    expect(selectionKey("Escape", "torso")).toBeNull();
    // undefined, not null: nothing to do, so the key is not swallowed.
    expect(selectionKey("Escape", null)).toBeUndefined();
  });

  it("ignores every other key so typing elsewhere is never intercepted", () => {
    for (const key of ["Tab", "Enter", " ", "a", "Home", "PageDown"]) {
      expect(selectionKey(key, "torso")).toBeUndefined();
    }
  });
});

/**
 * The service table, which is the one part of this module that is invented.
 *
 * It stands in for a maintenance system this product does not have, so the
 * tests below are about the two properties that keep an invented fact honest:
 * every surface that renders it has a disclaimer to render with it, and the
 * ages are relative so a demo run next year does not show a robot that has not
 * been serviced since the last one.
 */
describe("service records", () => {
  it("has one for every part, with a note and a real interval", () => {
    for (const id of COMPONENT_IDS) {
      const record = serviceRecord(id);
      expect(record).toBe(SERVICE_RECORDS[id]);
      expect(record.note.length).toBeGreaterThan(10);
      expect(record.intervalDays).toBeGreaterThan(0);
      expect(record.servicedDaysAgo).toBeGreaterThanOrEqual(0);
    }
  });

  it("carries the label the UI is required to print beside it", () => {
    expect(SERVICE_DISCLAIMER).toMatch(/simulated/i);
  });

  it("puts exactly one part past its interval, and it is the one the story is about", () => {
    const overdue = COMPONENT_IDS.filter((id) => serviceDueInDays(serviceRecord(id)) < 0);
    // A knee running hot is a fault; a knee running hot thirty-three days past
    // its service is an explanation. Every other part being in date is what
    // makes that one line mean something.
    expect(overdue).toEqual<ComponentId[]>(["knee_actuator_L"]);
    expect(serviceDueInDays(serviceRecord("knee_actuator_L"))).toBe(-33);
  });

  it("reads the due figure straight off the interval", () => {
    expect(serviceDueInDays({ servicedDaysAgo: 30, note: "", intervalDays: 180 })).toBe(
      150,
    );
    expect(serviceDueInDays({ servicedDaysAgo: 180, note: "", intervalDays: 180 })).toBe(
      0,
    );
  });

  it("dates a record against the app's clock, not against a hardcoded year", () => {
    const at = Date.UTC(2026, 7, 24, 12); // 24 Aug 2026, midday, so no TZ flip
    expect(serviceDateLabel({ servicedDaysAgo: 0, note: "", intervalDays: 1 }, at)).toBe(
      "24 Aug 2026",
    );
    expect(serviceDateLabel({ servicedDaysAgo: 30, note: "", intervalDays: 1 }, at)).toBe(
      "25 Jul 2026",
    );
    // Across a year boundary, and out of a leap February.
    expect(
      serviceDateLabel({ servicedDaysAgo: 240, note: "", intervalDays: 1 }, at),
    ).toBe("27 Dec 2025");
  });

  it("says nothing before the client clock has started", () => {
    // `now === 0` is relative-time.ts's server snapshot. A date rendered from
    // it would be 1 Jan 1970 on the server and today in the browser, which is
    // a hydration mismatch dressed up as a service record.
    expect(serviceDateLabel(serviceRecord("torso"), 0)).toBeNull();
  });
});
