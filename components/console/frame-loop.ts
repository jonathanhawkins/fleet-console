"use client";

import * as React from "react";

/**
 * One requestAnimationFrame loop for the whole app (PRD §7, CLAUDE.md
 * non-negotiable #3).
 *
 * Every canvas instrument in this product — the eighteen TelemetryStrips on a
 * unit page, the six WaveformStrips of the descent — draws
 * from this loop. The alternative, a rAF per component, is the standard way a
 * dashboard ends up with twenty schedulers, twenty callbacks the browser has
 * to reconcile against one vsync, and no single place to measure or throttle.
 * Here there is exactly one, it runs only while something is subscribed and
 * the tab is on screen, and the frame timestamp every subscriber sees is the
 * same instant.
 *
 * The API is deliberately not "a hook that owns a canvas": the descent registers
 * callbacks that draw six waveforms into one canvas, and a per-canvas hook
 * would not fit. Register a function, get an unsubscribe.
 *
 *   const stop = registerFrame((now) => draw(now));   // imperative
 *   useFrame(draw);                                    // React lifecycle
 *
 * Subscribers must be cheap and must not throw. One that does is dropped from
 * the loop and its error re-thrown asynchronously, so a single broken
 * instrument surfaces in the console instead of taking every other instrument
 * on the page down with it.
 */

export type FrameCallback = (now: number) => void;

const subscribers = new Set<FrameCallback>();
let handle: number | null = null;
let watching = false;

function tick(now: number): void {
  handle = null;
  // Set iteration tolerates deletion during the walk, which is what an
  // unmount inside a callback amounts to.
  for (const cb of subscribers) {
    try {
      cb(now);
    } catch (error) {
      subscribers.delete(cb);
      queueMicrotask(() => {
        throw error;
      });
    }
  }
  schedule();
}

/** Resume the moment the tab comes back; the subscribers never knew it left. */
function onVisibility(): void {
  if (!document.hidden) schedule();
}

function watchVisibility(): void {
  if (watching || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", onVisibility);
  watching = true;
}

function unwatchVisibility(): void {
  if (!watching) return;
  document.removeEventListener("visibilitychange", onVisibility);
  watching = false;
}

function schedule(): void {
  if (handle !== null || subscribers.size === 0) return;
  // A tab that is not on screen is not compositing, so every frame drawn into
  // it is work with no reader. Browsers throttle background rAF on their own,
  // but throttled is not stopped, and this loop's subscribers are canvases —
  // the difference is a laptop fan on a page nobody is looking at.
  if (typeof document !== "undefined" && document.hidden) return;
  // Read off globalThis at call time rather than capturing at module load, so
  // a test can stub the scheduler and drive frames deterministically.
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== "function") return; // SSR, or a jsdom without rAF
  handle = raf(tick);
}

/**
 * Add a callback to the shared loop. Returns an unsubscribe function; the loop
 * stops itself when the last subscriber leaves.
 */
export function registerFrame(cb: FrameCallback): () => void {
  subscribers.add(cb);
  watchVisibility();
  schedule();
  return () => {
    subscribers.delete(cb);
    if (subscribers.size > 0) return;
    if (handle !== null) {
      globalThis.cancelAnimationFrame?.(handle);
      handle = null;
    }
    unwatchVisibility();
  };
}

/** How many instruments are currently drawing. Diagnostics and tests. */
export function frameSubscriberCount(): number {
  return subscribers.size;
}

/**
 * React binding for {@link registerFrame}.
 *
 * The callback is held in a ref and the subscription is made once, on mount:
 * a caller does not have to memoise its draw function, and re-rendering the
 * host (which, for a strip, should never happen) cannot churn the loop.
 */
export function useFrame(cb: FrameCallback): void {
  const ref = React.useRef(cb);
  React.useInsertionEffect(() => {
    ref.current = cb;
  }, [cb]);
  React.useEffect(() => registerFrame((now) => ref.current(now)), []);
}
