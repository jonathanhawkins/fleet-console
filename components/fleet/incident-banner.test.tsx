import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AlertSeverity,
  type OperatorCommand,
  type UnitStatus,
  type VerdictReport,
} from "@/lib/schema";
import {
  selectAlertMeta,
  useAuditStore,
  useFleetStore,
  useIncidentStore,
} from "@/lib/stores";
import { type TelemetryTransport } from "@/lib/transport";
import { IncidentBanner, incidentHeadline, verdictLine } from "./incident-banner";
import { setDiagnosticView } from "@/lib/prefs/diagnostic-view";
import { setCommandTransport } from "./telemetry-command";

/**
 * The banner is the whole product in one component: it is the only thing in
 * operator space allowed to raise its voice, and it holds the only primary
 * action there is. Three things have to hold.
 *
 * It must be silent when nothing is wrong — a standing banner is chrome, and
 * chrome that is always there is chrome nobody reads.
 *
 * The pill must do *both* halves of the pair. Sending RUN_DIAGNOSTIC without
 * opening the session drops the operator into a scan the page never
 * acknowledged; opening the session without sending strands the UI in
 * "descending" waiting for events that were never asked for.
 *
 * And it must tell the truth about which state it is in, including the honest
 * The in-progress state the descent replaces.
 */

const sent: OperatorCommand[] = [];

const transport: TelemetryTransport = {
  connect: () => {},
  send: (cmd) => sent.push(cmd),
  disconnect: () => {},
};

function seed(status: UnitStatus) {
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

function raise(severity: AlertSeverity, message: string, id = `al-${severity}`) {
  act(() => {
    useFleetStore.getState().applyAlert({
      t: "alert",
      alert: { id, unitId: "N-07", severity, message, ts: Date.now() },
    });
  });
}

const REPORT: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "Left knee actuator A-07 is over-driving its gain table.",
  recommendations: ["Schedule service"],
  ts: Date.now(),
};

beforeEach(() => {
  useFleetStore.getState().reset();
  useIncidentStore.getState().reset();
  // The fleet and incident reducers both append to the audit log, which dedupes
  // by (kind, ref) — a log carried over from the previous test would swallow
  // this one's entries (lib/stores/README.md).
  useAuditStore.getState().reset();
  sent.length = 0;
  setCommandTransport(transport);
});

afterEach(() => {
  setCommandTransport(null);
  // The view preference is real localStorage and outlives a test otherwise.
  setDiagnosticView("calm");
});

describe("incidentHeadline", () => {
  it("drops the house prefix the feed needs and the unit page does not", () => {
    expect(
      incidentHeadline(
        "Sagebrush House: left knee actuator running hot",
        "Sagebrush House",
      ),
    ).toBe("Left knee actuator running hot");
  });

  it("leaves an unprefixed message alone apart from its capital", () => {
    expect(incidentHeadline("left knee actuator running hot", "Cedar Row")).toBe(
      "Left knee actuator running hot",
    );
  });
});

describe("verdictLine", () => {
  it("restates the report's fields in operator voice", () => {
    expect(verdictLine(REPORT)).toBe("Left knee actuator A-07: gain anomaly.");
  });
});

describe("IncidentBanner", () => {
  it("says nothing at all about a healthy unit", () => {
    seed("nominal");
    const { container } = render(<IncidentBanner unitId="N-07" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("states the incident in plain words and offers one action on the robot", () => {
    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot");
    render(<IncidentBanner unitId="N-07" />);

    expect(screen.getByText("Left knee actuator running hot")).toBeVisible();
    // The single dark pill is the diagnostic. Acknowledging stands beside it in
    // the quiet variant: ownership of the alert, not an action on the robot.
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Acknowledge alert on N-07",
      "Run diagnostic",
    ]);
    expect(screen.getByRole("button", { name: "Run diagnostic" })).toHaveAttribute(
      "data-variant",
      "primary",
    );
    expect(
      screen.getByRole("button", { name: "Acknowledge alert on N-07" }),
    ).toHaveAttribute("data-variant", "secondary");
  });

  it("sends RUN_DIAGNOSTIC and opens the session as one act", async () => {
    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot");
    render(<IncidentBanner unitId="N-07" />);

    await userEvent.click(screen.getByRole("button", { name: "Run diagnostic" }));

    expect(sent).toEqual([{ c: "RUN_DIAGNOSTIC", unitId: "N-07" }]);
    expect(useIncidentStore.getState().phase).toBe("descending");
    expect(useIncidentStore.getState().session?.unitId).toBe("N-07");
  });

  it("opens no session when there is no link to send on", async () => {
    setCommandTransport(null);
    seed("red");
    raise("red", "Sagebrush House: left knee actuator overheating");
    render(<IncidentBanner unitId="N-07" />);

    await userEvent.click(screen.getByRole("button", { name: "Run diagnostic" }));

    expect(sent).toEqual([]);
    // a session with no scan behind it would hang the banner in "in progress"
    expect(useIncidentStore.getState().phase).toBe("idle");
  });

  it("goes quiet while the scan runs and keeps the incident in view", async () => {
    seed("red");
    raise("red", "Sagebrush House: left knee actuator overheating");
    render(<IncidentBanner unitId="N-07" />);
    await userEvent.click(screen.getByRole("button", { name: "Run diagnostic" }));

    // `selector: "p"` pins this to the headline; the same sentence is also a
    // disabled run control's accessible description elsewhere on the page
    // (run-diagnostic.tsx).
    expect(screen.getByText("Diagnostic in progress", { selector: "p" })).toBeVisible();
    expect(screen.getByText("Left knee actuator overheating")).toBeVisible();
    // No action, and in the calm default no way *in* either: the scan is on
    // this page already, in the panel below. A "view" control here would offer
    // a second copy of what the operator is looking at.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    act(() => {
      useIncidentStore
        .getState()
        .applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    });
    expect(screen.getByText("Diagnostic in progress", { selector: "p" })).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("becomes the way back in when machine space is the chosen view", async () => {
    setDiagnosticView("machine");
    seed("red");
    raise("red", "Sagebrush House: left knee actuator overheating");
    render(<IncidentBanner unitId="N-07" />);
    await userEvent.click(screen.getByRole("button", { name: "Run diagnostic" }));

    // The press put the operator in machine space, so the descent is covering
    // this page and anything offered here is offered to nobody.
    expect(useIncidentStore.getState().watching).toBe(true);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    act(() => {
      useIncidentStore
        .getState()
        .applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    });

    // …and the moment they step back out of it, the banner is the way back in.
    act(() => useIncidentStore.getState().leaveSession());
    expect(screen.getByRole("button", { name: "View scan" })).toBeEnabled();
  });

  it("reports the verdict in one line and stops offering the action", async () => {
    seed("red");
    raise("red", "Sagebrush House: left knee actuator overheating");
    render(<IncidentBanner unitId="N-07" />);
    await userEvent.click(screen.getByRole("button", { name: "Run diagnostic" }));

    act(() => {
      const incident = useIncidentStore.getState();
      incident.applyDiagEvent({
        t: "diag_event",
        unitId: "N-07",
        ev: { k: "scan_start" },
      });
      incident.applyDiagEvent({
        t: "diag_event",
        unitId: "N-07",
        ev: { k: "verdict", report: REPORT },
      });
    });

    expect(screen.getByText("Diagnostic complete")).toBeVisible();
    // the report's fields in operator voice, not the machine's shouted summary
    expect(screen.getByText("Left knee actuator A-07: gain anomaly.")).toBeVisible();
    expect(screen.queryByText(REPORT.summary)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps its own sentence while another unit is scanned, and locks the action", () => {
    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot");
    act(() => useIncidentStore.getState().beginDescent("N-03"));
    render(<IncidentBanner unitId="N-07" />);

    // Another unit's scan does not rewrite this banner's sentence…
    expect(screen.getByText("Left knee actuator running hot")).toBeVisible();
    // …but the sim runs one scan at a time and drops a second RUN_DIAGNOSTIC,
    // so a live-looking pill here would send a command that changes nothing.
    const pill = screen.getByRole("button", { name: "Run diagnostic" });
    expect(pill).toBeDisabled();
    expect(pill).toHaveAccessibleDescription("Diagnostic in progress");
  });

  it("still shows the scan when a page is opened mid-descent on a healthy-looking unit", () => {
    seed("nominal");
    act(() => {
      useIncidentStore
        .getState()
        .applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    });
    render(<IncidentBanner unitId="N-07" />);

    expect(screen.getByText("Diagnostic in progress", { selector: "p" })).toBeVisible();
  });
});

/**
 * The arrival, and why it is a state machine worth testing.
 *
 * The banner turning up at t ≈ 28 s displaces everything under it. The beat
 * does not remove that — it is the point of the page — it makes it legible: a
 * spring opens the space instead of the page jumping into it. Two things can
 * break without anyone noticing. The first is the *start*: if the wrapper is
 * measured after the browser has already painted it at full height, the spring
 * plays after the jump it was meant to replace and the whole beat is worse
 * than nothing. The second is the *exit*: a banner that unmounts the instant
 * the store clears takes its own collapse with it, and the space it held
 * snaps shut — the same event, mirrored, unannounced.
 */
describe("IncidentBanner — the arrival opens the space", () => {
  const NATURAL_H = 160;

  let frames: FrameRequestCallback[] = [];

  /** The wrapper, or null when the banner is not on the page at all. */
  const reveal = () =>
    document.querySelector<HTMLElement>('[data-slot="incident-reveal"]');
  const body = () => document.querySelector<HTMLElement>("[data-banner-body]");

  function frame(now: number): void {
    const due = frames;
    frames = [];
    act(() => {
      for (const cb of due) cb(now);
    });
  }

  /**
   * Drive the spring's first frame and return its clock origin.
   *
   * The spring takes its clock from the frame loop, not from the commit that
   * started it: Chrome hands a rAF callback the frame's vsync time, which can
   * be a whole frame *ahead* of the `performance.now()` a layout effect reads,
   * so seeding the origin from the commit put the first sample past the second
   * and the box jumped forward and back before it travelled. The first frame
   * therefore only sets t = 0 — here as in the browser.
   */
  function origin(): number {
    const t = performance.now();
    frame(t);
    return t;
  }

  /** Run the spring to a settle, whatever it is doing. */
  function settle(): void {
    frame(origin() + 2_000);
  }

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    // jsdom has no layout, and a wrapper that measures 0 has nothing to open.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      height: NATURAL_H,
      width: 800,
      top: 0,
      left: 0,
      right: 800,
      bottom: NATURAL_H,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens from nothing rather than landing at full height", () => {
    seed("nominal");
    render(<IncidentBanner unitId="N-07" />);
    expect(reveal()).toBeNull();

    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot");

    // The frame the banner arrives on: the page below it has not moved yet.
    expect(reveal()).toHaveStyle({ height: "0px", overflow: "hidden" });
    expect(body()).toHaveStyle({ opacity: "0" });

    // Mid-travel, and the ordering that makes it read as an opening rather
    // than as a clip: at 40 ms the box is already part-way open and the
    // sentence has not started arriving. The edge leads; the contents follow.
    const t0 = origin();
    frame(t0 + 40);
    const midway = Number.parseFloat(reveal()!.style.height);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(NATURAL_H);
    expect(body()!.style.opacity).toBe("0");

    // ...and by the time the box is nearly there, the sentence is up with it.
    frame(t0 + 120);
    expect(Number.parseFloat(reveal()!.style.height)).toBeGreaterThan(midway);
    expect(Number.parseFloat(body()!.style.opacity)).toBeGreaterThan(0.5);

    // Settled, the box is handed back to the layout: `height: auto`, so the
    // banner's own copy changing as the scan runs costs nothing.
    settle();
    expect(reveal()!.style.height).toBe("");
    expect(reveal()!.style.overflow).toBe("");
    expect(body()!.style.opacity).toBe("");
    expect(screen.getByText("Left knee actuator running hot")).toBeVisible();
  });

  it("closes the space the way it opened it", () => {
    seed("amber");
    render(<IncidentBanner unitId="N-07" />);
    raise("amber", "Sagebrush House: left knee actuator running hot");
    settle();

    act(() => {
      useFleetStore.getState().reset();
      useIncidentStore.getState().reset();
    });

    // Still on the page, still holding its space: an unmount here would snap
    // the column shut — the arrival's own event, played backwards and hidden.
    expect(reveal()).not.toBeNull();
    frame(origin() + 40);
    const midway = Number.parseFloat(reveal()!.style.height);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(NATURAL_H);

    settle();
    expect(reveal()).toBeNull();
  });

  it("does not animate a banner that was already there when the page was", () => {
    // A client-side navigation to an already-troubled unit: the banner is part
    // of the first frame, nothing was displaced, so there is nothing to
    // announce and no space to open.
    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot");
    render(<IncidentBanner unitId="N-07" />);

    expect(reveal()!.style.height).toBe("");
    expect(frames).toHaveLength(0);
  });

  it("arrives at full height for an operator who asked not to watch it", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
        onchange: null,
      })),
    );

    seed("nominal");
    render(<IncidentBanner unitId="N-07" />);
    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot");

    // The shift is the honest thing here, and it happens at once: no spring on
    // the frame loop, no inline height, nothing to sit through. The CSS clamp
    // in globals.css cannot reach a rAF spring, so this branch is explicit.
    expect(reveal()!.style.height).toBe("");
    expect(frames).toHaveLength(0);
    expect(screen.getByText("Left knee actuator running hot")).toBeVisible();
  });
});

/* ---------------------------------------------------------------------------
   ownership, elapsed time, and the diagnosis closing the alert
--------------------------------------------------------------------------- */

/** A scan that found nothing: no part to name, nothing to dispatch. */
const CLEAN: VerdictReport = {
  ...REPORT,
  anomaly: "none",
  summary: "NO ANOMALY DETECTED",
  recommendations: [],
};

function diagnose(
  report: VerdictReport,
  outcome?: "partial" | "cleared",
  acknowledge: readonly string[] = [],
) {
  act(() => {
    const incident = useIncidentStore.getState();
    incident.beginDescent("N-07");
    incident.applyDiagEvent({ t: "diag_event", unitId: "N-07", ev: { k: "scan_start" } });
    incident.applyDiagEvent({
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "verdict", report },
    });
    if (outcome) {
      incident.applyDiagEvent({
        t: "diag_event",
        unitId: "N-07",
        ev: {
          k: "recalibration",
          joint: report.joint,
          wave: [0, 0.5, 0, -0.5],
          ref: [0, 0.5, 0, -0.5],
          outcome,
        },
      });
    }
    for (const action of acknowledge) incident.acknowledgeRecommendation(action);
    incident.completeAscent();
  });
}

/**
 * The banner after the operator has acted on what it recommended.
 *
 * "Service recommended" is the console advising. Once Dispatch service is on
 * the incident the advice has been taken, and a headline still recommending it
 * is the console telling an operator to do the thing they just did — which is
 * what it did until this test existed.
 */
describe("IncidentBanner — once service has been asked for", () => {
  it("stops recommending service and states that it was requested", () => {
    seed("red");
    raise("red", "Sagebrush House: left knee actuator overheating");
    diagnose(REPORT, undefined, ["Dispatch service"]);
    render(<IncidentBanner unitId="N-07" />);

    expect(screen.getByText("Diagnostic complete — service requested")).toBeVisible();
    expect(screen.queryByText(/service recommended/i)).not.toBeInTheDocument();
  });

  it("goes on recommending it when the operator recorded something else", () => {
    seed("red");
    raise("red", "Sagebrush House: left knee actuator overheating");
    diagnose(REPORT, undefined, ["Disable joint"]);
    render(<IncidentBanner unitId="N-07" />);

    expect(screen.getByText("Diagnostic complete — service recommended")).toBeVisible();
  });

  it("still reports a cleared fault as cleared, whatever was recorded", () => {
    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot");
    diagnose(REPORT, "cleared", ["Dispatch service"]);
    render(<IncidentBanner unitId="N-07" />);

    // A van on the record does not un-fix a joint the link corrected.
    expect(screen.getByText("Diagnostic complete — fault cleared")).toBeVisible();
  });

  it("keeps the amber: requested is not repaired", () => {
    seed("red");
    raise("red", "Sagebrush House: left knee actuator overheating");
    diagnose(REPORT, "partial", ["Dispatch service"]);
    render(<IncidentBanner unitId="N-07" />);

    expect(screen.getByText("Diagnostic complete — service requested")).toBeVisible();
    expect(document.querySelector('[data-slot="incident-banner"]')).toHaveAttribute(
      "data-status",
      "warn",
    );
  });
});

/**
 * The half of the recalibration act that happens back in operator space.
 *
 * The instrument's cleared register is machine-space's business; this is what
 * the operator sees on ascent, and it was the last surface still saying
 * "service recommended" about a unit whose fault had been corrected over the
 * link ten seconds earlier. A banner that recommends a van for a robot the
 * console just fixed is the console arguing with its own record.
 */
describe("IncidentBanner — after a recalibration", () => {
  it("reports a cleared fault as cleared, and drops the amber with it", () => {
    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot");
    diagnose(REPORT, "cleared");
    render(<IncidentBanner unitId="N-07" />);

    expect(screen.getByText("Diagnostic complete — fault cleared")).toBeVisible();
    expect(screen.queryByText(/service recommended/i)).not.toBeInTheDocument();
    // The scan's finding is still stated — a treatment does not unwrite a
    // diagnosis — with the outcome as its own sentence beside it.
    expect(
      screen.getByText(
        "Left knee actuator A-07: gain anomaly. Cleared by recalibration.",
      ),
    ).toBeVisible();
    // …and the surface stops being one of the loud ones.
    const banner = document.querySelector('[data-slot="incident-banner"]');
    expect(banner).toHaveAttribute("data-status", "nominal");
  });

  it("leaves a partial correction amber and still recommending service", () => {
    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot");
    diagnose(REPORT, "partial");
    render(<IncidentBanner unitId="N-07" />);

    expect(screen.getByText("Diagnostic complete — service recommended")).toBeVisible();
    expect(
      screen.getByText("Left knee actuator A-07: gain anomaly. Recalibration partial."),
    ).toBeVisible();
    const banner = document.querySelector('[data-slot="incident-banner"]');
    expect(banner).toHaveAttribute("data-status", "warn");
  });
});

describe("IncidentBanner — alert lifecycle", () => {
  it("carries the ack taken in the fleet feed onto the unit's own page", () => {
    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot", "al-amber");
    render(<IncidentBanner unitId="N-07" />);

    expect(screen.queryByText("Acknowledged")).not.toBeInTheDocument();

    act(() => {
      useFleetStore.getState().ackAlert("al-amber");
    });

    expect(screen.getByText("Acknowledged")).toBeVisible();
  });

  it("says when the trouble started and how long it has been running", () => {
    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot", "al-amber");
    render(<IncidentBanner unitId="N-07" />);

    expect(screen.getByText(/Raised/)).toHaveTextContent(
      /Raised \d{2}:\d{2}:\d{2} · open for \d+s/,
    );
  });

  it("drops the clock once a scan is the page's subject", () => {
    seed("amber");
    raise("amber", "Sagebrush House: left knee actuator running hot", "al-amber");
    render(<IncidentBanner unitId="N-07" />);

    act(() => {
      useIncidentStore.getState().beginDescent("N-07");
    });

    expect(screen.queryByText(/Raised \d{2}:\d{2}:\d{2}/)).not.toBeInTheDocument();
  });

  it("closes the alerts a diagnosis answered, citing the incident it became", () => {
    seed("red");
    raise("red", "Sagebrush House: left knee actuator overheating", "al-red");
    render(<IncidentBanner unitId="N-07" />);

    diagnose(REPORT);

    const meta = useFleetStore.getState().alertMeta["al-red"];
    expect(meta?.resolvedAt).toBeDefined();
    expect(meta?.resolution).toEqual({
      via: "incident",
      ref: useIncidentStore.getState().history[0]?.id,
    });
  });

  it("leaves the alert open when the scan found nothing to explain it", () => {
    seed("red");
    raise("red", "Sagebrush House: left knee actuator overheating", "al-red");
    render(<IncidentBanner unitId="N-07" />);

    diagnose(CLEAN);

    // A clean pass answers the operator's question without explaining the
    // fault. Marking the alert resolved on the strength of it would record a
    // conclusion nobody reached.
    expect(useFleetStore.getState().alertMeta["al-red"]?.resolvedAt).toBeUndefined();
  });

  it("does not retroactively close an alert raised after the incident", () => {
    seed("red");
    raise("red", "Sagebrush House: left knee actuator overheating", "al-red");
    render(<IncidentBanner unitId="N-07" />);
    diagnose(REPORT);

    raise("amber", "Sagebrush House: left knee actuator running hot", "al-later");

    expect(useFleetStore.getState().alertMeta["al-later"]?.resolvedAt).toBeUndefined();
  });
});

describe("IncidentBanner — acknowledging from the unit's own page", () => {
  it("offers Acknowledge while the newest alert is nobody's, and takes every standing alert on the unit", async () => {
    seed("red");
    raise("amber", "Elm House: left knee actuator trending hot", "al-amber");
    raise(
      "red",
      "Elm House: left knee actuator overheating, torque ripple detected",
      "al-red",
    );
    render(<IncidentBanner unitId="N-07" />);

    const button = screen.getByRole("button", { name: "Acknowledge alert on N-07" });
    expect(screen.queryByText("Acknowledged")).not.toBeInTheDocument();

    await userEvent.click(button);

    // The unit, not the event: the amber the red escalated is taken with it.
    const fleet = useFleetStore.getState();
    expect(selectAlertMeta("al-red")(fleet)?.ackedAt).toBeDefined();
    expect(selectAlertMeta("al-amber")(fleet)?.ackedAt).toBeDefined();
    // and the banner now says so, with nothing left to press but the pill
    expect(screen.getByText("Acknowledged")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Acknowledge alert on N-07" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run diagnostic/i })).toBeVisible();
  });

  it("does not offer it once the alert has been taken from the feed", () => {
    seed("red");
    raise(
      "red",
      "Elm House: left knee actuator overheating, torque ripple detected",
      "al-red",
    );
    useFleetStore.getState().ackAlert("al-red");
    render(<IncidentBanner unitId="N-07" />);

    expect(
      screen.queryByRole("button", { name: /acknowledge/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Acknowledged")).toBeVisible();
  });
});
