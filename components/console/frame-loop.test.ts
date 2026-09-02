import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameSubscriberCount, registerFrame } from "./frame-loop";

/**
 * The loop is shared infrastructure: eighteen strips today, six waveforms and
 * a descent overlay in Phase 3. What has to hold is that it stays *one* loop,
 * that it stops when nobody is drawing, and that one broken instrument cannot
 * take the others down — the failure mode of a shared scheduler is total, and
 * the whole page going still because one canvas threw would be a much worse
 * bug than the one that caused it.
 */

/** Scheduled-but-not-yet-run frames, keyed the way the platform keys them. */
let queue = new Map<number, FrameRequestCallback>();
let cancelled: number[] = [];
let microtasks: Array<() => void> = [];

/** Run whatever the loop has scheduled, once. */
function frame(now: number): void {
  const due = [...queue.values()];
  queue.clear();
  for (const cb of due) cb(now);
}

beforeEach(() => {
  queue = new Map();
  cancelled = [];
  microtasks = [];
  let handle = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    handle += 1;
    queue.set(handle, cb);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (h: number) => {
    cancelled.push(h);
    queue.delete(h);
  });
  // The loop re-throws a subscriber's error asynchronously; capture it rather
  // than letting it land on the test runner.
  vi.stubGlobal("queueMicrotask", (fn: () => void) => microtasks.push(fn));
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(frameSubscriberCount()).toBe(0);
});

describe("the shared rAF loop", () => {
  it("starts on the first subscriber and calls it with the frame timestamp", () => {
    const draw = vi.fn();
    const stop = registerFrame(draw);
    expect(queue.size).toBe(1);

    frame(16.7);
    expect(draw).toHaveBeenCalledExactlyOnceWith(16.7);

    stop();
  });

  it("drives every subscriber from one animation frame, not one each", () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const stops = [registerFrame(a), registerFrame(b), registerFrame(c)];

    expect(frameSubscriberCount()).toBe(3);
    // three instruments, one scheduled callback
    expect(queue.size).toBe(1);

    frame(0);
    expect(queue.size).toBe(1); // rescheduled itself, still exactly one
    frame(16);

    for (const spy of [a, b, c]) expect(spy).toHaveBeenCalledTimes(2);
    for (const stop of stops) stop();
  });

  it("stops scheduling once the last subscriber leaves", () => {
    const draw = vi.fn();
    const stop = registerFrame(draw);
    frame(0);
    expect(draw).toHaveBeenCalledTimes(1);

    stop();
    expect(cancelled).toHaveLength(1);
    expect(queue.size).toBe(0);

    frame(16); // nothing pending
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("keeps running for a subscriber that unsubscribes mid-frame", () => {
    const later = vi.fn();
    let stopEarly: () => void = () => {};
    const early = vi.fn(() => stopEarly());
    stopEarly = registerFrame(early);
    const stopLater = registerFrame(later);

    frame(0);
    expect(later).toHaveBeenCalledTimes(1);

    frame(16);
    expect(early).toHaveBeenCalledTimes(1); // gone
    expect(later).toHaveBeenCalledTimes(2);

    stopLater();
  });

  it("drops a throwing subscriber, surfaces its error, and keeps the rest drawing", () => {
    const boom = new Error("canvas gone");
    const bad = vi.fn(() => {
      throw boom;
    });
    const good = vi.fn();
    registerFrame(bad);
    const stopGood = registerFrame(good);

    frame(0);
    expect(good).toHaveBeenCalledTimes(1);
    expect(frameSubscriberCount()).toBe(1); // the bad one is out

    // the error is not swallowed: it is re-thrown outside the loop
    expect(microtasks).toHaveLength(1);
    expect(() => microtasks[0]?.()).toThrow(boom);

    frame(16);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(2);

    stopGood();
  });
});
