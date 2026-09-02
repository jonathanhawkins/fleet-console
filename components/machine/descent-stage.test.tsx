import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DescentOverlay } from "@/components/console/descent-overlay";
import { EASE_WIPE, descentTimeline } from "@/components/console/descent-motion";
import { IncidentBanner } from "@/components/console/incident-banner";
import {
  RUN_BLOCKED_REASON,
  RunDiagnosticButton,
} from "@/components/console/run-diagnostic";
import { setCommandTransport } from "@/components/console/telemetry-command";
import {
  type DiagEvent,
  type DiagEventMessage,
  type OperatorCommand,
  type VerdictReport,
} from "@/lib/schema";
import { selectShownSession, useFleetStore, useIncidentStore } from "@/lib/stores";
import { type TelemetryTransport } from "@/lib/transport";
import { EXECUTED_RECOMMENDATION } from "./safe-sit-copy";
import { useScanLink } from "./scan-state";
import type * as ScanLogLines from "./scan-log-lines";

/**
 * what the surface is allowed to do while it is leaving.
 *
 * latched the *display* of the scan so the ascent stops re-printing
 * itself as a fresh diagnostic on the way out. That was right, and it was
 * applied to two of the surface's inputs and not to the rest. This file is
 * about the two things that fell out of it:
 *
 * 1. A surface that outlives its session outlives its *controls*. Nothing
 * applied `inert` or `pointer-events: none` to the departing layer, so for
 * the length of the exit — a pure opacity fade under `prefers-reduced-
 * motion`, over a `fixed inset-0 z-50` box — the verdict's EXECUTE
 * controls were invisible and fully hit-testable over the operator page. A
 * click that reached CONFIRM sent a real command to a robot and then
 * no-oped `acknowledgeRecommendation`, because `completeAscent` had
 * already archived the incident: the command leaves the building and the
 * record cannot say it did.
 *
 * 2. `link` was the one input the latch did not cover. It is read live from
 * `useScanLink`, whose `selectSessionEventCount` returns 0 the instant
 * `completeAscent` nulls the session — so a session whose link had dropped
 * and come back before its first walk line ends the scan by re-satisfying
 * the "resumed" condition, and the log appends HOLD — LINK RESTORED ·
 * AWAITING SEQUENCE to the tail of a *finished* scan. The same class of
 * lie the latch was added to remove, arriving through the one input left
 * live.
 *
 * The third describe is the constraint on both fixes: the choreography is the
 * signature moment of this demo, and neither of them is allowed to move it. The
 * ascent's ramp is measured — fitted, not eyeballed — in both timelines.
 */

/**
 * The scan log's lines, as the component actually builds them.
 *
 * The log is virtualized against a scroller that jsdom gives no layout, so
 * `getVirtualItems()` is empty here and there is nothing in the DOM to assert
 * on (`calculateRange` requires `outerSize > 0`). Its *content* is not a
 * rendering question though — `buildScanLog` is a pure projection and the panel
 * paints a window onto whatever it returns — so the assertion is made where the
 * content is decided. e2e/leave-return.spec.ts reads the painted lines in a
 * browser.
 */
const logSpy = vi.hoisted(() => ({
  calls: [] as Array<{ link: string; kinds: string[]; texts: string[] }>,
}));

vi.mock("./scan-log-lines", async (importOriginal) => {
  const actual = await importOriginal<typeof ScanLogLines>();
  return {
    ...actual,
    buildScanLog: (input: ScanLogLines.ScanLogInput) => {
      const lines = actual.buildScanLog(input);
      logSpy.calls.push({
        link: input.link,
        kinds: lines.map((l) => l.kind),
        texts: lines.map((l) => l.text),
      });
      return lines;
    },
  };
});

/** See the note in descent-overlay.test.tsx: pay the chunk's transform once. */
beforeAll(async () => {
  await import("./descent-stage");
}, 60_000);

const ev = (e: DiagEvent, unitId = "N-07"): DiagEventMessage => ({
  t: "diag_event",
  unitId,
  ev: e,
});

/** Store writes reach React, so they are state updates and belong in act(). */
const dispatch = (fn: () => void) => act(() => fn());

const overlay = () => document.querySelector<HTMLElement>("[data-descent-layer]");

/** The element the exit animates — the layer's only child. */
const surfaceEl = () => document.querySelector<HTMLElement>("[data-descent-layer] > *");

const REPORT: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LEFT KNEE ACTUATOR A-07 GAIN ANOMALY",
  recommendations: [EXECUTED_RECOMMENDATION, "Schedule service"],
  ts: Date.now(),
};

/** Every command that reached the wire. The assertion this file is built on. */
let sent: OperatorCommand[] = [];

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

beforeEach(() => {
  logSpy.calls.length = 0;
  sent = [];
  useIncidentStore.getState().reset();
  useFleetStore.getState().reset();
  // The link is up: HOLD outranks every other word on this surface and the
  // second describe is about exactly when it is allowed to appear.
  useFleetStore.setState({ connection: "open" });

  const transport: TelemetryTransport = {
    connect: () => {},
    send: (cmd) => {
      sent.push(cmd);
    },
    disconnect: () => {},
  };
  setCommandTransport(transport);

  // The stage mounts the machine-space tree, which is canvas-backed; jsdom has
  // neither a ResizeObserver nor a 2d backend.
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

afterEach(() => {
  setCommandTransport(null);
  useFleetStore.setState({ connection: "idle" });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
 * Same reasoning as descent-overlay.test.tsx: the far end of a framer-motion
 * animation arrives through a chain of separate rAF turns whose individual
 * latency inside a parallel suite is unbounded, so the budget is a count of
 * frames rather than a wall-clock deadline.
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

/** A settled surface showing a finished scan, with the verdict card on it. */
async function toVerdict(): Promise<void> {
  render(<DescentOverlay unitId="N-07" />);
  dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
  await waitFor(() => expect(overlay()).not.toBeNull());
  dispatch(() => {
    const store = useIncidentStore.getState();
    store.applyDiagEvent(ev({ k: "walk", path: "/firmware/gait/walk_cycle.ko" }));
    store.applyDiagEvent(
      ev({ k: "channel", joint: "knee_L", wave: [0, 1, 0, -1], ref: [0, 1, 0, -1] }),
    );
    store.applyDiagEvent(
      ev({ k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" }),
    );
    store.applyDiagEvent(ev({ k: "verdict", report: REPORT }));
  });
  await screen.findByRole("button", { name: EXECUTED_RECOMMENDATION });
}

describe(
  "DescentStage — nothing under a departing surface is pressable",
  { timeout: 60_000 },
  () => {
    it("sends nothing on the wire when a click lands on the leaving surface", async () => {
      const user = userEvent.setup();
      await toVerdict();

      // The operator opened the confirmation and then left — CLOSE, Escape and
      // RETURN all land on `completeAscent`, and none of them takes the
      // confirmation down with them.
      await user.click(screen.getByRole("button", { name: EXECUTED_RECOMMENDATION }));
      const confirm = await screen.findByRole("button", { name: "Confirm" });
      expect(sent).toEqual([]);

      dispatch(() => useIncidentStore.getState().completeAscent());

      // The surface outlives the session by one exit — that is the design, and
      // it is what makes this window exist at all.
      expect(overlay()).not.toBeNull();
      expect(confirm.isConnected).toBe(true);

      // …and for every frame of it, the pointer cannot reach a robot.
      await expect(user.click(confirm)).rejects.toThrow(/pointer-events/);
      expect(sent).toEqual([]);

      // The other half of the bug: the incident is already archived, so a
      // command that got through could never have been recorded against it.
      expect(useIncidentStore.getState().history[0]?.acknowledged).toEqual([]);
    });

    it("refuses the EXECUTE control itself, so the confirmation is unreachable", async () => {
      const user = userEvent.setup();
      await toVerdict();
      const execute = screen.getByRole("button", { name: EXECUTED_RECOMMENDATION });

      dispatch(() => useIncidentStore.getState().completeAscent());

      await expect(user.click(execute)).rejects.toThrow(/pointer-events/);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(sent).toEqual([]);
    });

    /**
     * The reduced timeline is where this bites hardest and would have been
     * found last: the surface does not climb away, it fades — so the EXECUTE
     * controls spend the whole exit invisible and, before this fix, live.
     */
    it("holds under prefers-reduced-motion, where the exit is a pure fade", async () => {
      preferReducedMotion();
      const user = userEvent.setup();
      await toVerdict();

      await user.click(screen.getByRole("button", { name: EXECUTED_RECOMMENDATION }));
      const confirm = await screen.findByRole("button", { name: "Confirm" });

      dispatch(() => useIncidentStore.getState().completeAscent());

      const surface = surfaceEl();
      // Mid-fade: still painted, still on top of the whole viewport.
      await acrossFrames(() => expect(Number(surface?.style.opacity)).toBeLessThan(0.9));
      expect(overlay()).not.toBeNull();

      await expect(user.click(confirm)).rejects.toThrow(/pointer-events/);
      expect(sent).toEqual([]);
    });

    it("takes the leaving surface out of the a11y tree and the hit test, and not before", async () => {
      await toVerdict();
      const layer = overlay()!;

      // While it is the operator's surface it is a live modal, untouched.
      expect(layer).not.toHaveAttribute("inert");
      expect(layer.style.pointerEvents).toBe("");
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      dispatch(() => useIncidentStore.getState().completeAscent());

      // The latch is for display: what it shows is frozen, what it does is over.
      expect(layer).toHaveAttribute("inert");
      expect(layer.style.pointerEvents).toBe("none");
    });
  },
);

/**
 * (2): the link is part of what the surface is *showing*.
 *
 * The setup is the one real-world shape that produces the lie: the socket drops
 * and restores before the first walk line is admitted, so `countAtRestore` is
 * pinned at 0. Through the scan the event count is above 0 and the link reads
 * `open`; at `completeAscent` the session goes null, the count returns to 0, and
 * the live hook reports `resumed` again — which is *true of the store* and a lie
 * about the scan on screen.
 */
describe(
  "DescentStage — the link the surface is showing",
  { timeout: 60_000 },
  () => {
    /** The live hook, outside the stage — proof the fixed surface is diverging. */
    function LiveLink() {
      const link = useScanLink();
      return <span data-testid="live-link">{link}</span>;
    }

    const liveLink = () => screen.getByTestId("live-link").textContent;

    const holdLines = () =>
      logSpy.calls.filter((c) => c.kinds.includes("hold")).map((c) => c.texts.at(-1));

    it("does not append a link line to a scan that has ended", async () => {
      render(
        <>
          <LiveLink />
          <DescentOverlay unitId="N-07" />
        </>,
      );
      dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
      await waitFor(() => expect(overlay()).not.toBeNull());

      // The drop and the restore, both before the first walk line lands.
      dispatch(() => useFleetStore.setState({ connection: "reconnecting" }));
      await acrossFrames(() => expect(liveLink()).toBe("lost"));
      dispatch(() => useFleetStore.setState({ connection: "open" }));
      await acrossFrames(() => expect(liveLink()).toBe("resumed"));

      // Positive control: while the hold is *true* the log says so, at the tail.
      await acrossFrames(() =>
        expect(holdLines()).toContain("HOLD — LINK RESTORED · AWAITING SEQUENCE"),
      );

      // The sequence continues; the hold goes away on its own.
      dispatch(() => {
        const store = useIncidentStore.getState();
        for (const path of ["/sys/core/heartbeat.svc", "/firmware/gait/walk_cycle.ko"]) {
          store.applyDiagEvent(ev({ k: "walk", path }));
        }
        store.applyDiagEvent(
          ev({ k: "channel", joint: "knee_L", wave: [0, 1, 0, -1], ref: [0, 1, 0, -1] }),
        );
        store.applyDiagEvent(
          ev({ k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" }),
        );
        store.applyDiagEvent(ev({ k: "verdict", report: REPORT }));
      });
      await acrossFrames(() => expect(liveLink()).toBe("open"));

      // What the log had settled on when the scan concluded.
      const concluded = logSpy.calls.at(-1)!;
      expect(concluded.link).toBe("open");
      expect(concluded.kinds).not.toContain("hold");

      // RETURN. Everything from here is the finished scan leaving.
      logSpy.calls.length = 0;
      dispatch(() => useIncidentStore.getState().completeAscent());

      for (let frame = 0; frame < 240 && overlay() !== null; frame += 1) {
        await nextFrame();
      }
      expect(overlay()).toBeNull(); // the ascent actually finished

      // The hook is lying, exactly as described — this is not a vacuous test…
      expect(liveLink()).toBe("resumed");
      // …and the scan that is leaving never repeats it. With all three of the
      // projection's inputs held, the memo in ScanLog has nothing to invalidate
      // it and the log is not rebuilt at all — which is the point, and is why
      // this is stated as "never a held link" rather than as a call count.
      expect(holdLines()).toEqual([]);
      expect(logSpy.calls.filter((c) => c.link !== "open")).toEqual([]);
    });

    it("never prints HOLD in the header or the status rule on the way out", async () => {
      render(
        <>
          <LiveLink />
          <DescentOverlay unitId="N-07" />
        </>,
      );
      dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
      await waitFor(() => expect(overlay()).not.toBeNull());
      dispatch(() => useFleetStore.setState({ connection: "reconnecting" }));
      await acrossFrames(() => expect(liveLink()).toBe("lost"));
      dispatch(() => useFleetStore.setState({ connection: "open" }));
      await acrossFrames(() => expect(liveLink()).toBe("resumed"));
      dispatch(() => {
        const store = useIncidentStore.getState();
        store.applyDiagEvent(ev({ k: "walk", path: "/firmware/gait/walk_cycle.ko" }));
        store.applyDiagEvent(
          ev({ k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" }),
        );
        store.applyDiagEvent(ev({ k: "verdict", report: REPORT }));
      });
      await acrossFrames(() => expect(liveLink()).toBe("open"));

      dispatch(() => useIncidentStore.getState().completeAscent());

      const words = new Set<string>();
      for (let frame = 0; frame < 240 && overlay() !== null; frame += 1) {
        const text = (overlay()?.textContent ?? "").replace(/\s+/g, " ");
        words.add(/SCANNING|VERDICT|HOLD/.exec(text)?.[0] ?? "none");
        await nextFrame();
      }
      expect(overlay()).toBeNull();
      expect(liveLink()).toBe("resumed");
      expect([...words]).toEqual(["VERDICT"]);
    });
  },
);

/**
 * The ascent's ramp, measured rather than asserted from the source.
 *
 * The fix above adds two attributes to the layer and touches no variant, but
 * "the choreography is unchanged" is the one claim here that a reader
 * cannot check by eye — so it is fitted. Each sample pairs a wall-clock reading
 * with what framer had written on the element at that moment, and the fit
 * recovers the *duration constant* of the curve. That is the reading that
 * cannot be moved by scheduling: a starved frame loop takes fewer samples of
 * the same curve, never a different curve, because framer stamps its own
 * `performance.now()` on every frame it processes and nothing here seeds a
 * time from a commit.
 */
describe("DescentStage — the ascent's choreography", { timeout: 60_000 }, () => {
  /** Least squares through (x, y). */
  function fitLine(points: Array<[number, number]>): { slope: number; residual: number } {
    const n = points.length;
    const mx = points.reduce((a, [x]) => a + x, 0) / n;
    const my = points.reduce((a, [, y]) => a + y, 0) / n;
    const sxy = points.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
    const sxx = points.reduce((a, [x]) => a + (x - mx) ** 2, 0);
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    const residual = Math.max(
      ...points.map(([x, y]) => Math.abs(y - (slope * x + intercept))),
    );
    return { slope, residual };
  }

  /** cubic-bezier(x1,y1,x2,y2) evaluated at a time fraction, CSS semantics. */
  function bezierAt(
    [x1, y1, x2, y2]: readonly [number, number, number, number],
    x: number,
  ): number {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 60; i += 1) {
      const vx = ((ax * t + bx) * t + cx) * t;
      if (Math.abs(vx - x) < 1e-7) break;
      if (vx > x) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return ((ay * t + by) * t + cy) * t;
  }

  /** Invert the ease: what time fraction produces this much travel? */
  function bezierProgress(
    ease: readonly [number, number, number, number],
    y: number,
  ): number {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (bezierAt(ease, mid) > y) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  }

  /** Sample the leaving surface every frame from RETURN until it is gone. */
  async function sampleAscent(
    read: (el: HTMLElement) => number | null,
  ): Promise<Array<[number, number]>> {
    const t0 = performance.now();
    dispatch(() => useIncidentStore.getState().completeAscent());
    const samples: Array<[number, number]> = [];
    for (let frame = 0; frame < 240 && overlay() !== null; frame += 1) {
      const el = surfaceEl();
      const value = el ? read(el) : null;
      if (value !== null) samples.push([performance.now() - t0, value]);
      await nextFrame();
    }
    expect(overlay()).toBeNull();
    return samples;
  }

  it("fades on the reduced timeline's linear 200 ms ramp", async () => {
    preferReducedMotion();
    await toVerdict();
    await acrossFrames(() => expect(surfaceEl()?.style.opacity).toBe("1"));

    const samples = await sampleAscent((el) => {
      const o = Number(el.style.opacity);
      // Drop the clamped ends: framer holds 1 until its first frame, and the
      // last commit before unmount can read 0. The ramp is what is between.
      return Number.isFinite(o) && o > 0 && o < 1 ? o : null;
    });

    expect(samples.length).toBeGreaterThanOrEqual(3);
    // Monotone, and it really does get most of the way down.
    const values = samples.map(([, o]) => o);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(values.at(-1)!).toBeLessThan(0.15);

    // opacity = 1 - t / D → the fitted slope is -1/D.
    const { slope, residual } = fitLine(samples);
    const duration = -1 / slope;
    const declared = descentTimeline(true).ascentWipeMs;
    expect(declared).toBe(200);
    expect(Math.abs(duration - declared)).toBeLessThanOrEqual(15);
    expect(residual).toBeLessThanOrEqual(0.03);
  });

  it("wipes back down on the full timeline's 250 ms EASE_WIPE", async () => {
    await toVerdict();
    await acrossFrames(() => expect(surfaceEl()?.style.transform).toBe("none"));

    const samples = await sampleAscent((el) => {
      const y = /translateY\(([\d.]+)%\)/.exec(el.style.transform)?.[1];
      if (y === undefined) return null;
      const travel = Number(y) / 100;
      return travel > 0 && travel < 1 ? travel : null;
    });

    expect(samples.length).toBeGreaterThanOrEqual(3);
    const values = samples.map(([, y]) => y);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values.at(-1)!).toBeGreaterThan(0.9);

    // Invert the ease and the curve becomes a line whose slope is the
    // duration — so the ease and the length are both under assertion.
    const progress = samples.map(
      ([t, y]) => [bezierProgress(EASE_WIPE, y), t] as [number, number],
    );
    const { slope, residual } = fitLine(progress);
    const declared = descentTimeline(false).ascentWipeMs;
    expect(declared).toBe(250);
    expect(Math.abs(slope - declared)).toBeLessThanOrEqual(20);
    expect(residual).toBeLessThanOrEqual(12);
  });
});

/**
 * the three audits the departing snapshot has to survive.
 *
 * and latched "the surface outlives the session by one exit"
 * three times over: a ref in the stage, a context under it, and the gate's
 * mount flag. It is one fact, so it is now one field on the store
 * (`exiting`) — which buys the link fix at the root (the describe above) and
 * costs three things a ref never had to answer for.
 */
describe("DescentStage — the departing snapshot", { timeout: 60_000 }, () => {
  const store = () => useIncidentStore.getState();

  function seedUnit() {
    act(() => {
      useFleetStore.getState().applySnapshot({
        t: "fleet_snapshot",
        units: [
          {
            id: "N-07",
            name: "Sagebrush House",
            status: "red",
            battery: 84,
            pos: { lat: 44.06, lng: -121.28 },
          },
        ],
      });
    });
  }

  /**
   * Audit 2 — the blast radius, and the reason `exiting` is additive rather
   * than a fourth phase.
   *
   * Machine space reads through the snapshot; the page underneath must not.
   * For the 250 ms of the ascent that page is coming back into view over a
   * console with no diagnostic running and an incident already on file, and a
   * banner reading the snapshot would spend all of it saying "Diagnostic in
   * progress" — the same lie as before with the two surfaces swapped, and the
   * one the operator is actually looking at by the end of it.
   */
  it("never lets the page under the surface claim a diagnostic is running", async () => {
    seedUnit();
    const { container } = render(
      <>
        <IncidentBanner unitId="N-07" />
        <RunDiagnosticButton unitId="N-07" />
        <DescentOverlay unitId="N-07" />
      </>,
    );
    const banner = () =>
      container.querySelector<HTMLElement>('[data-slot="incident-banner"]');
    const bannerText = () => (banner()?.textContent ?? "").replace(/\s+/g, " ");
    const runControls = () => screen.queryAllByRole("button", { name: /Run diagnostic/ });

    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    await waitFor(() => expect(overlay()).not.toBeNull());

    // Positive control: while the scan is live the page underneath says so, and
    // every run control on it is blocked. Without this the assertions after the
    // ascent could pass on a banner that never says anything.
    expect(banner()).toHaveAttribute("data-phase", "running");
    expect(bannerText()).toContain(RUN_BLOCKED_REASON);
    expect(runControls().every((b) => b.hasAttribute("disabled"))).toBe(true);

    dispatch(() =>
      useIncidentStore.getState().applyDiagEvent(ev({ k: "verdict", report: REPORT })),
    );
    await screen.findByRole("button", { name: EXECUTED_RECOMMENDATION });
    expect(banner()).toHaveAttribute("data-phase", "complete");
    // Let the wipe land, or "away" starts from where it ends and the exit this
    // test is sampling is over in one frame.
    await acrossFrames(() => expect(surfaceEl()?.style.transform).toBe("none"));

    dispatch(() => useIncidentStore.getState().completeAscent());
    // The snapshot is standing — this is not a vacuous test.
    expect(store().exiting).not.toBeNull();

    const phases = new Set<string>();
    const claims: string[] = [];
    const blocked: boolean[] = [];
    for (let frame = 0; frame < 240 && overlay() !== null; frame += 1) {
      phases.add(banner()?.getAttribute("data-phase") ?? "absent");
      if (bannerText().includes(RUN_BLOCKED_REASON)) claims.push(bannerText());
      blocked.push(runControls().some((b) => b.hasAttribute("disabled")));
      await nextFrame();
    }
    expect(overlay()).toBeNull();

    // The ascent hands back a page holding a finished incident, from its first
    // frame: never "running", never the blocked reason, never a dead control.
    expect([...phases]).toEqual(["resolved"]);
    expect(claims).toEqual([]);
    expect(blocked).not.toContain(true);
    expect(blocked.length).toBeGreaterThan(2);
  });

  /**
   * Audit 3 — the failure mode a ref could not have.
   *
   * A ref died with its component; a store field does not. The operator who
   * navigates during the ascent takes the whole subtree down before the "away"
   * animation can report, so the callback that clears the snapshot never runs
   * and `exiting` would stand forever — and every machine-space read is a read
   * of a scan that left the building.
   */
  it("collects the snapshot when the stage is torn down mid-exit", async () => {
    const view = render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    await waitFor(() => expect(overlay()).not.toBeNull());
    dispatch(() =>
      useIncidentStore.getState().applyDiagEvent(ev({ k: "verdict", report: REPORT })),
    );
    await screen.findByRole("button", { name: EXECUTED_RECOMMENDATION });

    dispatch(() => useIncidentStore.getState().completeAscent());
    expect(store().exiting).not.toBeNull();
    expect(overlay()).not.toBeNull();

    // The operator navigates away. Nothing finishes; the surface is simply gone.
    act(() => view.unmount());

    expect(store().exiting).toBeNull();
    expect(selectShownSession(useIncidentStore.getState())).toBeNull();

    // …and coming back to the unit page does not put the departed scan back on
    // screen, which is what a stranded snapshot driving the mount would do.
    render(<DescentOverlay unitId="N-07" />);
    await nextFrame();
    await nextFrame();
    expect(overlay()).toBeNull();
  });

  /**
   * Audit 1 — mid-scan CLOSE is not a departure.
   *
   * The session stays alive in the store and keeps accumulating, so the surface
   * on its way out renders it *live*. A walk line that lands during those
   * 250 ms is a real line of a real scan and printing it is honest; freezing
   * the panel would be the lie in the other direction.
   */
  it("renders a live session through a leave, and snapshots nothing", async () => {
    render(<DescentOverlay unitId="N-07" />);
    dispatch(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" })));
    await waitFor(() => expect(overlay()).not.toBeNull());
    dispatch(() =>
      useIncidentStore.getState().applyDiagEvent(ev({ k: "walk", path: "/sys/core/a" })),
    );
    await acrossFrames(() => expect(overlay()?.textContent).toContain("1 NODES"));

    dispatch(() => useIncidentStore.getState().leaveSession());
    expect(store().exiting).toBeNull();
    expect(store().phase).toBe("scanning");
    expect(overlay()).not.toBeNull();

    // Mid-exit, the scan carries on — and the departing surface says so.
    dispatch(() =>
      useIncidentStore.getState().applyDiagEvent(ev({ k: "walk", path: "/sys/core/b" })),
    );
    expect(overlay()?.textContent).toContain("2 NODES");
    expect(logSpy.calls.at(-1)!.texts.join(" ")).toContain("/sys/core/b");

    // The exit still completes, and the session is still there to go back to.
    for (let frame = 0; frame < 240 && overlay() !== null; frame += 1) await nextFrame();
    expect(overlay()).toBeNull();
    expect(store().phase).toBe("scanning");
    expect(store().session?.walkLines).toHaveLength(2);
  });
});
