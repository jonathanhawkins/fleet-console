import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UnitStatus, type VerdictReport } from "@/lib/schema";
import { useFleetStore, useIncidentStore } from "@/lib/stores";
import { ComponentView, useComponentHighlight, useViewportGate } from "./component-view";
import { setDescentOccluded } from "./descent-occlusion";
import {
  currentPartSelection,
  resetPartSelection,
  setSelectedPart,
} from "./part-selection";

/**
 * Three things are worth testing about this section, and rendering a WebGL
 * canvas in jsdom is not one of them.
 *
 * That the three.js chunk cannot leak into the unit page's initial JS. That is
 * a PRD §7 promise, it is invisible until it is broken, and the way it breaks
 * is somebody adding a convenient static import — so it is guarded at the
 * source, where the mistake would be made.
 *
 * That the viewer does not exist until it is nearly on screen, and does not
 * disappear again once it does.
 *
 * And that with no WebGL at all — which is exactly what jsdom is — the section
 * is still a complete, selectable, correctly-marked picture of the robot.
 * These tests run against the fallback because the fallback is not a
 * consolation prize; it is the section, minus a dimension.
 */

const CONSOLE_DIR = join(process.cwd(), "components", "console");
const read = (file: string) => readFileSync(join(CONSOLE_DIR, file), "utf8");
const staticImports = (src: string): string[] =>
  [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");

const REPORT: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LEFT KNEE ACTUATOR A-07 GAIN ANOMALY",
  recommendations: ["Schedule service"],
  ts: Date.now(),
};

function seed(status: UnitStatus) {
  act(() => {
    useFleetStore.getState().applySnapshot({
      t: "fleet_snapshot",
      units: [
        {
          id: "N-07",
          name: "Sagebrush House",
          status,
          battery: 84,
          pos: { lat: 44.06, lng: -121.28 },
        },
      ],
    });
  });
}

function raise(message: string) {
  act(() => {
    useFleetStore.getState().applyAlert({
      t: "alert",
      alert: { id: "al-1", unitId: "N-07", severity: "red", message, ts: Date.now() },
    });
  });
}

/** Drive one unit all the way through a scan to an archived incident record. */
function diagnose() {
  act(() => {
    const store = useIncidentStore.getState();
    store.beginDescent("N-07");
    store.applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    store.applyDiagEvent({
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" },
    });
    store.applyDiagEvent({
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "verdict", report: REPORT },
    });
  });
}

beforeEach(() => {
  useFleetStore.getState().reset();
  useIncidentStore.getState().reset();
  resetPartSelection();
});

afterEach(() => {
  resetPartSelection();
});

describe("the code-splitting boundary (PRD §7)", () => {
  it("keeps three.js out of everything the unit page's barrel can reach", () => {
    // The barrel travels with the unit page. Anything it names travels with it.
    const barrel = read("index.ts");
    expect(barrel).not.toMatch(/component-scene/);

    for (const file of [
      "component-view.tsx",
      "component-spec.ts",
      "component-elevation.tsx",
    ]) {
      const imports = staticImports(read(file));
      expect(
        imports.filter((s) => s === "three" || s.startsWith("@react-three/")),
      ).toEqual([]);
      expect(imports).not.toContain("./component-scene");
    }
  });

  it("reaches the scene only through a next/dynamic, client-only boundary", () => {
    const src = read("component-view.tsx");
    expect(src).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("\.\/component-scene"\)/);
    expect(src).toMatch(/ssr:\s*false/);
  });
});

describe("useViewportGate", () => {
  type Fired = (entries: { isIntersecting: boolean }[]) => void;
  let observers: { fire: Fired; margin: string | undefined }[] = [];
  let disconnected = 0;

  /** The wide-margin observer decides mounting; the tight one decides motion. */
  const approaching = () => observers[0]!;
  const onScreen = () => observers[1]!;

  beforeEach(() => {
    observers = [];
    disconnected = 0;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: Fired, options?: IntersectionObserverInit) {
          observers.push({ fire: cb, margin: options?.rootMargin });
        }
        observe() {}
        disconnect() {
          disconnected += 1;
        }
      },
    );
  });

  afterEach(() => {
    setDescentOccluded(false);
    vi.unstubAllGlobals();
  });

  function gate() {
    return renderHook(() => {
      const ref = React.useRef<HTMLElement | null>(null);
      // The hook only observes an attached element; a detached div is enough.
      if (!ref.current) ref.current = document.createElement("div");
      return useViewportGate(ref);
    });
  }

  it("withholds the viewer until the section is near the viewport", () => {
    const { result } = gate();
    expect(result.current).toEqual({ mounted: false, visible: false });
  });

  it("watches with two margins: a generous one to mount, none to animate", () => {
    gate();
    expect(observers).toHaveLength(2);
    expect(approaching().margin).toMatch(/px/);
    // No margin on the motion observer, or the turntable keeps turning for
    // everything within a screenful of the viewport — which is most of the
    // time it is scrolled away.
    expect(onScreen().margin).toBeUndefined();
  });

  it("mounts on approach and stays mounted once scrolled past", () => {
    const { result } = gate();
    act(() => approaching().fire([{ isIntersecting: true }]));
    act(() => onScreen().fire([{ isIntersecting: true }]));
    expect(result.current).toEqual({ mounted: true, visible: true });

    // Off screen but still nearby: the context survives, the motion stops.
    act(() => onScreen().fire([{ isIntersecting: false }]));
    expect(result.current).toEqual({ mounted: true, visible: false });

    act(() => approaching().fire([{ isIntersecting: false }]));
    expect(result.current.mounted).toBe(true);
  });

  it("tears both observers down on unmount", () => {
    const { unmount } = gate();
    unmount();
    expect(disconnected).toBe(2);
  });

  it("treats the descent's opaque surface as off-screen — occlusion is not intersection", () => {
    const { result } = gate();
    act(() => approaching().fire([{ isIntersecting: true }]));
    act(() => onScreen().fire([{ isIntersecting: true }]));
    expect(result.current).toEqual({ mounted: true, visible: true });

    // The wipe lands. The observer still reports intersection — the section
    // has not moved — but nobody can see it, so the turntable must stop
    // through the same `visible` path a scroll past the section uses.
    act(() => setDescentOccluded(true));
    expect(result.current).toEqual({ mounted: true, visible: false });

    // Ascend: the page is showing again; motion may resume at once.
    act(() => setDescentOccluded(false));
    expect(result.current).toEqual({ mounted: true, visible: true });

    // And while occluded, a genuine scroll-away still wins on its own terms.
    act(() => setDescentOccluded(true));
    act(() => onScreen().fire([{ isIntersecting: false }]));
    act(() => setDescentOccluded(false));
    expect(result.current).toEqual({ mounted: true, visible: false });
  });
});

describe("useComponentHighlight", () => {
  const highlight = () => renderHook(() => useComponentHighlight("N-07")).result;

  it("lights nothing on a healthy unit", () => {
    seed("nominal");
    expect(highlight().current).toBeNull();
  });

  it("pulses the part N-07's own alert names, at the unit's severity", () => {
    seed("red");
    raise("Sagebrush House: left knee actuator overheating, torque ripple detected");
    expect(highlight().current).toEqual({
      id: "knee_actuator_L",
      mode: "pulse",
      tone: "alert",
    });
  });

  it("ignores another unit's alert entirely", () => {
    seed("red");
    act(() => {
      useFleetStore.getState().applyAlert({
        t: "alert",
        alert: {
          id: "al-9",
          unitId: "N-02",
          severity: "red",
          message: "Cedar Row: left knee actuator overheating",
          ts: Date.now(),
        },
      });
    });
    expect(highlight().current).toBeNull();
  });

  it("holds a steady mark after the verdict, and keeps holding it", () => {
    seed("red");
    raise("Sagebrush House: left knee actuator overheating");
    diagnose();
    act(() => useIncidentStore.getState().completeAscent());
    expect(highlight().current).toEqual({
      id: "knee_actuator_L",
      mode: "steady",
      tone: "warn",
    });
  });

  it("goes quiet again when the sim resets", () => {
    seed("red");
    raise("Sagebrush House: left knee actuator overheating");
    diagnose();
    act(() => useIncidentStore.getState().completeAscent());
    act(() => {
      useIncidentStore.getState().reset();
      useFleetStore.getState().reset();
    });
    expect(highlight().current).toBeNull();
  });
});

describe("ComponentView without WebGL", () => {
  it("draws the chassis rather than a broken canvas, and names all eight parts", () => {
    seed("nominal");
    render(<ComponentView unitId="N-07" />);

    expect(screen.getByRole("img", { name: /front elevation/i })).toBeInTheDocument();
    expect(document.querySelector("canvas")).toBeNull();

    for (const label of [
      "Head",
      "Torso",
      "Left arm",
      "Right arm",
      "Left leg",
      "Right leg",
      "Left knee actuator",
      "Right knee actuator",
    ]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toBeVisible();
    }
  });

  it("states a status for the flagged part and stays quiet about the rest", () => {
    seed("red");
    raise("Sagebrush House: left knee actuator overheating");
    render(<ComponentView unitId="N-07" />);

    expect(
      screen.getByRole("button", { name: /left knee actuator attention/i }),
    ).toBeVisible();
    // Seven chips reading NOMINAL would out-shout the one that matters.
    expect(screen.queryByText(/nominal/i)).toBeNull();
  });

  it("selects on click and states that part's status, nominal included", async () => {
    const user = userEvent.setup();
    seed("nominal");
    render(<ComponentView unitId="N-07" />);

    await user.click(screen.getByRole("button", { name: /^Torso/ }));
    const torso = screen.getByRole("button", { name: /^Torso/ });
    expect(torso).toHaveAttribute("aria-pressed", "true");
    expect(torso).toHaveTextContent(/nominal/i);

    await user.click(torso);
    expect(screen.getByRole("button", { name: /^Torso/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("cycles the parts with the arrow keys and clears on Escape", async () => {
    const user = userEvent.setup();
    seed("nominal");
    render(<ComponentView unitId="N-07" />);

    const region = screen.getByRole("group", { name: /component view for N-07/i });
    region.focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: /^Head/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: /^Torso/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("button", { name: /^Head/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Backwards from nothing lands on the last part, not next to the first.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /^Head/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: /^Right knee actuator/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

/**
 * The selection stopped being this component's private business.
 *
 * It lives in part-selection.ts now, because a selection that only the viewer
 * knows about is the "portfolio eye candy" charge: it turns
 * the model into an instrument only once the joint grid dims around it and a
 * card states what the part is. What is asserted here is the two halves of that
 * contract from this side — the rail publishes, and the module answers.
 */
describe("ComponentView selection", () => {
  it("publishes what the rail selected, scoped to this unit", async () => {
    const user = userEvent.setup();
    seed("nominal");
    render(<ComponentView unitId="N-07" />);

    await user.click(screen.getByRole("button", { name: /^Left knee actuator/ }));
    expect(currentPartSelection()).toEqual({ unitId: "N-07", part: "knee_actuator_L" });

    await user.click(screen.getByRole("button", { name: /^Left knee actuator/ }));
    expect(currentPartSelection()).toBeNull();
  });

  it("adopts a selection made anywhere else — an alert row, later", () => {
    seed("nominal");
    render(<ComponentView unitId="N-07" />);

    act(() => setSelectedPart("N-07", "leg_R"));
    expect(screen.getByRole("button", { name: /^Right leg/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("ignores a selection made about another unit", () => {
    seed("nominal");
    render(<ComponentView unitId="N-07" />);

    act(() => setSelectedPart("N-03", "leg_R"));
    expect(screen.getByRole("button", { name: /^Right leg/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows the detail card only once a part has been asked about", async () => {
    const user = userEvent.setup();
    seed("nominal");
    const { container } = render(<ComponentView unitId="N-07" />);
    expect(container.querySelector("[data-slot='part-detail']")).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Left knee actuator/ }));
    expect(container.querySelector("[data-slot='part-detail']")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
      "Left knee actuator",
    );
  });

  it("drops the selection when the page goes, rather than leaking it to the next unit", () => {
    seed("nominal");
    const view = render(<ComponentView unitId="N-07" />);
    act(() => setSelectedPart("N-07", "torso"));

    view.unmount();
    expect(currentPartSelection()).toBeNull();
  });
});
