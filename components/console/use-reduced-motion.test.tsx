import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { descentTimeline } from "./descent-motion";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/**
 * The reduced-motion branch of the descent is the branch a reviewer is least
 * likely to see and most likely to check, and it is the one place in the demo
 * where "the animation is the feature" collides with an accessibility
 * preference. So the hook that decides it is tested directly, including the
 * case where the environment has no `matchMedia` at all — a hook that threw
 * there would take the whole overlay down with it.
 */

type Listener = (e: MediaQueryListEvent) => void;

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
    addListener: (l: Listener) => listeners.add(l),
    removeListener: (l: Listener) => listeners.delete(l),
    dispatchEvent: () => true,
    onchange: null,
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
  return {
    set(next: boolean) {
      mql.matches = next;
      act(() => {
        for (const l of listeners) l({ matches: next } as MediaQueryListEvent);
      });
    },
    listenerCount: () => listeners.size,
  };
}

function Probe() {
  const reduced = usePrefersReducedMotion();
  const t = descentTimeline(reduced);
  return (
    <output data-testid="probe">
      {reduced ? "reduced" : "full"}:{t.wipeMs}:{t.bootStaggerMs}
    </output>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePrefersReducedMotion", () => {
  it("reads the preference on mount", () => {
    stubMatchMedia(true);
    render(<Probe />);
    // The crossfade timeline: 200 ms, no stagger.
    expect(screen.getByTestId("probe")).toHaveTextContent("reduced:200:0");
  });

  it("gives the full choreography when nothing is preferred", () => {
    stubMatchMedia(false);
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("full:350:45");
  });

  it("follows the preference changing under it", () => {
    const media = stubMatchMedia(false);
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("full:350:45");
    media.set(true);
    expect(screen.getByTestId("probe")).toHaveTextContent("reduced:200:0");
  });

  it("detaches its listener on unmount", () => {
    const media = stubMatchMedia(true);
    const view = render(<Probe />);
    expect(media.listenerCount()).toBe(1);
    view.unmount();
    expect(media.listenerCount()).toBe(0);
  });

  it("assumes full motion where matchMedia does not exist, without throwing", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("full:350:45");
  });
});
