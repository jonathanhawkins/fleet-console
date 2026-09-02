/**
 * Whether the descent surface is currently opaque over the operator page —
 * the app's one occlusion fact, as a module-level signal (NPA-01).
 *
 * While a scan runs, the unit page underneath the descent stage is 100 %
 * covered, yet nothing that draws it knows: the eighteen telemetry strips keep
 * redrawing inside the `[data-descent]` filter-flattened subtree, and the R3F
 * turntable's IntersectionObserver still reports intersection, because
 * occlusion is not intersection. This module is the missing fact.
 *
 * **Boundaries.** Occluded runs from *wipe-complete* (the surface has fully
 * landed — under reduced motion, the crossfade has reached opacity 1) until
 * *ascend-start* (the surface begins to leave and the page underneath starts
 * showing again). Deliberately NOT from the moment `data-descent` is written:
 * during the dim and the wipe the page is still visible and must stay live.
 * The descent stage owns both transitions, because the stage's surface is the
 * thing whose opacity this signal describes.
 *
 * **Consumers, two kinds.** Frame-loop registrants (the strips) poll
 * {@link isDescentOccluded} at the top of their callback — a module boolean
 * read, allocation-free, no subscription, exactly like their version check.
 * React gates (the component viewer's viewport gate) subscribe via
 * {@link subscribeDescentOcclusion} so occluded flows down the same `visible`
 * path an IntersectionObserver miss uses. Nobody unregisters anything: paused
 * work stays registered and resumes the frame the signal clears, and the
 * strips' `drawnVersion` staleness check repaints whatever advanced while
 * hidden.
 *
 * No React and no DOM in here, on purpose: the writers live in the lazy
 * machine chunk and the readers in rAF callbacks, and both need a flat
 * function call, not a store.
 */

let occluded = false;

const listeners = new Set<() => void>();

/**
 * Flip the signal. Idempotent — repeated writes of the same value notify
 * nobody, so the stage may call this from animation callbacks without
 * debouncing. Only the descent stage (and tests) should ever call it.
 */
export function setDescentOccluded(next: boolean): void {
  if (occluded === next) return;
  occluded = next;
  for (const listener of listeners) listener();
}

/** The current fact, for polling from a frame callback. */
export function isDescentOccluded(): boolean {
  return occluded;
}

/**
 * Change notification, for React gates (`useSyncExternalStore`-shaped).
 * Returns an unsubscribe.
 */
export function subscribeDescentOcclusion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
