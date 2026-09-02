import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { type DiagEvent, type DiagEventMessage, type VerdictReport } from "@/lib/schema";
import { useFleetStore, useIncidentStore } from "@/lib/stores";
import { DESCENT_ATTR } from "./descent-motion";
import { isDescentOccluded, setDescentOccluded } from "./descent-occlusion";
import { DescentOverlay } from "./descent-overlay";

/**
 * DoD: the descent is triggered by a streamed diag_event, not by the
 * button press.
 *
 * This is the difference between a console and a screensaver, and it is worth
 * a test precisely because the optimistic version — drop into machine space
 * the moment the operator clicks — looks identical in a demo where the link is
 * healthy, and lies in the one situation the operator most needs the truth.
 */

const ev = (e: DiagEvent, unitId = "N-07"): DiagEventMessage => ({
  t: "diag_event",
  unitId,
  ev: e,
});

/**
 * Resolve the machine-space chunk before any test runs.
 *
 * Every `waitFor(() => expect(overlay()).not.toBeNull())` below is really
 * waiting on two things: the store commit this file is about, and `next/dynamic`
 * resolving `@/components/machine/descent-stage`. The second is the whole tree —
 * framer-motion, six canvas hosts, the virtualized log — and on a cold module
 * graph it is a Vite transform, not an import. Alone that costs tens of
 * milliseconds; inside a full parallel suite, sharing a transform server with
 * thirty-eight other files, it has twice been seen to outrun a 1000 ms
 * `waitFor` and fail a test whose subject is not loading at all.
 *
 * Importing the same specifier here pays that cost once, before the clock any
 * assertion runs against starts, and leaves the dynamic import inside the
 * component resolving from cache. The assertions are untouched: the trigger
 * discipline this file exists to protect — nothing on screen until `scan_start`
 * lands — is asserted synchronously and cannot be affected by how fast a chunk
 * arrives. Raising the timeouts instead would have hidden a slow chunk rather
 * than removed one, on the one screen whose budget says it must never be slow.
 *
 * The explicit timeout is for the transform itself, which is a build cost and
 * has no business being measured against a test's five-second default.
 */
beforeAll(async () => {
  await import("@/components/machine/descent-stage");
}, 60_000);

/** Store writes reach React, so they are state updates and belong in act(). */
const dispatch = (fn: () => void) => act(() => fn());

beforeEach(() => {
  useIncidentStore.getState().reset();
  document.documentElement.removeAttribute(DESCENT_ATTR);

  // The stage mounts the machine-space tree, which is canvas-backed. jsdom has
  // neither a ResizeObserver nor a 2d backend; the same stubs the other canvas
  // hosts use (see app/unit/[id]/unit-detail.test.tsx) let this file assert
  // what it is actually about — when the overlay is allowed to exist.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

const overlay = () => document.querySelector("[data-descent-layer]");

/** One turn of jsdom's frame loop, with the React work it queues committed. */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Wait for an assertion to hold, sampling once per animation frame.
 *
 * Every wait below that is not about the overlay appearing is gated on the far
 * end of a framer-motion animation: the exit tween calling `onDismissed`, the
 * covering wipe moving the occlusion fact. Under jsdom that end arrives only
 * through a chain of separate rAF event-loop turns — keyframe resolution, the
 * ticks, the completion notify, then React's commit — while the tween's own
 * progress is wall time (motion-dom's batcher stamps `performance.now()` on
 * every frame it processes). `waitFor` would put a wall-clock deadline on that
 * chain, making the wait a race between one timer and a queue of turns whose
 * individual latency, inside a sixteen-fork suite, is unbounded — a race no
 * finite deadline removes and a wider one only moves to a machine under
 * slightly more load.
 *
 * Sampling per frame dissolves the race: the condition is checked on the same
 * turns that produce it, and the budget is a count of frames, which load
 * cannot inflate — a starved loop delivers frames later, a later frame
 * advances a wall-clock tween further, so contention lowers the frames needed
 * and raises only the time waited. 240 frames is ~4 s at full rate against the
 * ~34 the longest wait here needs (the 550 ms covering wipe); the describe
 * timeouts below are the one wall clock left, a backstop against a dead frame
 * loop rather than a deadline any run is expected to approach. Each frame is
 * awaited inside `act`, so the React work a frame's animation callbacks queue
 * (`onDismissed`, the occlusion writes) is committed before the next look.
 *
 * The appearing waits stay on `waitFor`: mounting is a store commit and a
 * cached lazy resolution — scheduler turns, no rAF chain — and `waitFor`'s
 * MutationObserver sees that commit directly.
 */
async function acrossFrames(assertion: () => void, frames = 240): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt >= frames) throw error;
    }
    await nextFrame();
  }
}

describe("DescentOverlay — trigger discipline", () => {
  it("renders nothing while the fleet is quiet", () => {
    render(<DescentOverlay unitId="N-07" />);
    expect(overlay()).toBeNull();
  });

  it("renders nothing after Run diagnostic until scan_start actually arrives", () => {
    render(<DescentOverlay unitId="N-07" />);

    // The operator pressed the button and the command went out on the wire.
    dispatch(() => useIncidentStore.getState().beginDescent("N-07"));
    expect(useIncidentStore.getState().phase).toBe("descending");

    // No event has come back — the link may be dead. The operator page stays.
    expect(overlay()).toBeNull();
    expect(document.documentElement.hasAttribute(DESCENT_ATTR)).toBe(false);
  });

  it("descends once the sim answers, and drains the page under it", async () => {
    render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().beginDescent("N-07"));
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));

    await waitFor(() => expect(overlay()).not.toBeNull());
    expect(document.documentElement.getAttribute(DESCENT_ATTR)).toBe("under");
    expect(await screen.findByRole("dialog")).toHaveAttribute(
      "aria-label",
      "Diagnostic scan, unit N-07",
    );
  });

  it("ignores a scan on another unit", () => {
    render(<DescentOverlay unitId="N-07" />);
    dispatch(() =>
      useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" }, "N-03")),
    );
    expect(overlay()).toBeNull();
  });

  it("adopts a scan already in flight when the page joins late", async () => {
    // No beginDescent: this console did not start the scan, it walked into it.
    render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    await waitFor(() => expect(overlay()).not.toBeNull());
  });

  it("releases the page when the overlay leaves", async () => {
    const view = render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    await waitFor(() => expect(overlay()).not.toBeNull());

    view.unmount();
    expect(document.documentElement.hasAttribute(DESCENT_ATTR)).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
  });

  /**
   * The overlay unmounting must tear down *nothing* the store owns —
   * this is the property the whole leave-and-return feature stands on, and it
   * is worth an explicit assertion because it is a property of an absence:
   * there is no cleanup effect calling `abortSession`, and there must never be
   * one. A hard unmount is the strongest version of the question (navigation
   * away from the unit page), so it is the one asked here.
   */
  it("tears down no session state when it unmounts mid-scan", async () => {
    const view = render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    dispatch(() =>
      useIncidentStore
        .getState()
        .applyDiagEvent(ev({ k: "walk", path: "/sys/core/heartbeat.svc" })),
    );
    await waitFor(() => expect(overlay()).not.toBeNull());

    view.unmount();
    expect(useIncidentStore.getState().phase).toBe("scanning");
    expect(useIncidentStore.getState().session?.walkLines).toEqual([
      "/sys/core/heartbeat.svc",
    ]);
  });
});

/**
 * the descent is gated on the operator being in it, not only on the
 * scan running.
 *
 * Overriding the earlier "no way out before the verdict" decision (documented
 * in descent-overlay.tsx), CLOSE and Escape now leave a running scan. Two
 * things have to hold for that to be a door rather than a trap: leaving must
 * not stop or discard the scan, and going back in must land on the scan as it
 * is *now* — which it does for free, because machine space renders from the
 * store and keeps no copy of its own.
 */
describe("DescentOverlay — leaving a running scan", { timeout: 60_000 }, () => {
  it("comes down on leaveSession and stays down while the scan runs on", async () => {
    render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    await waitFor(() => expect(overlay()).not.toBeNull());

    dispatch(() => useIncidentStore.getState().leaveSession());
    await acrossFrames(() => expect(overlay()).toBeNull());

    // The page is the operator's again…
    expect(document.documentElement.hasAttribute(DESCENT_ATTR)).toBe(false);
    // …and the scan is still the sim's.
    expect(useIncidentStore.getState().phase).toBe("scanning");
    dispatch(() =>
      useIncidentStore
        .getState()
        .applyDiagEvent(ev({ k: "walk", path: "/firmware/gait/walk_cycle.ko" })),
    );
    expect(useIncidentStore.getState().session?.walkLines).toHaveLength(1);

    // Not even the verdict pulls the operator back in unasked.
    dispatch(() =>
      useIncidentStore.getState().applyDiagEvent(
        ev({
          k: "verdict",
          report: {
            unitId: "N-07",
            joint: "knee_L",
            component: "actuator_A07",
            anomaly: "gain",
            summary: "LEFT KNEE ACTUATOR A-07 GAIN ANOMALY",
            recommendations: ["Dispatch service"],
            ts: Date.now(),
          },
        }),
      ),
    );
    expect(overlay()).toBeNull();
  });

  it("re-descends on watchSession onto the scan as it stands now", async () => {
    render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    await waitFor(() => expect(overlay()).not.toBeNull());
    dispatch(() => useIncidentStore.getState().leaveSession());
    await acrossFrames(() => expect(overlay()).toBeNull());

    // Three nodes walked while nobody was watching.
    dispatch(() => {
      const store = useIncidentStore.getState();
      for (const path of [
        "/sys/core/heartbeat.svc",
        "/sys/core/power_rail/v48_main",
        "/firmware/gait/walk_cycle.ko",
      ]) {
        store.applyDiagEvent(ev({ k: "walk", path }));
      }
    });

    dispatch(() => useIncidentStore.getState().watchSession());
    await waitFor(() => expect(overlay()).not.toBeNull());

    // The board is rebuilt from the store, not resumed from a local buffer:
    // the walk count and the manifest both account for the three nodes that
    // arrived while the surface did not exist. (The log's own lines are
    // virtualized and need a real layout to render — e2e/leave-return.spec.ts
    // reads them in a browser.)
    expect(await screen.findByText("3 NODES")).toBeInTheDocument();
    expect(await screen.findByText("03/15 CLEARED")).toBeInTheDocument();
  });

  it("does not re-open unasked when the page remounts mid-scan", async () => {
    const view = render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    await waitFor(() => expect(overlay()).not.toBeNull());
    dispatch(() => useIncidentStore.getState().leaveSession());
    await acrossFrames(() => expect(overlay()).toBeNull());

    // Walking away and back — the operator left this scan on purpose, and a
    // console that dropped them into it again on arrival would be undoing the
    // decision the close control exists to give them.
    view.unmount();
    render(<DescentOverlay unitId="N-07" />);
    expect(overlay()).toBeNull();
  });
});

/**
 * NPA-01: the occlusion signal's boundaries, asserted through the real stage
 * with framer's animations running on jsdom's rAF. The fact itself is tested
 * in descent-occlusion.test.ts; these pin *when* the stage moves it — the one
 * thing that keeps "paused" meaning "invisible" and never "still visible".
 */
describe("DescentOverlay — occlusion signal (NPA-01)", { timeout: 60_000 }, () => {
  const REPORT: VerdictReport = {
    unitId: "N-07",
    joint: "knee_L",
    component: "actuator_A07",
    anomaly: "gain",
    summary: "LEFT KNEE ACTUATOR A-07 GAIN ANOMALY",
    recommendations: ["Schedule service"],
    ts: Date.now(),
  };

  const toVerdict = () =>
    dispatch(() => {
      const store = useIncidentStore.getState();
      store.applyDiagEvent(
        ev({ k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" }),
      );
      store.applyDiagEvent(ev({ k: "verdict", report: REPORT }));
    });

  /** jsdom has no matchMedia; give it one so the reduced branch is reachable. */
  const stubMotionPreference = (reduce: boolean) =>
    vi.stubGlobal(
      "matchMedia",
      (query: string): MediaQueryList =>
        ({
          matches: reduce && query.includes("prefers-reduced-motion"),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );

  afterEach(() => {
    setDescentOccluded(false);
    vi.unstubAllGlobals();
  });

  it("pauses at wipe-complete, not at mount — and resumes the instant the ascent begins", async () => {
    // The adopt path on purpose: a mid-scan reload mounts this exact way, and
    // the signal must initialise un-occluded until the replayed wipe lands.
    render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    await waitFor(() => expect(overlay()).not.toBeNull());

    // The surface is still climbing: the page underneath is visible and live.
    expect(isDescentOccluded()).toBe(false);

    // The wipe lands: covered, paused.
    await acrossFrames(() => expect(isDescentOccluded()).toBe(true));

    // Verdict, then return. `completeAscent` flips `active` false and the
    // surface starts leaving that same commit — the signal must already be
    // clear, synchronously, not after the away animation finishes.
    toVerdict();
    expect(isDescentOccluded()).toBe(true); // HOLD-alike: still covered, still paused
    dispatch(() => useIncidentStore.getState().completeAscent());
    expect(isDescentOccluded()).toBe(false);
  });

  it("draws the same boundaries around the reduced-motion crossfade", async () => {
    stubMotionPreference(true);
    render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    await waitFor(() => expect(overlay()).not.toBeNull());

    // Crossfade at full opacity — the reduced timeline's wipe-complete.
    await acrossFrames(() => expect(isDescentOccluded()).toBe(true));

    toVerdict();
    dispatch(() => useIncidentStore.getState().completeAscent());
    expect(isDescentOccluded()).toBe(false); // fade-out starts: page is showing again
  });

  it("never leaves the signal stuck if the stage is torn down mid-scan", async () => {
    const view = render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    await acrossFrames(() => expect(isDescentOccluded()).toBe(true));

    view.unmount();
    expect(isDescentOccluded()).toBe(false);
  });
});

/**
 * the ascent shows the scan it is leaving, for every frame of it.
 *
 * Observed on the live deploy — press RETURN and machine space printed a
 * *fresh* scan header on its way out: a session id nobody had seen, the state
 * word back to SCANNING, the elapsed clock reset. Nothing had restarted. The
 * stage was rendering live store state through an exit it outlives:
 * `completeAscent()` empties the store in one commit, and the surface still has
 * 120 ms of board fade and 250 ms of wipe left to play, so for those frames the
 * instrument described a scan that had never happened over the top of the one
 * that just had.
 *
 * It is a small window and it is the last thing an operator ever sees of
 * machine space, which makes it the frame this demo gets judged on.
 *
 * Asserted on the frame clock, never on wall time: the store commit is stepped,
 * then every frame the surface is still mounted is read and compared to the
 * frame before RETURN. The exit animations run on framer's own `performance.now()`
 * — nothing here seeds a time from a commit — so a slow machine only means more
 * samples of the same reading, never a different verdict.
 *
 * `Date.now` is pinned so the header's two time-derived fields are readable
 * rather than merely stable: the session opens at T0 and the console's
 * one-second ticker is seeded 25 s later, so the scan is genuinely mid-flight
 * and a reset prints `T+00:00` against a `T+00:25` that was on screen.
 */
describe("DescentOverlay — the ascent keeps its session", { timeout: 60_000 }, () => {
  const T0 = Date.UTC(2026, 7, 30, 12, 0, 0);
  let clock = T0;

  beforeEach(() => {
    clock = T0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    // The link is up: HOLD outranks every other word in the header and would
    // mask the one this file is watching (scan-copy.ts `scanPhaseWord`).
    useFleetStore.setState({ connection: "open" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useFleetStore.setState({ connection: "idle" });
  });

  /** jsdom has no matchMedia; give it one so the reduced branch is reachable. */
  const preferReducedMotion = () =>
    vi.stubGlobal(
      "matchMedia",
      (query: string): MediaQueryList =>
        ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );

  const REPORT: VerdictReport = {
    unitId: "N-07",
    joint: "knee_L",
    component: "actuator_A07",
    anomaly: "gain",
    summary: "LEFT KNEE ACTUATOR A-07 GAIN ANOMALY",
    recommendations: ["Schedule service"],
    ts: T0 + 25_000,
  };

  /** What the session header says about itself, as three separable facts. */
  interface HeaderReading {
    session: string | null;
    clock: string | null;
    state: string | null;
  }

  function readHeader(): HeaderReading {
    const header = document.querySelector<HTMLElement>("[data-descent-layer] header");
    if (header === null) throw new Error("no scan header on screen");
    const text = header.textContent ?? "";
    return {
      session: /[0-9A-F]{4}-[0-9A-F]{4}/.exec(text)?.[0] ?? null,
      clock: /T\+\d{2}:\d{2}/.exec(text)?.[0] ?? null,
      state: /SCANNING|VERDICT|HOLD/.exec(text)?.[0] ?? null,
    };
  }

  const surfaceText = (): string =>
    (document.querySelector("[data-descent-layer]")?.textContent ?? "").replace(
      /\s+/g,
      " ",
    );

  /**
   * The three counters the surface composes for itself, in the three places an
   * operator would notice them resetting: the walk panel's node count, the
   * manifest's cleared count, and the bottom rule's sentence.
   *
   * Read rather than predicted — what each one *says* is manifest-spec.ts's and
   * scan-copy.ts's business, tested there. What this file owns is that none of
   * them changes on the way out.
   */
  function readInstrument() {
    const layer = document.querySelector("[data-descent-layer]");
    if (layer === null) throw new Error("no machine surface on screen");
    const text = surfaceText();
    const live = [...layer.querySelectorAll("[aria-live]")]
      .map((el) => (el.textContent ?? "").trim())
      .find((line) => /^(SCAN COMPLETE|WALKING|SCANNING|INITIALISING|HOLD)\b/.test(line));
    return {
      nodes: /\d+ NODES/.exec(text)?.[0] ?? null,
      cleared: /\d\d\/\d\d CLEARED/.exec(text)?.[0] ?? null,
      status: live ?? null,
    };
  }

  /** Distinct readings in first-seen order — the failure message names the flash. */
  const distinct = <T,>(readings: T[]): T[] => [
    ...new Map(readings.map((r) => [JSON.stringify(r), r])).values(),
  ];

  /**
   * A scan twenty-five seconds old with three nodes walked and one channel in,
   * showing on a surface that has finished arriving.
   */
  async function midScan() {
    render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().beginDescent("N-07"));
    // The clock moves before `scan_start`, not after: the session keeps the
    // `startedAt` it opened with, and the shared ticker is seeded when the
    // header mounts — so the header reads T+00:25 without a timer to race.
    clock = T0 + 25_000;
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    dispatch(() => {
      const store = useIncidentStore.getState();
      for (const path of [
        "/sys/core/heartbeat.svc",
        "/sys/core/power_rail/v48_main",
        "/firmware/gait/walk_cycle.ko",
      ]) {
        store.applyDiagEvent(ev({ k: "walk", path }));
      }
      store.applyDiagEvent(
        ev({ k: "channel", joint: "knee_L", wave: [0, 1, 0, -1], ref: [0, 1, 0, -1] }),
      );
    });
    await waitFor(() => expect(overlay()).not.toBeNull());
    await acrossFrames(() => expect(readHeader().clock).toBe("T+00:25"));
  }

  const toVerdict = () =>
    dispatch(() => {
      const store = useIncidentStore.getState();
      store.applyDiagEvent(
        ev({ k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" }),
      );
      store.applyDiagEvent(ev({ k: "verdict", report: REPORT }));
    });

  /** Sample every frame the surface is still on screen, from RETURN to gone. */
  async function acrossTheAscent<T>(read: () => T): Promise<T[]> {
    const readings: T[] = [];
    for (let frame = 0; frame < 240 && overlay() !== null; frame += 1) {
      readings.push(read());
      await nextFrame();
    }
    expect(overlay()).toBeNull(); // the ascent actually finished
    expect(readings.length).toBeGreaterThan(0);
    return readings;
  }

  it("never re-prints the session header while the surface is leaving", async () => {
    await midScan();
    const scanning = readHeader();
    expect(scanning).toEqual({
      session: expect.stringMatching(/^[0-9A-F]{4}-[0-9A-F]{4}$/) as unknown as string,
      clock: "T+00:25",
      state: "SCANNING",
    });

    toVerdict();
    const atVerdict = readHeader();
    expect(atVerdict).toEqual({ ...scanning, state: "VERDICT" });

    // RETURN. The store is emptied in this commit; the surface is not.
    dispatch(() => useIncidentStore.getState().completeAscent());

    expect(distinct(await acrossTheAscent(readHeader))).toEqual([atVerdict]);
  });

  it("never re-prints the instrument under it either", async () => {
    await midScan();
    toVerdict();

    const atVerdict = readInstrument();
    // The scan on screen is a finished one with a history behind it — the
    // reading has to be worth destroying for the assertion to mean anything.
    expect(atVerdict.nodes).toBe("3 NODES");
    expect(atVerdict.status).toMatch(/^SCAN COMPLETE · 01 CHANNELS · 01 ANOMALY$/);
    expect(atVerdict.cleared).not.toBe("00/15 CLEARED");

    dispatch(() => useIncidentStore.getState().completeAscent());

    expect(distinct(await acrossTheAscent(readInstrument))).toEqual([atVerdict]);
  });

  /**
   * The reduced timeline is where this mattered most and would have been
   * found last: the surface does not climb away, it *crossfades* — so a
   * re-printed header would have been legible over the operator page on its
   * way back, on the one setting where the transition is supposed to be the
   * least eventful thing in the product.
   */
  it("holds the same reading through the reduced-motion crossfade", async () => {
    preferReducedMotion();
    await midScan();
    toVerdict();
    const atVerdict = readHeader();
    expect(atVerdict.state).toBe("VERDICT");

    dispatch(() => useIncidentStore.getState().completeAscent());

    expect(distinct(await acrossTheAscent(readHeader))).toEqual([atVerdict]);
  });
});
