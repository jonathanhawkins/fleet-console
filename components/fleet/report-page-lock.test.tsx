import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type VerdictReport } from "@/lib/schema";
import { useAuditStore, useFleetStore, useIncidentStore } from "@/lib/stores";
import { DESCENT_ATTR, REPORT_ATTR, usePageLock } from "@/components/console";
import { DescentOverlay } from "./descent-overlay";
import {
  closeIncidentReport,
  openIncidentReport,
  resetIncidentReport,
} from "./incident-report";
import { IncidentReport } from "./incident-report-overlay";

/**
 * Three surfaces cover the operator page and two of them are mounted on
 * the same route for the whole session — `app/unit/[id]/unit-detail.tsx` renders
 * the descent's gate and the incident report's, one after the other.
 *
 * That is not a hypothetical overlap. A `scan_start` arriving on the wire is
 * adopted with no operator action (a reconnect replay, a second console driving
 * the same unit), so the descent can come up over a report that is already open.
 * With a lock per surface, the second one measures a scrollbar gutter of zero —
 * the scrollbar is already hidden — and whichever leaves first hands the page
 * back under the other: scroll restored beneath a surface still covering it, and
 * a padding written back that the writer never set.
 *
 * The attribute has the sharper failure of the two. `data-report="open"` arms
 * the print block in globals.css, which hides every body child that is not the
 * report — so a leak there does not degrade printing, it prints the app blank.
 */

/**
 * Both documents behind these gates are `next/dynamic` chunks, and on a cold
 * module graph the first open is a Vite transform of a whole tree rather than an
 * import. Paying for both here keeps that cost off the clock of any assertion
 * below — the same warm-up, for the same reason, as descent-overlay.test.tsx
 * and incident-report-overlay.test.tsx.
 */
beforeAll(async () => {
  await import("./incident-report-surface");
  await import("@/components/machine/descent-stage");
}, 60_000);

const VERDICT_TS = 1_700_000_000_000;

const report: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE",
  recommendations: ["Dispatch service"],
  ts: VERDICT_TS,
};

const INCIDENT_ID = `inc-N-07-${VERDICT_TS}`;

/** A scan that ran to its verdict and was logged: the report has a subject. */
function runDiagnostic(): void {
  act(() => {
    const store = useIncidentStore.getState();
    store.beginDescent("N-07");
    store.applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    store.applyDiagEvent({
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "channel", joint: "knee_L", wave: [0.2, 0.4], ref: [0.1, 0.2] },
    });
    store.applyDiagEvent({
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "verdict", report },
    });
    store.completeAscent();
  });
}

/**
 * A scan the console did not start, arriving on the wire and being adopted —
 * then opened in machine space, because these tests are about two *surfaces*
 * contending for the page lock and an adopted scan alone now stays calm.
 */
function scanStarts(): void {
  act(() => {
    useIncidentStore
      .getState()
      .applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    useIncidentStore.getState().watchSession();
  });
}

/**
 * The two gates the unit page mounts, in the order it mounts them.
 *
 * `descent` stands in for the surface going away on its own — the stage's exit
 * tween calling `onDismissed`, which returns the overlay to rendering nothing
 * and drops its lock while this route, and the report over it, stay exactly
 * where they are. Driven here by the prop rather than by the wipe, because what
 * is under test is the release, not the animation that schedules it.
 */
function UnitPageGates({ descent = true }: { descent?: boolean }) {
  return (
    <>
      {descent ? <DescentOverlay unitId="N-07" /> : null}
      <IncidentReport unitId="N-07" />
    </>
  );
}

const root = () => document.documentElement;

beforeEach(() => {
  useFleetStore.getState().reset();
  useIncidentStore.getState().reset();
  useAuditStore.getState().reset();
  resetIncidentReport();
  root().removeAttribute(REPORT_ATTR);
  root().removeAttribute(DESCENT_ATTR);
  root().style.overflow = "";

  /**
   * jsdom lays nothing out, so the gutter both locks compute is zero and the
   * padding half of the bargain never happens. Fifteen pixels of scrollbar is
   * what a desktop browser actually leaves, and it is the difference that makes
   * "which lock's `previousPadding` was written back" observable at all.
   */
  Object.defineProperty(root(), "clientWidth", {
    configurable: true,
    value: window.innerWidth - 15,
  });

  // The descent's stage is the machine tree: canvas-backed, and jsdom has
  // neither a ResizeObserver nor a 2d backend (descent-overlay.test.tsx).
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

describe("two surfaces over one page", () => {
  it("does not give the page back while the other one is still holding it", async () => {
    // A page that was not padded to begin with: whatever is written back at the
    // end has to be this, not whichever value the second lock happened to read.
    document.body.style.paddingRight = "7px";
    const view = render(<UnitPageGates />);
    runDiagnostic();

    act(() => openIncidentReport(INCIDENT_ID));
    await screen.findByRole("heading", { name: "Incident report" });
    expect(root()).toHaveAttribute(REPORT_ATTR, "open");
    expect(root().style.overflow).toBe("hidden");
    expect(document.body.style.paddingRight).toBe("15px");

    // The wire opens a scan over the open document — no operator action.
    scanStarts();
    await waitFor(() => expect(root().getAttribute(DESCENT_ATTR)).toBe("under"));
    // The second lock must not re-measure: the scrollbar is already gone.
    expect(document.body.style.paddingRight).toBe("15px");

    act(() => closeIncidentReport());
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Incident report" })).toBeNull(),
    );
    // The document's own mark goes with it — a stale one prints the app blank.
    expect(root()).not.toHaveAttribute(REPORT_ATTR);
    // Everything else stays: the descent is still up over the same page.
    expect(root().style.overflow).toBe("hidden");
    expect(document.body.style.paddingRight).toBe("15px");

    // And the last one out gives back what the page actually had.
    view.unmount();
    expect(root().style.overflow).toBe("");
    expect(document.body.style.paddingRight).toBe("7px");
    document.body.style.paddingRight = "";
  });

  it("keeps the page locked when the descent leaves first instead", async () => {
    const view = render(<UnitPageGates />);
    runDiagnostic();
    scanStarts();
    await waitFor(() => expect(root().getAttribute(DESCENT_ATTR)).toBe("under"));

    act(() => openIncidentReport(INCIDENT_ID));
    await screen.findByRole("heading", { name: "Incident report" });

    // The descent finishes its exit and lets the page go, with the document
    // still open over it.
    view.rerender(<UnitPageGates descent={false} />);
    expect(root().hasAttribute(DESCENT_ATTR)).toBe(false);

    // The report is still over the page, so the page is still held for it.
    expect(root()).toHaveAttribute(REPORT_ATTR, "open");
    expect(root().style.overflow).toBe("hidden");

    view.unmount();
    expect(root().style.overflow).toBe("");
  });
});

describe("the count itself", () => {
  function Locks({ a, b }: { a: boolean; b: boolean }) {
    usePageLock(a, REPORT_ATTR);
    usePageLock(b);
    return null;
  }

  it("marks the root for the first holder and unmarks it for the last", () => {
    const view = render(<Locks a b />);
    expect(root()).toHaveAttribute(REPORT_ATTR, "open");

    view.rerender(<Locks a={false} b />);
    expect(root()).not.toHaveAttribute(REPORT_ATTR);
    expect(root().style.overflow).toBe("hidden");

    view.rerender(<Locks a={false} b={false} />);
    expect(root().style.overflow).toBe("");
  });

  it("snapshots the page once, however many surfaces cover it", () => {
    document.body.style.paddingRight = "3px";
    const view = render(<Locks a b={false} />);
    expect(document.body.style.paddingRight).toBe("15px");

    view.rerender(<Locks a b />);
    view.rerender(<Locks a={false} b />);
    view.rerender(<Locks a={false} b={false} />);
    expect(document.body.style.paddingRight).toBe("3px");
    document.body.style.paddingRight = "";
  });
});
