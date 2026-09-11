/**
 * Which diagnostic surface a scan opens in.
 *
 * The console can render one diagnostic session two ways. **Calm** keeps the
 * operator in operator space: the scan, its evidence and its verdict arrive as
 * the same warm cards the rest of the console is built from. **Machine** is the
 * descent — the page drains, a black surface wipes up, and the robot reports on
 * itself in phosphor mono.
 *
 * Neither is a different diagnostic. Both are projections of the same incident
 * session, driven by the same wire events, reaching the same verdict and the
 * same recorded incident; what differs is the register the console speaks in.
 *
 * Calm is the default because it is the one an operator would actually be
 * handed. Machine space is opt-in — and the choice persists, because it is a
 * statement about how someone wants the interface to behave, not the state of
 * one sitting. Turning machine space on and reloading should not silently turn
 * it back off. Calm is the default; it is not a mode the app re-asserts over an
 * explicit choice.
 *
 * This module deliberately stops at the preference. It is *read* where a
 * session opens rather than consulted by the store, because the store's
 * `watching` flag means "the operator is in machine space right now" and has
 * to stay true to that: a `watching` left true while the operator sits in the
 * calm panel would make the departing-session snapshot hold a surface that was
 * never on screen.
 */

import * as React from "react";

export type DiagnosticView = "calm" | "machine";

export const DEFAULT_DIAGNOSTIC_VIEW: DiagnosticView = "calm";

const KEY = "fleet-console.diagnostic-view";

function isDiagnosticView(value: unknown): value is DiagnosticView {
  return value === "calm" || value === "machine";
}

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // A private window can throw on the property itself. The preference is
    // worth less than the page, so an unreadable store means the default.
    return null;
  }
}

/**
 * The stored preference, believed only as far as its shape.
 *
 * Anything else in the slot — an older build's value, a hand-edited string —
 * reads as the default rather than as a third state nothing downstream mounts.
 */
export function readDiagnosticView(): DiagnosticView {
  try {
    const raw = store()?.getItem(KEY);
    return isDiagnosticView(raw) ? raw : DEFAULT_DIAGNOSTIC_VIEW;
  } catch {
    return DEFAULT_DIAGNOSTIC_VIEW;
  }
}

/**
 * Subscribers, and the reason this is not simply `useState` in the toggle.
 *
 * The control that flips the preference and the surfaces that obey it are not
 * in one subtree — the toggle sits in the panel, the descent mounts a portal —
 * so both read through one external store. The `storage` event joins a second
 * tab to the same value; the local set has to notify by hand, because a tab
 * does not hear its own writes.
 */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function onStorage(event: StorageEvent): void {
  if (event.key === null || event.key === KEY) emit();
}

export function setDiagnosticView(next: DiagnosticView): void {
  try {
    store()?.setItem(KEY, next);
  } catch {
    // A full or unavailable quota costs the preference its memory, not its
    // effect: the in-memory subscribers still move.
  }
  emit();
}

/**
 * The preference, as React state.
 *
 * The server snapshot is the default rather than the stored value, because
 * this app static-exports: the prerendered HTML is one artifact served to
 * everyone and cannot know what any particular browser remembers. So the first
 * paint is always calm and the effect corrects it. Nothing may render a
 * loading state for this — render calm, let the correction happen.
 */
export function useDiagnosticView(): DiagnosticView {
  return React.useSyncExternalStore(
    subscribe,
    readDiagnosticView,
    () => DEFAULT_DIAGNOSTIC_VIEW,
  );
}

export {
  KEY as DIAGNOSTIC_VIEW_KEY,
  isDiagnosticView,
  subscribe as subscribeDiagnosticView,
};
