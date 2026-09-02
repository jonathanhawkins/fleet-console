import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AlertSeverity, type DiagEventMessage, type UnitStatus } from "@/lib/schema";
import { useAuditStore, useFleetStore, useIncidentStore } from "@/lib/stores";
import { clockTime } from "./alert-lifecycle";
import {
  getUnitStatusHistory,
  resetStatusHistory,
  startStatusRecorder,
} from "./status-history";
import { StatusTimeline } from "./status-timeline";

/**
 * The console's own memory.
 *
 * Nothing on the wire carries "how long has this been true", so the recorder
 * derives it from the only thing that does change — the store — and the
 * timeline renders it. What has to hold: transitions become contiguous spans
 * with no gaps and no duplicates, replayed alerts after a reconnect do not
 * become a second tick, and the strip never claims to know about anything that
 * happened before the console was open.
 */

const T0 = new Date("2026-08-21T12:00:00.000Z").getTime();

let stop: () => void = () => {};

function snapshot(status: UnitStatus) {
  act(() => {
    useFleetStore.getState().applySnapshot({
      t: "fleet_snapshot",
      units: [
        {
          id: "N-07",
          name: "Sagebrush House",
          status,
          battery: 84,
          pos: { lat: 44.06, lng: -121.28 },
        },
      ],
    });
  });
}

function raise(severity: AlertSeverity, id: string, ts = Date.now()) {
  act(() => {
    useFleetStore.getState().applyAlert({
      t: "alert",
      alert: { id, unitId: "N-07", severity, message: `${severity} on N-07`, ts },
    });
  });
}

/** Move the wall clock and let the shared one-second ticker catch up. */
function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function scanStartEvent(): DiagEventMessage {
  return { t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } };
}

/** The scan's conclusion, as the sim sends it. */
function verdictEvent(): DiagEventMessage {
  return {
    t: "diag_event",
    unitId: "N-07",
    ev: {
      k: "verdict",
      report: {
        unitId: "N-07",
        joint: "knee_L",
        component: "actuator_A07",
        anomaly: "gain",
        summary: "Left knee actuator A-07 gain anomaly.",
        recommendations: ["Schedule service"],
        ts: Date.now(),
      },
    },
  };
}

/**
 * The label packer needs pixels, so the timeline measures its own track. jsdom
 * has no layout engine; this is the width it is told it has, and one test
 * shrinks it to prove what happens when the words stop fitting.
 */
let trackWidth = 600;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  useFleetStore.getState().reset();
  useIncidentStore.getState().reset();
  useAuditStore.getState().reset();
  resetStatusHistory();
  trackWidth = 600;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb(
          [{ contentRect: { width: trackWidth, height: 8 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  stop = startStatusRecorder();
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the status recorder", () => {
  it("opens a span the first time it hears from a unit", () => {
    snapshot("nominal");
    const history = getUnitStatusHistory("N-07");
    expect(history?.startedAt).toBe(T0);
    expect(history?.spans).toEqual([{ status: "nominal", from: T0, to: null }]);
  });

  it("closes the open span and opens the next one on a transition", () => {
    snapshot("nominal");
    tick(30_000);
    raise("amber", "al-001");
    tick(30_000);
    raise("red", "al-002");

    expect(getUnitStatusHistory("N-07")?.spans).toEqual([
      { status: "nominal", from: T0, to: T0 + 30_000 },
      { status: "amber", from: T0 + 30_000, to: T0 + 60_000 },
      { status: "red", from: T0 + 60_000, to: null },
    ]);
  });

  it("does not split a span when telemetry arrives without a change", () => {
    snapshot("nominal");
    act(() => {
      for (let i = 0; i < 20; i += 1) {
        useFleetStore.getState().applyTelemetry({
          t: "telemetry",
          unitId: "N-07",
          ts: Date.now(),
          batch: [
            { joint: "knee_L", tempC: 33, torqueNm: 12, currentA: 1.5, battery: 80 },
          ],
        });
      }
    });
    expect(getUnitStatusHistory("N-07")?.spans).toHaveLength(1);
  });

  /**
   * The connect burst.
   *
   * A client joining mid-incident gets a snapshot and then the run's active
   * alerts replayed in the same breath, so the summary walks
   * nominal → amber → red in about forty milliseconds. Those are not
   * transitions this console watched, and recording them as spans left two
   * invisible slivers at the left edge of the band and — once the timeline grew
   * ticks — stacked "Attention" and "Alert" on top of each other at t=0,
   * claiming the operator had been there to see it.
   */
  it("treats a status change inside the first second as catching up, not as a transition", () => {
    snapshot("nominal");
    act(() => {
      vi.advanceTimersByTime(20);
    });
    raise("amber", "al-001");
    act(() => {
      vi.advanceTimersByTime(20);
    });
    raise("red", "al-002");

    expect(getUnitStatusHistory("N-07")?.spans).toEqual([
      { status: "red", from: T0, to: null },
    ]);
  });

  it("still records a transition that happens after the console has settled", () => {
    snapshot("nominal");
    tick(1_500);
    raise("amber", "al-001");

    expect(getUnitStatusHistory("N-07")?.spans).toEqual([
      { status: "nominal", from: T0, to: T0 + 1_500 },
      { status: "amber", from: T0 + 1_500, to: null },
    ]);
  });

  it("journals each alert once, however many times the server replays it", () => {
    snapshot("nominal");
    tick(10_000);
    raise("amber", "al-001");
    raise("amber", "al-001"); // the store dedupes; the journal must agree
    tick(5_000);
    raise("red", "al-002");

    expect(getUnitStatusHistory("N-07")?.marks.map((m) => m.id)).toEqual([
      "al-001",
      "al-002",
    ]);
  });
});

describe("the beat recorder", () => {
  /**
   * What the recorder is *not* for any more.
   *
   * Diagnostics and verdicts belong to the audit slice, which is
   * the single source for what an operator or a machine did and which the
   * timeline reads directly. Journalling them here as well would put two ticks
   * on one moment; this asserts the recorder stays out of it.
   */
  it("leaves the diagnostic and its verdict to the audit log", () => {
    snapshot("amber");
    tick(10_000);
    act(() => {
      useIncidentStore.getState().beginDescent("N-07");
      useIncidentStore.getState().applyDiagEvent(scanStartEvent());
    });
    tick(5_000);
    act(() => {
      useIncidentStore.getState().applyDiagEvent(verdictEvent());
    });

    expect(getUnitStatusHistory("N-07")?.beats).toEqual([]);
    expect(useAuditStore.getState().entries.map((e) => e.kind)).toEqual([
      "diag-verdict",
      "diag-start",
    ]);
  });

  /**
   * A dropped link is a hole in this unit's telemetry, which is exactly the
   * kind of thing an operator reading a strange trace needs to be told about —
   * so it is journalled against every unit rather than kept as one fleet-wide
   * fact the unit page would have to go looking for. The opening
   * connecting → open is not a beat: that is the session starting, and the
   * timeline's left edge already says so.
   */
  it("marks a link that dropped and came back, and not the first connect", () => {
    snapshot("nominal");
    act(() => useFleetStore.getState().setConnection("open"));
    expect(getUnitStatusHistory("N-07")?.beats ?? []).toHaveLength(0);

    tick(5_000);
    act(() => useFleetStore.getState().setConnection("reconnecting"));
    tick(3_000);
    act(() => useFleetStore.getState().setConnection("open"));

    expect(getUnitStatusHistory("N-07")?.beats.map((b) => b.kind)).toEqual([
      "link-lost",
      "link-restored",
    ]);
  });
});

describe("StatusTimeline", () => {
  const ticks = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-slot='timeline-tick']")].map((el) =>
      el.getAttribute("data-kind"),
    );
  /**
   * A label is two lines now: the beat over the clock it happened at.
   * These read the halves separately — a helper that returned "Verdict19:41:40"
   * would make every assertion below about layout rather than about content.
   */
  const labels = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-slot='timeline-label']")].map(
      (el) => el.firstElementChild?.textContent,
    );
  const labelClocks = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-slot='timeline-label']")].map(
      (el) => el.lastElementChild?.textContent,
    );
  const measures = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-slot='timeline-measure']")].map((el) => ({
      id: el.getAttribute("data-measure"),
      label: el.textContent,
      left: (el as HTMLElement).style.left,
      width: (el as HTMLElement).style.width,
    }));

  it("says what the region is for before the unit has reported in", () => {
    render(<StatusTimeline unitId="N-07" />);
    expect(
      screen.getByText("The session timeline starts as soon as the unit reports in."),
    ).toBeVisible();
  });

  /**
   * The regression this component was actually shipped with for an afternoon.
   *
   * A unit page mounts before the fleet has reported, so the timeline's first
   * render is the waiting state — which returns before the track element
   * exists. Measuring the track from a mount effect therefore measured
   * nothing, never ran again, and left the packer clamping every label to x=0
   * on a zero-width track: five ticks, one word. The measurement has to be
   * attached to the element's arrival, not to the component's.
   */
  it("measures its track when the track arrives, not when the component does", () => {
    const { container } = render(<StatusTimeline unitId="N-07" />);
    expect(container.querySelector("[data-pending]")).toBeInTheDocument();

    snapshot("nominal");
    tick(30_000);
    raise("amber", "al-001");
    tick(30_000);

    expect(container.querySelector("[data-pending]")).not.toBeInTheDocument();
    expect(labels(container)).toEqual(["Session start", "Attention"]);
    // …and the second label is where the packer put it, not clamped to zero
    expect(
      Number.parseFloat(
        (container.querySelectorAll("[data-slot='timeline-label']")[1] as HTMLElement)
          .style.left,
      ),
    ).toBeGreaterThan(100);
  });

  /**
   * The CLS fix this card was rebuilt around, extended to the labels.
   *
   * A unit page prerenders as the waiting state and swaps on the first
   * snapshot. When that swap changed this card's height it pushed the footer —
   * the one settled element in the initial viewport — and Lighthouse recorded
   * 0.06. The settled strip always carries at least one row of labels under the
   * band, so the waiting one has to stand at the same height.
   */
  it("stands at its settled height before the unit has reported in", () => {
    const { container, rerender } = render(<StatusTimeline unitId="N-07" />);
    const reserved = (container.querySelector("[data-pending] > div") as HTMLElement)
      .style.marginBottom;

    snapshot("nominal");
    tick(5_000);
    rerender(<StatusTimeline unitId="N-07" />);

    const settled = (
      container.querySelector("[data-slot='status-timeline'] > div") as HTMLElement
    ).style.paddingBottom;
    expect(reserved).toBe(settled);
    expect(Number.parseFloat(reserved)).toBeGreaterThan(0);
  });

  it("draws one segment per span, and a labelled tick per moment", () => {
    snapshot("nominal");
    tick(30_000);
    raise("amber", "al-001");
    tick(30_000);

    const { container } = render(<StatusTimeline unitId="N-07" />);
    const segments = container.querySelectorAll("[data-status]");
    expect([...segments].map((s) => s.getAttribute("data-status"))).toEqual([
      "nominal",
      "warn",
    ]);

    // half the session nominal, half amber
    expect((segments[0] as HTMLElement).style.left).toBe("0%");
    expect((segments[0] as HTMLElement).style.width).toBe("50%");
    expect((segments[1] as HTMLElement).style.left).toBe("50%");

    // …and the band is no longer the whole story: the moment it turned has a
    // tick on it and a word under it.
    expect(ticks(container)).toEqual(["start", "amber"]);
    expect(labels(container)).toEqual(["Session start", "Attention"]);
    expect(
      (
        container.querySelector(
          "[data-slot='timeline-tick'][data-kind='amber']",
        ) as HTMLElement
      ).style.left,
    ).toBe("50%");

    expect(screen.getByText("Session started 1m ago")).toBeVisible();
  });

  it("ticks the diagnostic and the verdict alongside the status changes", () => {
    snapshot("nominal");
    tick(20_000);
    raise("red", "al-001");
    tick(10_000);
    act(() => {
      useIncidentStore.getState().beginDescent("N-07");
      useIncidentStore.getState().applyDiagEvent(scanStartEvent());
    });
    tick(10_000);
    act(() => {
      useIncidentStore.getState().applyDiagEvent(verdictEvent());
    });
    tick(10_000);

    const { container } = render(<StatusTimeline unitId="N-07" />);
    expect(ticks(container)).toEqual(["start", "red", "diagnostic", "verdict"]);
    expect(labels(container)).toEqual([
      "Session start",
      "Alert",
      "Diagnostic",
      "Verdict",
    ]);
  });

  /**
   * The strip could always say *that* a beat happened and never at what
   * time — an operator writing up a call had seven marks and no clock anywhere
   * on the card.
   */
  it("stamps every labelled beat with the wall clock it happened at", () => {
    snapshot("nominal");
    tick(30_000);
    raise("amber", "al-001");
    tick(30_000);

    const { container } = render(<StatusTimeline unitId="N-07" />);
    expect(labels(container)).toEqual(["Session start", "Attention"]);
    expect(labelClocks(container)).toEqual([clockTime(T0), clockTime(T0 + 30_000)]);
  });

  /**
   * The bug this lane exists for: the ninety-three minutes between an alert
   * being raised and anyone running a diagnostic was a gap the eye read as "a
   * while". The bracket makes it a number, between the two marks it measures.
   */
  it("brackets the wait between the alert and the diagnostic", () => {
    snapshot("nominal");
    tick(20_000);
    raise("amber", "al-001");
    tick(300_000);
    act(() => {
      useIncidentStore.getState().beginDescent("N-07");
      useIncidentStore.getState().applyDiagEvent(scanStartEvent());
    });
    tick(15_000);

    const { container } = render(<StatusTimeline unitId="N-07" />);
    const [measure, ...rest] = measures(container);
    expect(rest).toEqual([]);
    expect(measure?.id).toBe("response");
    expect(measure?.label).toBe("5m");
    // It starts on the mark it names and ends on the other one: 20s into a
    // 335s session, running for 300s of it.
    expect(Number.parseFloat(measure?.left ?? "")).toBeCloseTo(5.97, 1);
    expect(Number.parseFloat(measure?.width ?? "")).toBeCloseTo(89.55, 1);
    expect(container.querySelector("p.sr-only")).toHaveTextContent(
      "Measured: 5m from the alert to the diagnostic.",
    );
  });

  it("says nothing about a span the two ticks had already said", () => {
    snapshot("nominal");
    tick(20_000);
    raise("amber", "al-001");
    tick(30_000); // half a minute: the marks are their own answer
    act(() => {
      useIncidentStore.getState().beginDescent("N-07");
      useIncidentStore.getState().applyDiagEvent(scanStartEvent());
    });
    tick(10_000);

    const { container } = render(<StatusTimeline unitId="N-07" />);
    expect(measures(container)).toEqual([]);
    expect(container.querySelector("p.sr-only")).not.toHaveTextContent("Measured");
  });

  /**
   * A bracket narrower than its own word would overhang both end caps and claim
   * time belonging to its neighbours, so it is dropped rather than clipped —
   * the same rule the labels follow when the track runs out.
   */
  it("drops a bracket the track is too narrow to draw honestly", () => {
    trackWidth = 60;
    snapshot("nominal");
    tick(600_000);
    raise("amber", "al-001");
    tick(90_000);
    act(() => {
      useIncidentStore.getState().beginDescent("N-07");
      useIncidentStore.getState().applyDiagEvent(scanStartEvent());
    });
    tick(10_000);

    const { container } = render(<StatusTimeline unitId="N-07" />);
    expect(measures(container)).toEqual([]);
  });

  it("describes itself for a reader who cannot see the band", () => {
    snapshot("nominal");
    tick(30_000);
    raise("red", "al-001");
    tick(30_000);

    const { container } = render(<StatusTimeline unitId="N-07" />);
    expect(container.querySelector("p.sr-only")).toHaveTextContent(
      "Nominal for 30 seconds, then alert for 30 seconds. 1 alert raised. " +
        `Session events: Session start at ${clockTime(T0)}, +0:00, ` +
        `Alert at ${clockTime(T0 + 30_000)}, +0:30.`,
    );
  });

  /**
   * A label that cannot fit loses its word, never its tick: the moment happened
   * and the timeline still says so, and the spoken description above carries
   * every one of them in order regardless of what fitted.
   */
  it("keeps the tick when there is no room for the word", () => {
    trackWidth = 40; // a track narrower than a single label
    snapshot("nominal");
    tick(2_000);
    raise("amber", "al-001");
    tick(2_000);
    raise("red", "al-002");
    tick(2_000);

    const { container } = render(<StatusTimeline unitId="N-07" />);
    expect(ticks(container)).toHaveLength(3);
    expect(labels(container).length).toBeLessThan(3);
    expect(container.querySelector("p.sr-only")).toHaveTextContent(
      /Attention at .+\+0:02/,
    );
  });

  it("drops alerts the session did not witness rather than pinning them to t=0", () => {
    // the sim replays a still-active alert from before this console connected
    snapshot("red");
    raise("red", "al-old", T0 - 120_000);
    tick(20_000);

    const { container } = render(<StatusTimeline unitId="N-07" />);
    expect(getUnitStatusHistory("N-07")?.marks).toHaveLength(1);
    // one segment, and only the session's own opening tick: the band already
    // says it arrived in trouble, and a tick at t=0 would claim this console
    // watched it happen.
    expect(container.querySelectorAll("[data-status]")).toHaveLength(1);
    expect(ticks(container)).toEqual(["start"]);
    expect(screen.getByText(/No alerts raised\./)).toBeInTheDocument();
  });
});
