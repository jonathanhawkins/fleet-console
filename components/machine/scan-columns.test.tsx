import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { frameSubscriberCount } from "@/components/console";
import { EDGE_VAR, MACHINE_LAYOUT_KEY } from "./machine-layout";
import { ScanColumns } from "./scan-columns";

/**
 * The divider reset, and the one branch of it CSS cannot reach.
 *
 * The double-click reset walks the column home on a JS spring writing a custom
 * property — no transition, no animation, so the global `prefers-reduced-motion`
 * clamp in globals.css has nothing to collapse. A reduced-motion operator was
 * getting the full 166 ms of travel that every other transition in the product
 * had already dropped for them, which is the specific way a hand-rolled
 * animation goes wrong: it opts *out* of the accessibility default by existing.
 */

/** The width the stylesheet would give the walk column: 24 rem at 16 px. */
const DESIGNED = 384;
const OVERRIDE = 524;

let queue = new Map<number, FrameRequestCallback>();
let matches = false;

beforeEach(() => {
  queue = new Map();
  matches = false;
  let handle = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    handle += 1;
    queue.set(handle, cb);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (h: number) => queue.delete(h));
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches,
      media: "",
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
      onchange: null,
    })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(frameSubscriberCount()).toBe(0);
});

/**
 * jsdom lays nothing out, and the controller reads the width it is *actually*
 * rendering at — so the panel reports whatever the custom property says, which
 * is what the cascade would have done.
 */
function stubLayout(grid: HTMLElement) {
  const rect = (width: number) =>
    ({
      width,
      height: 600,
      top: 0,
      left: 0,
      right: width,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const area = this.getAttribute?.("data-area");
    if (area === "log") {
      const override = parseFloat(grid.style.getPropertyValue(EDGE_VAR.log));
      return rect(Number.isFinite(override) ? override : DESIGNED);
    }
    return rect(1440);
  });
}

function mount() {
  const view = render(
    <ScanColumns>
      <div data-area="log">walk</div>
      <div data-area="board">manifest</div>
      <div data-area="waves">sweep</div>
    </ScanColumns>,
  );
  const grid = view.container.querySelector<HTMLElement>(".scan-grid")!;
  stubLayout(grid);
  const handle = view.container.querySelector<HTMLElement>('[data-edge="log"]')!;
  return {
    grid,
    /** Pretend a drag has already widened the column, then double-click it. */
    resetFrom: (px: number) => {
      grid.style.setProperty(EDGE_VAR.log, `${px}px`);
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    },
    override: () => grid.style.getPropertyValue(EDGE_VAR.log),
    aria: () => handle.getAttribute("aria-valuenow"),
    unmount: view.unmount,
  };
}

describe("the double-click reset", () => {
  it("travels home on a spring when motion is welcome", () => {
    const board = mount();
    board.resetFrom(OVERRIDE);

    // Mid-flight: the column is on the shared loop, and the property is still
    // ours — written back to where the travel starts rather than removed.
    expect(frameSubscriberCount()).toBe(1);
    expect(queue.size).toBe(1);
    expect(parseFloat(board.override())).toBe(OVERRIDE);
    board.unmount();
  });

  it("hands the column straight back under prefers-reduced-motion", () => {
    matches = true;
    const board = mount();
    board.resetFrom(OVERRIDE);

    // No spring, no frames — and the same end state the travel would have
    // reached: the property removed, so the stylesheet owns the column again.
    expect(frameSubscriberCount()).toBe(0);
    expect(queue.size).toBe(0);
    expect(board.override()).toBe("");
    // The two things the end of the travel is responsible for still happen.
    expect(board.aria()).toBe(String(DESIGNED));
    expect(JSON.parse(localStorage.getItem(MACHINE_LAYOUT_KEY)!)).toMatchObject({
      log: null,
    });
    board.unmount();
  });
});
