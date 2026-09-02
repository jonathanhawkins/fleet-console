import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TelemetryMessage } from "@/lib/schema";
import { TELEMETRY_RING_CAPACITY, useFleetStore } from "@/lib/stores";
import { JointGrid, TelemetryCursorMeta } from "./joint-grid";
import { JOINT_GRID_ORDER } from "@/components/console";
import { resetPartSelection, setSelectedPart } from "./part-selection";
import { currentCursor, resetCursor } from "./telemetry-hover";

/**
 * The grid owns the pointer, and that is the whole architecture.
 *
 * Eighteen strips, one cursor. The pointer is read once, converted to a sample
 * offset, and every strip resolves it through the scale it already draws with —
 * so the vertical rules line up across the panel and the eighteen numerals are
 * eighteen readings of the *same instant*, which is the question a joint grid
 * exists to answer and could not answer before.
 *
 * The second contract is the expensive one to lose: none of it renders. A
 * pointer moves at 60–120 Hz and this subtree is 18 canvases and 36 readouts;
 * a `useState` holding the cursor would cost more re-renders per second than
 * the entire 10 Hz telemetry feed. The MutationObserver below is the tripwire —
 * it records every DOM change the grid makes during a hundred pointer moves and
 * insists they are all text inside a cursor readout.
 */

const CELL_W = 300;
const CELL_H = 56;
const CELL_LEFT = 40;

let frames: FrameRequestCallback[] = [];
let rectCalls = 0;

function frame(now = 0): void {
  const due = frames;
  frames = [];
  for (const cb of due) cb(now);
}

/** One batch for the whole leg pair, values keyed to the sample index. */
function push(count: number): void {
  act(() => {
    for (let i = 0; i < count; i += 1) {
      const message: TelemetryMessage = {
        t: "telemetry",
        unitId: "N-07",
        ts: 1_700_000_000_000 + i * 100,
        batch: JOINT_GRID_ORDER.map((joint, j) => ({
          joint,
          battery: 80,
          // Distinct per joint AND per sample, so a readout that printed the
          // wrong strip's value or the wrong instant would be visible.
          tempC: 30 + j + i * 0.01,
          torqueNm: 5 + j,
          currentA: 1 + j / 10,
        })),
      };
      useFleetStore.getState().applyTelemetry(message);
    }
  });
}

function readouts(): string[] {
  return [...document.querySelectorAll("[data-slot='strip-cursor-readout']")].map(
    (el) => el.firstElementChild?.textContent ?? "",
  );
}

beforeEach(() => {
  useFleetStore.getState().reset();
  resetCursor();
  resetPartSelection();
  frames = [];
  rectCalls = 0;

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        this.cb(
          [
            {
              contentRect: {
                width: CELL_W,
                height: el.tagName === "CANVAS" ? CELL_H : 0,
              },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

  // jsdom has no layout engine, so the grid's one geometry read is stubbed —
  // and counted, because "read the rect once per column, not once per move" is
  // a claim this file has to be able to check.
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
    () => {
      rectCalls += 1;
      return { left: CELL_LEFT, width: CELL_W, top: 0, height: CELL_H } as DOMRect;
    },
  );
  // The pixels are telemetry-strip.test.tsx's subject; here the canvas only has
  // to accept the calls so the draw runs to the end, where the readouts are
  // written — those are what this file is about.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        setTransform: () => {},
        clearRect: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        fill: () => {},
        fillRect: () => {},
        fillText: () => {},
        measureText: () => ({ width: 20 }),
        stroke: () => {},
      }) as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  resetCursor();
  resetPartSelection();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Pointer x for a sample offset, given the stubbed cell geometry. */
function xFor(offset: number): number {
  const span = TELEMETRY_RING_CAPACITY - 1;
  return CELL_LEFT + ((offset + span) / span) * CELL_W;
}

function hover(offset: number): void {
  const canvas = document.querySelector("canvas")!;
  fireEvent.pointerMove(canvas, { clientX: xFor(offset), pointerType: "mouse" });
}

describe("JointGrid hover", () => {
  it("reads one instant across all eighteen instruments", () => {
    render(<JointGrid unitId="N-07" />);
    push(200);
    frame();
    expect(readouts()).toHaveLength(18);
    expect(new Set(readouts())).toEqual(new Set(["—"]));

    hover(-40);
    frame();

    expect(currentCursor()).toEqual({ unitId: "N-07", offset: -40, scrubbing: false });
    // Sample 159 of 200 (0-indexed), which is 30 + j + 1.59 per joint. The
    // point is not the arithmetic — it is that six joints report six different
    // numbers and every one of them is that joint's reading at *that* sample.
    const temps = readouts().filter((_, i) => i % 3 === 0);
    expect(temps).toEqual(["31.6", "32.6", "33.6", "34.6", "35.6", "36.6"]);
  });

  it("marks the grid as scrubbing so the live numerals stand down", () => {
    const { container } = render(<JointGrid unitId="N-07" />);
    const grid = container.querySelector("[data-slot='joint-grid']")!;
    push(200);
    frame();
    expect(grid.hasAttribute("data-scrubbing")).toBe(false);

    hover(-10);
    expect(grid.hasAttribute("data-scrubbing")).toBe(true);

    fireEvent.pointerLeave(grid);
    expect(grid.hasAttribute("data-scrubbing")).toBe(false);
    expect(currentCursor()).toBeNull();
  });

  /**
   * The claim being checked: the grid reads a rectangle when the pointer enters
   * a new column, and never again. Reading it per move would be a forced
   * synchronous layout at pointer rate — the frame before it just wrote text
   * into eighteen readouts, so the layout is dirty every single time.
   */
  it("measures a column once, not once per pointer move", () => {
    render(<JointGrid unitId="N-07" />);
    push(200);
    frame();
    rectCalls = 0;

    for (let i = 0; i < 50; i += 1) hover(-i);
    expect(rectCalls).toBe(1);

    // A different column is a different left edge, so that one is measured.
    const second = document.querySelectorAll("[data-joint-cell] canvas")[3]!;
    fireEvent.pointerMove(second, { clientX: xFor(-5), pointerType: "mouse" });
    expect(rectCalls).toBe(2);
  });

  /**
   * The tripwire. Every DOM change made during a hundred pointer moves has to
   * be a cursor readout writing its own text — no class swaps, no children
   * replaced, nothing that would betray React reconciling this subtree.
   */
  it("changes nothing in the DOM but the readouts, across a hundred moves", () => {
    const { container } = render(<JointGrid unitId="N-07" />);
    const grid = container.querySelector("[data-slot='joint-grid']") as HTMLElement;
    push(200);
    frame();

    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));
    observer.observe(grid, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    for (let i = 0; i < 100; i += 1) {
      hover(-i);
      frame();
    }
    // MutationObserver delivers on the microtask queue.
    return Promise.resolve().then(() => {
      observer.disconnect();
      expect(seen.length).toBeGreaterThan(0); // it did move
      for (const record of seen) {
        const node =
          record.target.nodeType === Node.TEXT_NODE
            ? record.target.parentElement
            : (record.target as Element);
        const inReadout = node?.closest("[data-slot='strip-cursor-readout']") !== null;
        const isGridFlag = node === grid && record.attributeName === "data-scrubbing";
        expect(inReadout || isGridFlag).toBe(true);
      }
    });
  });

  it("does not answer a touch that has not been pressed", () => {
    render(<JointGrid unitId="N-07" />);
    push(200);
    const canvas = document.querySelector("canvas")!;

    // A finger sliding over the panel mid-scroll is not a scrub.
    fireEvent.pointerMove(canvas, {
      clientX: xFor(-30),
      pointerType: "touch",
      pointerId: 7,
    });
    expect(currentCursor()).toBeNull();

    fireEvent.pointerDown(canvas, {
      clientX: xFor(-30),
      pointerType: "touch",
      pointerId: 7,
    });
    expect(currentCursor()).toEqual({ unitId: "N-07", offset: -30, scrubbing: true });

    fireEvent.pointerMove(canvas, {
      clientX: xFor(-31),
      pointerType: "touch",
      pointerId: 7,
    });
    expect(currentCursor()?.offset).toBe(-31);

    fireEvent.pointerUp(canvas, { pointerType: "touch", pointerId: 7 });
    expect(currentCursor()).toBeNull();
  });
});

describe("JointGrid expansion", () => {
  const control = (joint: string, metric: string) =>
    document.querySelector(
      `[data-joint='${joint}'][data-metric='${metric}'] [data-slot='strip-expand']`,
    ) as HTMLButtonElement;

  const canvasFor = (joint: string, metric: string) =>
    document.querySelector(
      `[data-joint='${joint}'][data-metric='${metric}'] canvas`,
    ) as HTMLCanvasElement;

  it("grows one strip at a time and lets the label row say so", () => {
    render(<JointGrid unitId="N-07" />);
    expect(control("knee_L", "tempC")).toHaveAttribute("aria-expanded", "false");
    expect(canvasFor("knee_L", "tempC").style.height).toBe("56px");

    fireEvent.click(control("knee_L", "tempC"));
    expect(control("knee_L", "tempC")).toHaveAttribute("aria-expanded", "true");
    expect(canvasFor("knee_L", "tempC").style.height).toBe("168px");
    expect(canvasFor("knee_L", "torqueNm").style.height).toBe("56px");

    // A focus is singular: opening another closes the first.
    fireEvent.click(control("hip_R", "currentA"));
    expect(control("knee_L", "tempC")).toHaveAttribute("aria-expanded", "false");
    expect(control("hip_R", "currentA")).toHaveAttribute("aria-expanded", "true");

    // …and the same control closes it.
    fireEvent.click(control("hip_R", "currentA"));
    expect(control("hip_R", "currentA")).toHaveAttribute("aria-expanded", "false");
  });

  it("collapses on Escape and on a press outside the panel", () => {
    render(<JointGrid unitId="N-07" />);
    fireEvent.click(control("knee_L", "tempC"));
    fireEvent.keyDown(globalThis as unknown as Element, { key: "Escape" });
    expect(control("knee_L", "tempC")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(control("knee_L", "tempC"));
    fireEvent.pointerDown(document.body);
    expect(control("knee_L", "tempC")).toHaveAttribute("aria-expanded", "false");
  });

  it("stays open while the pointer is working inside the panel", () => {
    render(<JointGrid unitId="N-07" />);
    fireEvent.click(control("knee_L", "tempC"));
    fireEvent.pointerDown(canvasFor("ankle_R", "tempC"));
    expect(control("knee_L", "tempC")).toHaveAttribute("aria-expanded", "true");
  });

  it("takes a click on the canvas as an expand — but only where there is a mouse", () => {
    render(<JointGrid unitId="N-07" />);
    fireEvent.click(canvasFor("knee_L", "torqueNm"));
    expect(control("knee_L", "torqueNm")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(canvasFor("knee_L", "torqueNm"));
    expect(control("knee_L", "torqueNm")).toHaveAttribute("aria-expanded", "false");

    // On a touch screen the canvas is inside a vertical scroller, and a tap
    // that lands on it during a flick must not expand anything. There, the
    // label row is the only control.
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
    fireEvent.click(canvasFor("knee_L", "torqueNm"));
    expect(control("knee_L", "torqueNm")).toHaveAttribute("aria-expanded", "false");
  });
});

/**
 * The shared half of the readout.
 *
 * One instant is under the cursor no matter which of the eighteen strips it is
 * over, so it is printed once — in the card's own meta line, which already
 * describes the window. Written from the cursor subscription with
 * `textContent`, so the fastest-moving text in the product costs zero renders.
 */
describe("TelemetryCursorMeta", () => {
  it("describes the window at rest and the cursor's instant while scrubbing", () => {
    render(
      <div>
        <TelemetryCursorMeta unitId="N-07" />
        <JointGrid unitId="N-07" />
      </div>,
    );
    push(200);
    frame();

    const meta = document.querySelector("[data-slot='telemetry-cursor-meta']")!;
    expect(screen.getByText("Last 60 s · 10 Hz")).toBeInTheDocument();
    expect(meta.hasAttribute("data-active")).toBe(false);

    hover(-40);
    expect(meta.hasAttribute("data-active")).toBe(true);
    // ts of sample 159 is 1_700_000_000_000 + 159 * 100
    expect(meta.lastElementChild?.textContent).toMatch(/^−4\.0 s · \d\d:\d\d:\d\d$/);

    hover(0);
    expect(meta.lastElementChild?.textContent).toMatch(/^now · /);

    fireEvent.pointerLeave(document.querySelector("[data-slot='joint-grid']")!);
    expect(meta.hasAttribute("data-active")).toBe(false);
  });

  it("ignores a cursor on another unit's grid", () => {
    render(
      <div>
        <TelemetryCursorMeta unitId="N-03" />
        <JointGrid unitId="N-07" />
      </div>,
    );
    push(200);
    frame();
    hover(-40);
    expect(
      document
        .querySelector("[data-slot='telemetry-cursor-meta']")!
        .hasAttribute("data-active"),
    ).toBe(false);
  });
});

/**
 * The other direction: the viewer selects a part, and this panel answers.
 *
 * Same architecture as the cursor and asserted the same way. A selection is a
 * module variable; the grid subscribes once and writes one `data-emphasis`
 * attribute per cell; CSS turns those into a hairline on one and a step back
 * for the other five. The MutationObserver below is again the tripwire, and it
 * is a stronger claim here than a render count would be: it insists that the
 * *only* thing that changed in the whole subtree was six attributes. A React
 * re-render of eighteen strips would show up as class swaps and replaced
 * children long before it showed up in a frame budget.
 */
describe("JointGrid cross-highlight", () => {
  const emphasis = (): Array<string | null> =>
    [...document.querySelectorAll("[data-joint-cell]")].map((cell) =>
      cell.getAttribute("data-emphasis"),
    );

  /** JOINT_GRID_ORDER: hip_L, knee_L, ankle_L, hip_R, knee_R, ankle_R. */
  const scrolls = vi.fn();

  function mountGrid(): void {
    // jsdom implements neither of these; both are needed before the reveal path
    // can run at all, and the geometry decides whether it runs.
    HTMLElement.prototype.scrollIntoView = scrolls;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 400,
    } as DOMRect);
    scrolls.mockClear();
    render(<JointGrid unitId="N-07" />);
    push(50);
    frame();
  }

  it("brings the selected part's joint forward and steps the others back", () => {
    mountGrid();
    expect(emphasis()).toEqual([null, null, null, null, null, null]);

    act(() => setSelectedPart("N-07", "knee_actuator_L"));

    expect(emphasis()).toEqual(["off", "on", "off", "off", "off", "off"]);
  });

  it("lights both joints a leg carries", () => {
    mountGrid();
    act(() => setSelectedPart("N-07", "leg_R"));
    expect(emphasis()).toEqual(["off", "off", "off", "on", "off", "on"]);
  });

  it("dims nothing for a part with no instruments", () => {
    mountGrid();
    act(() => setSelectedPart("N-07", "knee_actuator_L"));
    expect(emphasis()).toContain("on");

    // The torso, the head and the arms report no joints. The detail card
    // beside the viewer says so; the telemetry panel says nothing at all,
    // because greying out eighteen instruments to announce an absence is the
    // page making a fuss.
    act(() => setSelectedPart("N-07", "torso"));
    expect(emphasis()).toEqual([null, null, null, null, null, null]);
  });

  it("restores the whole panel when the selection is dropped", () => {
    mountGrid();
    act(() => setSelectedPart("N-07", "knee_actuator_L"));
    act(() => setSelectedPart("N-07", null));
    expect(emphasis()).toEqual([null, null, null, null, null, null]);
  });

  it("ignores a selection made on another unit's page", () => {
    mountGrid();
    act(() => setSelectedPart("N-03", "knee_actuator_L"));
    expect(emphasis()).toEqual([null, null, null, null, null, null]);
    expect(scrolls).not.toHaveBeenCalled();
  });

  it("changes nothing in the DOM but six attributes", async () => {
    mountGrid();
    const seen: MutationRecord[] = [];
    const grid = document.querySelector("[data-slot='joint-grid']")!;
    const observer = new MutationObserver((records) => seen.push(...records));
    observer.observe(grid, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });

    act(() => setSelectedPart("N-07", "knee_actuator_L"));
    await Promise.resolve();
    observer.disconnect();

    expect(seen).toHaveLength(6);
    for (const record of seen) {
      expect(record.type).toBe("attributes");
      expect(record.attributeName).toBe("data-emphasis");
      expect((record.target as Element).hasAttribute("data-joint-cell")).toBe(true);
    }
  });

  it("nudges the highlighted cell into view, by the smallest amount there is", () => {
    mountGrid();
    act(() => setSelectedPart("N-07", "knee_actuator_L"));

    expect(scrolls).toHaveBeenCalledTimes(1);
    // `nearest` never centres and never moves a cell that is already visible;
    // the stubbed matchMedia reports full motion, so this one gets the travel.
    expect(scrolls).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
    expect(scrolls.mock.instances[0]).toBe(
      document.querySelectorAll("[data-joint-cell]")[1],
    );
  });

  it("does not scroll for a re-assertion of the selection already shown", () => {
    mountGrid();
    act(() => setSelectedPart("N-07", "knee_actuator_L"));
    expect(scrolls).toHaveBeenCalledTimes(1);

    // A second click on the same rail row, a hover that re-emits: the store
    // no-ops, and even if it did not, the grid holds what the DOM reflects.
    act(() => setSelectedPart("N-07", "knee_actuator_L"));
    expect(scrolls).toHaveBeenCalledTimes(1);
  });

  it("leaves the page alone when the cell is somewhere else entirely", () => {
    // A cross-highlight is a find, not a navigation. The viewer sits a
    // screenful below this panel; a selection made down there must not haul
    // the operator back up.
    mountGrid();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: -900,
      bottom: -600,
    } as DOMRect);

    act(() => setSelectedPart("N-07", "knee_actuator_L"));

    expect(scrolls).not.toHaveBeenCalled();
    expect(emphasis()).toEqual(["off", "on", "off", "off", "off", "off"]); // still marked
  });
});
