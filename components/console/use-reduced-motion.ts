"use client";

import * as React from "react";

/**
 * `prefers-reduced-motion: reduce`, as a subscription.
 *
 * framer-motion ships its own version of this hook, and the descent could use
 * it — but only from inside the lazy machine-space chunk, and the descent's
 * reduced-motion branch is the one branch of the money shot that a reviewer is
 * least likely to see and most likely to check. Owning fifteen lines here
 * means the branch is testable with a stubbed `matchMedia` and no animation
 * library in the test environment.
 *
 * `useSyncExternalStore` rather than state-plus-effect for the same reason the
 * app's one-second ticker uses it: the server snapshot is `false` (no
 * `matchMedia` on the server, and full motion is the safe assumption to
 * hydrate against), and every consumer in a render pass reads the same answer.
 */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function mediaQuery(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(query);
}

function subscribeTo(query: string, onChange: () => void): () => void {
  const mql = mediaQuery(query);
  if (!mql) return () => {};
  // addEventListener over the deprecated addListener, with a guard: jsdom and
  // older WebKit expose one or the other, and a hook that throws on subscribe
  // would take the whole overlay down.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  mql.addListener(onChange);
  return () => mql.removeListener(onChange);
}

/**
 * Any media query, as a subscription — the general case of the hook below.
 *
 * It exists for the one kind of responsiveness CSS genuinely cannot express:
 * *not rendering a thing*. `display: none` on the board's turntable would keep
 * a canvas, a ResizeObserver and a per-frame draw alive on the device least
 * able to afford them (see status-board.tsx). The rest of the responsive work
 * in this product is, and should stay, in the stylesheet.
 *
 * The false server snapshot means every query hydrates as "not matching" and
 * corrects on the first client pass, which is the safe direction: the layout
 * the markup declares is the wide one.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => subscribeTo(query, onChange),
    [query],
  );
  const getSnapshot = React.useCallback(
    () => mediaQuery(query)?.matches ?? false,
    [query],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION);
}
