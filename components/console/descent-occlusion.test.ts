// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDescentOccluded,
  setDescentOccluded,
  subscribeDescentOcclusion,
} from "./descent-occlusion";

/**
 * The occlusion signal's contract. The *when* — wipe-complete sets
 * it, ascend-start clears it, in both timelines — is wired in
 * descent-stage.tsx and asserted through the overlay in
 * descent-overlay.test.tsx; what belongs here is the signal itself: a module
 * fact that starts false, notifies exactly on change, and can be polled from
 * a frame callback for the cost of a boolean read.
 */
describe("descent occlusion signal", () => {
  afterEach(() => setDescentOccluded(false));

  it("starts un-occluded — a page that mounts mid-scan draws until the replayed wipe lands", () => {
    expect(isDescentOccluded()).toBe(false);
  });

  it("flips with the surface: wipe-complete pauses, ascend-start resumes", () => {
    setDescentOccluded(true); // the stage's onAnimationComplete("covering")
    expect(isDescentOccluded()).toBe(true);

    setDescentOccluded(false); // the stage's `active` dropping
    expect(isDescentOccluded()).toBe(false);
  });

  it("notifies subscribers on change only — repeated writes are free", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDescentOcclusion(listener);

    setDescentOccluded(true);
    expect(listener).toHaveBeenCalledTimes(1);

    // The stage may re-report a landed surface (an interrupted-and-resumed
    // animation completes twice); nobody re-renders for a fact that held.
    setDescentOccluded(true);
    expect(listener).toHaveBeenCalledTimes(1);

    setDescentOccluded(false);
    expect(listener).toHaveBeenCalledTimes(2);
    setDescentOccluded(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setDescentOccluded(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps polling and subscription in agreement", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeDescentOcclusion(() => seen.push(isDescentOccluded()));
    setDescentOccluded(true);
    setDescentOccluded(false);
    unsubscribe();
    expect(seen).toEqual([true, false]);
  });
});
