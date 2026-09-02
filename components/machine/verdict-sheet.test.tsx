import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { spring } from "framer-motion";
import { frameSubscriberCount } from "@/components/console";
import {
  SPRING_MINIMIZE_S,
  SPRING_RESTORE_S,
  springTransition,
  type SheetSpring,
} from "./sheet-gesture";
import { VerdictSheet } from "./verdict-sheet";

/**
 * The sheet's two interruptible seams, driven frame by frame.
 *
 * `sheet-gesture.test.ts` next door asserts what the release *decides*; this
 * file asserts what the surface actually does with an exit already in the air —
 * a thumb landing on it, a chip tapped behind it — and what is left of all that
 * when the operator has asked for reduced motion. Both are windows of 150–250 ms
 * that no screenshot can catch and no e2e assertion reaches, which is exactly
 * the shape of behaviour that rots silently.
 *
 * The clock is stubbed rather than waited on: `performance.now`, the shared
 * frame loop's `requestAnimationFrame`, and the spring's own sampling all read
 * from the same fake millisecond counter, so a "frame" here is the same event it
 * is in the browser and the values below are the exact ones framer-motion's
 * spring generator produces for the sheet's physics (sheet-gesture.ts).
 */

/** What a 390×844 phone renders the sheet at, between header and status rule. */
const H = 744;

let clock = 0;
let queue = new Map<number, FrameRequestCallback>();

/** Advance the clock and run whatever was scheduled for this frame. */
function frame(ms = 16) {
  clock += ms;
  const due = [...queue.values()];
  queue.clear();
  act(() => {
    for (const cb of due) cb(clock);
  });
}

/**
 * Run `n` frames.
 *
 * A spring's `t = 0` is the *first frame it is sampled on*, not the commit that
 * started it (verdict-sheet.tsx explains why), so `n` frames of `ms` carry the
 * animation `(n - 1) × ms` — the first one only sets the origin and re-writes
 * the value the surface already had.
 */
function frames(n: number, ms = 16) {
  for (let i = 0; i < n; i++) frame(ms);
}

/** How far a spring has travelled after `n` frames. */
const elapsed = (n: number, ms = 16) => ((n - 1) * ms) / 1000;

/** Run pending work without moving time — the drag's own pointermove coalescer. */
const flush = () => frame(0);

type Capture = (id: number) => void;
const savedCapture: Partial<Record<string, unknown>> = {};

beforeEach(() => {
  clock = 0;
  queue = new Map();
  let handle = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    handle += 1;
    queue.set(handle, cb);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (h: number) => queue.delete(h));

  // jsdom has no pointer capture; the drag calls it on every engage.
  for (const key of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
    savedCapture[key] = (Element.prototype as unknown as Record<string, unknown>)[key];
  }
  Element.prototype.setPointerCapture = (() => {}) as Capture;
  Element.prototype.releasePointerCapture = (() => {}) as Capture;
  Element.prototype.hasPointerCapture = (() => true) as unknown as (
    id: number,
  ) => boolean;
});

afterEach(() => {
  // Unmount before the assertion below rather than after it (the setup file's
  // cleanup runs later): the point is that nothing outlives the sheet, and a
  // still-mounted component would both hide that and leak a subscriber into the
  // next test's frames.
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(savedCapture)) {
    (Element.prototype as unknown as Record<string, unknown>)[key] = value;
  }
  // Nothing may outlive the sheet on the shared loop.
  expect(frameSubscriberCount()).toBe(0);
});

function pointer(type: string, y: number, at = clock): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientY: y,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "isPrimary", { value: true });
  Object.defineProperty(event, "timeStamp", { value: at });
  return event as unknown as PointerEvent;
}

function mount({ reduced = false } = {}) {
  const onMinimize = vi.fn();
  const onRestore = vi.fn();
  const onCoveredChange = vi.fn();

  const tree = (open: boolean) => (
    <VerdictSheet
      open={open}
      onMinimize={onMinimize}
      onRestore={onRestore}
      onCoveredChange={onCoveredChange}
      reduced={reduced}
    >
      <header data-sheet-grab="true">VERDICT</header>
      <p>KNEE_L · ACTUATOR A-07</p>
    </VerdictSheet>
  );

  const view = render(tree(true));

  const wrap = () => document.querySelector('[data-slot="verdict-sheet"]');
  const slide = () => document.querySelector<HTMLElement>('[data-slot="verdict-slide"]');
  // The box the sheet has to clear to be gone. jsdom lays nothing out.
  Object.defineProperty(wrap()!, "clientHeight", { configurable: true, value: H });

  const offset = () => {
    const transform = slide()?.style.transform ?? "";
    const match = /translate3d\(0(?:px)?, (-?[\d.]+)px, 0(?:px)?\)/.exec(transform);
    return match ? Number(match[1]) : 0;
  };
  const opacity = () => {
    const raw = slide()?.style.opacity ?? "";
    return raw === "" ? 1 : Number(raw);
  };

  const send = (type: string, y: number, at = clock) => {
    act(() => {
      slide()?.dispatchEvent(pointer(type, y, at));
    });
  };
  const grab = (y: number, at = clock) => {
    act(() => {
      document
        .querySelector("[data-sheet-grab]")!
        .dispatchEvent(pointer("pointerdown", y, at));
    });
  };

  return {
    onMinimize,
    onRestore,
    onCoveredChange,
    setOpen: (open: boolean) => view.rerender(tree(open)),
    unmount: view.unmount,
    wrap,
    slide,
    offset,
    opacity,
    grab,
    move: (y: number, at = clock) => send("pointermove", y, at),
    up: (y: number, at = clock) => send("pointerup", y, at),
  };
}

/** The sheet's spring, sampled at `t` seconds: where it is and how fast. */
function sample(spec: SheetSpring, t: number) {
  const gen = spring({
    keyframes: [spec.from, spec.to],
    velocity: spec.velocity,
    ...springTransition(spec.response),
  });
  return { value: gen.next(t * 1000).value, velocity: gen.velocity?.(t * 1000) ?? 0 };
}

/** Where the tapped exit is, and how fast, `n` frames after it was released. */
function exitAfter(n: number) {
  return sample({ from: 0, to: H, velocity: 0, response: SPRING_MINIMIZE_S }, elapsed(n));
}

/** Drive the loop until nothing is animating, or give up. */
function settle() {
  for (let i = 0; i < 80 && frameSubscriberCount() > 0; i++) frame();
}

describe("the exit is catchable", () => {
  it("keeps the drag alive while the sheet is leaving, and re-bases on where it caught it", () => {
    const sheet = mount();
    sheet.setOpen(false);
    expect(frameSubscriberCount()).toBe(1);

    frames(3);
    const caught = sheet.offset();
    expect(caught).toBeCloseTo(exitAfter(3).value, 3);
    expect(caught).toBeGreaterThan(0);
    expect(caught).toBeLessThan(H);

    // A hand on a moving surface stops it dead — no spring running under the
    // finger, and no drift while the pointer sits there.
    sheet.grab(100);
    expect(frameSubscriberCount()).toBe(0);
    frame(48);
    expect(sheet.offset()).toBe(caught);

    // Past the slop the drag re-bases, so the sheet tracks 1:1 from where it
    // was caught rather than jumping to the finger.
    sheet.move(140);
    flush();
    expect(sheet.offset()).toBe(caught);
    sheet.move(170);
    flush();
    expect(sheet.offset()).toBeCloseTo(caught + 30, 6);
  });

  it("hands a caught exit back to the console when it is thrown up to full", () => {
    const sheet = mount();
    sheet.setOpen(false);
    frames(3);
    const caught = sheet.offset();

    sheet.grab(400);
    sheet.move(440); // engage, re-based
    flush();
    sheet.move(340); // 100px back up the screen
    flush();
    expect(sheet.offset()).toBeCloseTo(caught - 100, 6);

    sheet.up(340);
    // The gesture decided "settle", which on a sheet that was already leaving
    // means the operator took the conclusion back — the chip has to hear it.
    expect(sheet.onRestore).toHaveBeenCalledTimes(1);
    expect(sheet.onMinimize).not.toHaveBeenCalled();

    sheet.setOpen(true);
    settle();
    expect(sheet.offset()).toBe(0);
    expect(sheet.wrap()).not.toBeNull();
    expect(sheet.onCoveredChange).toHaveBeenLastCalledWith(true);
  });

  it("lets a caught exit released downward carry on out, without asking twice", () => {
    const sheet = mount();
    sheet.setOpen(false);
    frames(3);

    sheet.grab(100);
    sheet.move(140);
    flush();
    sheet.move(300); // further down, past the commit line
    flush();
    sheet.up(300);

    // onMinimize is not called again: the console is already in that state, so
    // the sheet finishes the exit itself rather than waiting for a state change
    // that will never arrive.
    expect(sheet.onMinimize).not.toHaveBeenCalled();
    expect(sheet.onRestore).not.toHaveBeenCalled();
    expect(frameSubscriberCount()).toBe(1);

    settle();
    expect(sheet.wrap()).toBeNull();
    expect(sheet.onCoveredChange).toHaveBeenLastCalledWith(false);
  });

  it("resumes an exit that was touched and let go without a drag", () => {
    const sheet = mount();
    sheet.setOpen(false);
    frames(3);
    const caught = sheet.offset();

    sheet.grab(100);
    expect(frameSubscriberCount()).toBe(0);
    sheet.move(104); // inside the 10px slop: still a tap
    sheet.up(104);

    // Paused, then let go: it carries on from the pixel it was frozen at.
    expect(frameSubscriberCount()).toBe(1);
    expect(sheet.offset()).toBe(caught);
    frames(2);
    expect(sheet.offset()).toBeGreaterThan(caught);
    settle();
    expect(sheet.wrap()).toBeNull();
  });
});

describe("a flick", () => {
  it("commits, hands its velocity to the exit, and the exit parks", () => {
    const sheet = mount();
    sheet.grab(100);
    sheet.move(140); // engage, re-based
    flush();
    frame(16);
    sheet.move(240);
    flush();
    frame(16);
    sheet.move(340);
    flush();
    sheet.up(340); // 200px in 32ms: a throw
    expect(sheet.onMinimize).toHaveBeenCalledTimes(1);
    expect(sheet.offset()).toBe(200);

    // The console flips `open`; the exit starts from the release pixel, at
    // the release speed, and leaves.
    sheet.setOpen(false);
    expect(frameSubscriberCount()).toBe(1);
    frames(2);
    expect(sheet.offset()).toBeGreaterThan(200);
    settle();
    expect(sheet.wrap()).toBeNull();
    expect(sheet.onCoveredChange).toHaveBeenLastCalledWith(false);
  });
});

describe("the spring's clock", () => {
  it("starts at the first frame it is sampled on, not at the commit", () => {
    const sheet = mount();
    sheet.setOpen(false);

    // A frame that arrives 40 ms after the state changed is still frame zero.
    // Dating the spring from the commit instead puts the sheet 40 ms along its
    // exit on the first painted frame — a jump, at t = 0, on the one transition
    // whose whole job is not to have one.
    frame(40);
    expect(sheet.offset()).toBe(0);

    frame();
    expect(sheet.offset()).toBeCloseTo(exitAfter(2).value, 3);
    settle();
  });
});

describe("RESTORE tapped mid-exit", () => {
  it("re-aims the sheet where it is, carrying the velocity it already had", () => {
    const sheet = mount();
    const node = sheet.slide();
    sheet.setOpen(false);
    frames(3);

    const airborne = exitAfter(3);
    expect(sheet.offset()).toBeCloseTo(airborne.value, 3);

    sheet.setOpen(true);

    // Nothing was parked and nothing re-entered from the bottom edge: same DOM
    // node, same pixel, no unmount in between.
    expect(sheet.slide()).toBe(node);
    expect(sheet.offset()).toBeCloseTo(airborne.value, 3);
    expect(sheet.onCoveredChange).not.toHaveBeenCalledWith(false);

    // The turn-around starts from the live velocity, not from a standstill.
    const reAimed = { from: airborne.value, to: 0, response: SPRING_RESTORE_S };
    frames(2);
    const carried = sample({ ...reAimed, velocity: airborne.velocity }, elapsed(2));
    const fromRest = sample({ ...reAimed, velocity: 0 }, elapsed(2));
    expect(sheet.offset()).toBeCloseTo(carried.value, 3);
    // …and the two are far enough apart that this assertion means something.
    expect(Math.abs(carried.value - fromRest.value)).toBeGreaterThan(4);

    settle();
    expect(sheet.offset()).toBe(0);
    expect(sheet.onCoveredChange).toHaveBeenLastCalledWith(true);
  });
});

describe("reduced motion: the drag stays, the physics goes", () => {
  it("tracks the finger 1:1, rubber band and all", () => {
    const sheet = mount({ reduced: true });

    sheet.grab(100);
    sheet.move(140); // engage, re-based at 140
    flush();
    expect(sheet.offset()).toBe(0);

    sheet.move(240);
    flush();
    expect(sheet.offset()).toBe(100);
    sheet.move(340);
    flush();
    expect(sheet.offset()).toBe(200);

    // Above full it resists rather than freezing — that is a hand meeting a
    // boundary, not an animation.
    sheet.move(40);
    flush();
    expect(sheet.offset()).toBeLessThan(0);
    expect(sheet.offset()).toBeGreaterThan(-48);

    // Not one frame of any of it came from an animation.
    expect(frameSubscriberCount()).toBe(0);
    sheet.up(40);
  });

  it("applies the settled state on the frame the finger lifts, with no flight", () => {
    const sheet = mount({ reduced: true });

    sheet.grab(100);
    sheet.move(140);
    flush();
    sheet.move(300); // 160px down: short of the commit line
    flush();
    expect(sheet.offset()).toBe(160);

    sheet.up(300);
    expect(sheet.offset()).toBe(0);
    expect(sheet.slide()?.style.transform).toBe("");
    expect(frameSubscriberCount()).toBe(0);
    expect(sheet.onMinimize).not.toHaveBeenCalled();
  });

  it("still commits a drag that meant it, on the same decision as full motion", () => {
    const sheet = mount({ reduced: true });

    sheet.grab(100);
    sheet.move(140);
    flush();
    sheet.move(540); // 400px down: past 35% of 744
    flush();
    sheet.up(540);

    expect(sheet.onMinimize).toHaveBeenCalledTimes(1);
    expect(frameSubscriberCount()).toBe(0);
  });

  it("crossfades in and out rather than cutting, and never translates", () => {
    const sheet = mount({ reduced: true });
    expect(sheet.onCoveredChange).toHaveBeenLastCalledWith(true);

    sheet.setOpen(false);
    expect(sheet.wrap()).not.toBeNull();
    expect(frameSubscriberCount()).toBe(1);

    frames(2, 100);
    // Half way: a hard cut would already be gone.
    expect(sheet.opacity()).toBeCloseTo(0.5, 2);
    expect(sheet.wrap()).not.toBeNull();
    expect(sheet.slide()?.style.transform).toBe("");

    frame(100);
    expect(sheet.wrap()).toBeNull();
    expect(sheet.onCoveredChange).toHaveBeenLastCalledWith(false);

    // And back: it arrives by opacity, from the bottom of nowhere.
    sheet.setOpen(true);
    expect(sheet.opacity()).toBeCloseTo(0, 3);
    expect(sheet.slide()?.style.transform).toBe("");
    frames(2, 100);
    expect(sheet.opacity()).toBeCloseTo(0.5, 2);
    frame(100);
    expect(sheet.opacity()).toBe(1);
    expect(sheet.slide()?.style.transform).toBe("");
    expect(sheet.onCoveredChange).toHaveBeenLastCalledWith(true);
    expect(frameSubscriberCount()).toBe(0);
  });

  it("turns a half-faded exit around under a thumb instead of finishing it", () => {
    const sheet = mount({ reduced: true });
    sheet.setOpen(false);
    frames(2, 100);
    expect(sheet.opacity()).toBeCloseTo(0.5, 2);

    // A hand on it says it is not leaving: it is present, immediately.
    sheet.grab(100);
    sheet.move(140);
    flush();
    expect(sheet.opacity()).toBe(1);

    sheet.up(140);
    expect(sheet.onRestore).toHaveBeenCalledTimes(1);
    expect(sheet.offset()).toBe(0);
    expect(sheet.wrap()).not.toBeNull();
    expect(frameSubscriberCount()).toBe(0);
    sheet.setOpen(true);
  });
});

describe("the layer promise", () => {
  it("is made when the drag commits, not when a thumb lands on MINIMIZE", () => {
    const sheet = mount();

    sheet.grab(100);
    expect(sheet.slide()?.style.willChange).toBe("");
    sheet.move(104); // still a tap
    expect(sheet.slide()?.style.willChange).toBe("");

    sheet.move(140); // engaged
    expect(sheet.slide()?.style.willChange).toBe("transform");
    flush();

    sheet.up(140);
    // Settled back with no travel left to do: the layer goes back.
    settle();
    expect(sheet.slide()?.style.willChange).toBe("");
  });

  it("is given back when the sheet is torn down mid-flight", () => {
    const sheet = mount();
    sheet.setOpen(false);
    frame();
    const node = sheet.slide()!;
    expect(node.style.willChange).toBe("transform");

    sheet.unmount();
    expect(node.style.willChange).toBe("");
    expect(frameSubscriberCount()).toBe(0);
  });
});
