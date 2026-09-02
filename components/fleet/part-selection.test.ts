import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPONENT_IDS, type ComponentId } from "./component-spec";
import { JOINTS } from "@/components/console";
import {
  clearSelectedPart,
  currentPartSelection,
  jointEmphasis,
  JOINTS_FOR_PART,
  jointsForPart,
  mirrorJoint,
  resetPartSelection,
  selectPartForAlert,
  selectedPartFor,
  setSelectedPart,
  subscribeSelection,
} from "./part-selection";

/**
 * One selected part, three regions that have to agree about it.
 *
 * The store half of this file is the same contract telemetry-hover.ts holds for
 * the cursor — a module singleton, scoped to a unit, that notifies on change
 * and not otherwise. The mapping half is the part nobody can see and everybody
 * depends on: which strips a part owns, which parts own none at all, and which
 * joint is a given joint's opposite number. Those three answers drive what the
 * grid dims, what the detail card prints and what the expanded strip overlays,
 * so they are asserted here rather than through three components.
 */

afterEach(() => {
  resetPartSelection();
});

describe("part selection store", () => {
  it("is empty until something selects, and reads back scoped to a unit", () => {
    expect(currentPartSelection()).toBeNull();
    expect(selectedPartFor("N-07")).toBeNull();

    setSelectedPart("N-07", "knee_actuator_L");

    expect(selectedPartFor("N-07")).toBe("knee_actuator_L");
    // The whole reason the selection carries a unit id: a module variable
    // outlives a route change, and N-03 must not inherit a click about N-07.
    expect(selectedPartFor("N-03")).toBeNull();
  });

  it("notifies on a real change and stays silent on a restatement", () => {
    const seen = vi.fn();
    subscribeSelection(seen);

    setSelectedPart("N-07", "torso");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith({ unitId: "N-07", part: "torso" });

    // A rail row re-asserting the selection it already holds is not an event.
    setSelectedPart("N-07", "torso");
    expect(seen).toHaveBeenCalledTimes(1);

    setSelectedPart("N-07", "head");
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("treats a null part as a clear, and unsubscribes cleanly", () => {
    const seen = vi.fn();
    const stop = subscribeSelection(seen);

    setSelectedPart("N-07", "leg_R");
    setSelectedPart("N-07", null);
    expect(currentPartSelection()).toBeNull();
    expect(seen).toHaveBeenLastCalledWith(null);

    stop();
    setSelectedPart("N-07", "leg_R");
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("clears only the unit it was asked about", () => {
    setSelectedPart("N-07", "knee_actuator_L");

    clearSelectedPart("N-03");
    expect(selectedPartFor("N-07")).toBe("knee_actuator_L");

    clearSelectedPart("N-07");
    expect(currentPartSelection()).toBeNull();

    // …and unscoped clears whatever is there — the teardown path.
    setSelectedPart("N-07", "head");
    clearSelectedPart();
    expect(currentPartSelection()).toBeNull();
  });

  it("does not notify a clear when there is nothing selected", () => {
    const seen = vi.fn();
    subscribeSelection(seen);
    clearSelectedPart();
    clearSelectedPart("N-07");
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("part → joints", () => {
  it("gives a knee actuator exactly its own knee", () => {
    expect(jointsForPart("knee_actuator_L")).toEqual(["knee_L"]);
    expect(jointsForPart("knee_actuator_R")).toEqual(["knee_R"]);
  });

  it("gives a leg the hip and ankle it carries, down the limb", () => {
    // Order matters: hip before ankle is how the grid stacks them and how
    // anyone describes a leg out loud.
    expect(jointsForPart("leg_L")).toEqual(["hip_L", "ankle_L"]);
    expect(jointsForPart("leg_R")).toEqual(["hip_R", "ankle_R"]);
  });

  it("gives the four uninstrumented parts nothing, without going undefined", () => {
    for (const part of ["head", "torso", "arm_L", "arm_R"] as const) {
      expect(JOINTS_FOR_PART[part]).toEqual([]);
      expect(jointsForPart(part)).toEqual([]);
    }
  });

  it("answers for every component id, and for none at all", () => {
    for (const id of COMPONENT_IDS) expect(Array.isArray(JOINTS_FOR_PART[id])).toBe(true);
    expect(jointsForPart(null)).toEqual([]);
    expect(jointsForPart(undefined)).toEqual([]);
  });

  it("accounts for all six joints exactly once between the eight parts", () => {
    const claimed = COMPONENT_IDS.flatMap((id) => [...JOINTS_FOR_PART[id]]);
    expect([...claimed].sort()).toEqual([...JOINTS].sort());
  });
});

describe("emphasis", () => {
  it("lights the selected part's joints and dims the rest", () => {
    expect(jointEmphasis("knee_actuator_L", "knee_L")).toBe("on");
    expect(jointEmphasis("knee_actuator_L", "knee_R")).toBe("off");
    expect(jointEmphasis("knee_actuator_L", "hip_L")).toBe("off");
  });

  it("lights both of a leg's joints", () => {
    expect(jointEmphasis("leg_L", "hip_L")).toBe("on");
    expect(jointEmphasis("leg_L", "ankle_L")).toBe("on");
    expect(jointEmphasis("leg_L", "knee_L")).toBe("off");
  });

  it("has no opinion when nothing is selected", () => {
    for (const joint of JOINTS) expect(jointEmphasis(null, joint)).toBeNull();
  });

  it("has no opinion about a part with no instruments — it dims nothing", () => {
    // The rule the grid depends on. Selecting the torso must not grey out
    // eighteen instruments to announce that a torso has no strips.
    for (const part of ["head", "torso", "arm_L", "arm_R"] as const) {
      for (const joint of JOINTS) expect(jointEmphasis(part, joint)).toBeNull();
    }
  });
});

describe("mirrorJoint", () => {
  it("flips a side and finds the real joint on the other one", () => {
    expect(mirrorJoint("knee_L")).toBe("knee_R");
    expect(mirrorJoint("knee_R")).toBe("knee_L");
    expect(mirrorJoint("hip_L")).toBe("hip_R");
    expect(mirrorJoint("ankle_R")).toBe("ankle_L");
  });

  it("is its own inverse across the whole roster", () => {
    for (const joint of JOINTS) {
      const other = mirrorJoint(joint);
      expect(other).not.toBeNull();
      expect(mirrorJoint(other as string)).toBe(joint);
    }
  });

  it("returns null rather than a name nobody can look up", () => {
    expect(mirrorJoint("torso")).toBeNull();
    expect(mirrorJoint("wrist_L")).toBeNull(); // side, but not a joint this fleet has
    expect(mirrorJoint("")).toBeNull();
  });
});

describe("selectPartForAlert", () => {
  it("points the model at the part the alert's own sentence names", () => {
    const part = selectPartForAlert({
      unitId: "N-07",
      message: "N-07: left knee actuator running hot",
    });

    expect(part).toBe<ComponentId>("knee_actuator_L");
    expect(selectedPartFor("N-07")).toBe("knee_actuator_L");
  });

  it("selects on the alert's own unit, not on whichever page is open", () => {
    setSelectedPart("N-07", "torso");
    selectPartForAlert({ unitId: "N-03", message: "N-03: right leg drawing current" });

    expect(selectedPartFor("N-03")).toBe("leg_R");
    expect(selectedPartFor("N-07")).toBeNull(); // one selection, and it moved
  });

  it("changes nothing when the alert names nothing pointable", () => {
    const seen = vi.fn();
    subscribeSelection(seen);

    expect(
      selectPartForAlert({ unitId: "N-07", message: "N-07: battery low" }),
    ).toBeNull();
    expect(currentPartSelection()).toBeNull();
    expect(seen).not.toHaveBeenCalled();
  });
});
