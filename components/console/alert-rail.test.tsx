import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Alert, type AlertSeverity, type FleetSnapshotMessage } from "@/lib/schema";
import { useAuditStore, useFleetStore } from "@/lib/stores";
import {
  AlertFilterToggle,
  AlertRail,
  FleetAlertCount,
  setAlertFilter,
} from "./alert-rail";

/**
 * The feed's job used to be to be trustworthy about two things: order and
 * severity. Since it has a third — the lifecycle. An operator reading
 * this list is answering "what is still mine to deal with", and a row that got
 * ownership, escalation or resolution wrong would be worse than one that showed
 * nothing at all.
 */

const BASE = 1_700_000_000_000;
/** Far enough past the base alert to make every duration assertion readable. */
const NOW = BASE + 134_000;

/**
 * A fleet with names in it. The chronology trims the wire's house prefix off
 * raised-alert lines, and it can only do that against a unit the store knows.
 */
const SNAPSHOT: FleetSnapshotMessage = {
  t: "fleet_snapshot",
  units: [
    {
      id: "N-07",
      name: "Sagebrush House",
      status: "nominal",
      battery: 82,
      pos: { lat: 44.06, lng: -121.31 },
    },
    {
      id: "N-03",
      name: "Juniper House",
      status: "nominal",
      battery: 74,
      pos: { lat: 44.05, lng: -121.32 },
    },
  ],
};

function raise(over: Partial<Alert> = {}) {
  const alert: Alert = {
    id: "al-001",
    unitId: "N-07",
    severity: "amber",
    message: "Sagebrush House: left knee actuator running hot",
    ts: BASE,
    ...over,
  };
  useFleetStore.getState().applyAlert({ t: "alert", alert });
  return alert;
}

/** The escalation shape the whole phase is built around: amber, then red. */
function escalation() {
  const amber = raise({ id: "al-001", ts: BASE });
  const red = raise({
    id: "al-002",
    ts: BASE + 40_000,
    severity: "red",
    message: "Sagebrush House: left knee actuator overheating",
  });
  return { amber, red };
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-slot='alert-row']"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setAlertFilter("open");
  useFleetStore.getState().reset();
  useFleetStore.getState().applySnapshot(SNAPSHOT);
  // The fleet reducer appends to the audit log, so a stale log would leak the
  // previous test's history into this one's row expansion.
  useAuditStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AlertRail", () => {
  it("describes the region rather than claiming the fleet is healthy", () => {
    render(<AlertRail />);
    expect(screen.getByText("Alerts appear here as they are raised.")).toBeVisible();
  });

  it("reads newest first, whatever order the alerts arrived in", () => {
    raise({ id: "al-001", ts: BASE, message: "First" });
    raise({ id: "al-002", ts: BASE + 5_000, message: "Second" });
    raise({ id: "al-003", ts: BASE + 9_000, message: "Third" });

    render(<AlertRail />);
    const links = screen.getAllByRole("link");
    expect(
      links.map((r) => within(r).getByText(/First|Second|Third/).textContent),
    ).toEqual(["Third", "Second", "First"]);
  });

  it("never shows the same alert twice when the server replays it", () => {
    raise({ id: "al-001" });
    raise({ id: "al-001" });

    render(<AlertRail />);
    expect(rows()).toHaveLength(1);
  });

  it("states severity in operator English and colours it from the token table", () => {
    raise({ id: "al-001", severity: "amber" });
    raise({ id: "al-002", severity: "red", message: "overheating" });

    render(<AlertRail />);
    expect(screen.getByText("Attention")).toHaveAttribute("data-status", "warn");
    expect(screen.getByText("Alert")).toHaveAttribute("data-status", "alert");
  });

  it("is a route to the unit that raised it — the operator's next move", () => {
    raise({ id: "al-001", unitId: "N-03" });
    render(<AlertRail />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/unit/N-03");
  });

  it("carries a machine-readable timestamp beside the human one", () => {
    raise({ id: "al-001", ts: BASE });
    render(<AlertRail />);
    const time = screen.getByRole("link").querySelector("time");
    expect(time).toHaveAttribute("dateTime", new Date(BASE).toISOString());
  });

  it("plays its entrance on mount only, so a ticking clock does not re-animate it", () => {
    raise({ id: "al-001" });
    render(<AlertRail />);
    const [first] = rows();
    expect(first).toHaveClass("alert-enter");

    act(() => {
      raise({ id: "al-002", severity: "red", message: "overheating" });
    });

    // the original row is the same element, untouched; only the new row mounted
    const after = rows();
    expect(after).toHaveLength(2);
    expect(after[1]).toBe(first);
  });
});

describe("AlertRail — detection time and duration", () => {
  it("prints the exact detection clock alongside the live duration", () => {
    raise({ id: "al-001", ts: BASE });
    render(<AlertRail />);

    const [row] = rows();
    expect(row).toHaveTextContent(/\d{2}:\d{2}:\d{2}/);
    expect(row).toHaveTextContent("Open for 2m 14s");
  });

  it("stops counting the moment someone takes the alert", () => {
    raise({ id: "al-001", ts: BASE });
    render(<AlertRail />);

    act(() => {
      useFleetStore.getState().ackAlert("al-001");
    });

    expect(rows()[0]).not.toHaveTextContent("Open for");
  });
});

describe("AlertRail — escalation", () => {
  it("marks the red with where it came from and recedes the amber it took over", () => {
    escalation();
    render(<AlertRail />);

    const [red, amber] = rows();
    expect(red).toHaveTextContent(/Escalated from attention · \d{2}:\d{2}:\d{2}/);
    expect(red).not.toHaveAttribute("data-escalated");

    expect(amber).toHaveAttribute("data-escalated", "true");
    expect(within(amber!).getByText("Escalated")).toBeInTheDocument();
  });

  it("drops the superseded amber's chip ground so it stops competing with the red", () => {
    escalation();
    render(<AlertRail />);

    const [red, amber] = rows();
    expect(within(red!).getByText("Alert")).toHaveClass("bg-alert-tint");
    expect(within(amber!).getByText("Attention")).toHaveClass("bg-transparent");
  });
});

describe("AlertRail — acknowledge", () => {
  it("takes ownership in one click, with no dialog in the way", () => {
    raise({ id: "al-001" });
    render(<AlertRail />);

    fireEvent.click(screen.getByRole("button", { name: /Acknowledge alert on N-07/ }));

    expect(useFleetStore.getState().alertMeta["al-001"]?.ackedBy).toBe("Operator");
    expect(rows()[0]).toHaveAttribute("data-lifecycle", "acked");
    expect(rows()[0]).toHaveTextContent("Acknowledged · Operator");
  });

  it("offers no way to take it back — the ack is already in the audit log", () => {
    raise({ id: "al-001" });
    render(<AlertRail />);
    fireEvent.click(screen.getByRole("button", { name: /Acknowledge alert on N-07/ }));

    expect(screen.queryByRole("button", { name: /Acknowledge/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Un-?acknowledge/i }),
    ).not.toBeInTheDocument();
  });

  it("names the unit in the button, so forty of them are tellable apart", () => {
    raise({ id: "al-001", unitId: "N-07" });
    raise({ id: "al-002", unitId: "N-03", ts: BASE + 1_000 });
    render(<AlertRail />);

    expect(
      screen.getByRole("button", { name: "Acknowledge alert on N-07" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Acknowledge alert on N-03" }),
    ).toBeVisible();
  });

  it("keeps an acked alert in the working view — ownership is not closure", () => {
    raise({ id: "al-001" });
    render(<AlertRail />);
    fireEvent.click(screen.getByRole("button", { name: /Acknowledge alert on N-07/ }));

    expect(rows()).toHaveLength(1);
  });
});

describe("AlertRail — resolution", () => {
  function resolve(id = "al-001") {
    act(() => {
      useFleetStore
        .getState()
        .resolveAlert(id, { via: "incident", ref: "inc-N-07-1700000000000" });
    });
  }

  it("says what closed it and when, and keeps the row out of the working view", () => {
    raise({ id: "al-001" });
    render(
      <>
        <AlertFilterToggle />
        <AlertRail />
      </>,
    );
    resolve();

    // Default view is Open, so the resolved row leaves the list — but the feed
    // still knows it happened.
    expect(rows()).toHaveLength(0);
    expect(
      screen.getByText(/No open alerts\. 1 alert resolved this session\./),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const [row] = rows();
    expect(row).toHaveAttribute("data-lifecycle", "resolved");
    expect(row).toHaveTextContent(/Resolved · diagnostic · \d{2}:\d{2}:\d{2}/);
  });

  it("recedes a resolved row further than an acked one", () => {
    raise({ id: "al-001" });
    raise({ id: "al-002", unitId: "N-03", ts: BASE + 1_000 });
    render(
      <>
        <AlertFilterToggle />
        <AlertRail />
      </>,
    );

    act(() => {
      useFleetStore.getState().ackAlert("al-002");
    });
    resolve("al-001");
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    const acked = rows().find((r) => r.dataset.lifecycle === "acked");
    const settled = rows().find((r) => r.dataset.lifecycle === "resolved");

    // The acked row keeps its unit id at full weight — someone is on it. The
    // resolved row gives that up too.
    expect(within(acked!).getByText("N-03")).toHaveClass("text-ink");
    expect(within(settled!).getByText("N-07")).toHaveClass("text-ink-soft");
  });
});

describe("AlertRail — the working view", () => {
  it("defaults to Open and keeps the resolved rows one click away", () => {
    raise({ id: "al-001" });
    raise({ id: "al-002", ts: BASE + 1_000, severity: "red", message: "overheating" });
    render(
      <>
        <AlertFilterToggle />
        <AlertRail />
      </>,
    );

    act(() => {
      useFleetStore.getState().resolveAlert("al-001", { via: "operator" });
    });

    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(rows()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("offers nothing to filter while the fleet is healthy", () => {
    const { container } = render(<AlertFilterToggle />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AlertRail — related events", () => {
  it("stays closed until asked, and the panel is inert until then", () => {
    escalation();
    render(<AlertRail />);

    const toggle = screen.getAllByRole("button", { name: /Related events/ })[0]!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(panel).toHaveAttribute("inert");
    // Lazy: a hundred collapsed rows carry a hundred empty wrappers and zero
    // store subscriptions (disclosure.tsx).
    expect(within(panel).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("opens this unit's chronology, oldest first, on the row's own disclosure", () => {
    escalation();
    render(<AlertRail />);

    fireEvent.click(screen.getAllByRole("button", { name: /Related events/ })[0]!);

    const toggle = screen.getAllByRole("button", { name: /Related events/ })[0]!;
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(panel).not.toHaveAttribute("inert");

    const lines = within(panel).getAllByRole("listitem");
    expect(lines[0]).toHaveTextContent("Left knee actuator running hot");
    expect(lines[lines.length - 1]).toHaveTextContent("Escalated to alert");
  });

  it("opens one row at a time, so the feed stays readable", () => {
    escalation();
    render(<AlertRail />);

    const toggles = screen.getAllByRole("button", { name: /Related events/ });
    fireEvent.click(toggles[0]!);
    fireEvent.click(toggles[1]!);

    expect(screen.getAllByRole("button", { name: /Related events/ })[0]).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getAllByRole("button", { name: /Related events/ })[1]).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("closes again on a second press", () => {
    raise({ id: "al-001" });
    render(<AlertRail />);

    const toggle = () => screen.getByRole("button", { name: /Related events/ });
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("FleetAlertCount", () => {
  it("says nothing while the fleet is healthy", () => {
    const { container } = render(<FleetAlertCount />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts events and the units they came from, so neither number is bare", () => {
    // The escalation shape: two events, one troubled robot. This header used to
    // say "2 active" beside a KPI reading 1 and the page looked self-
    // contradictory.
    for (const [i, severity] of (["amber", "red"] as AlertSeverity[]).entries()) {
      raise({ id: `al-00${i + 1}`, severity, ts: BASE + i * 1_000 });
    }
    render(<FleetAlertCount />);
    expect(screen.getByText("2 events · 1 unit")).toBeInTheDocument();
  });

  it("counts distinct units, not rows", () => {
    raise({ id: "al-001", unitId: "N-07" });
    raise({ id: "al-002", unitId: "N-03", severity: "red", ts: BASE + 1_000 });
    raise({ id: "al-003", unitId: "N-07", severity: "red", ts: BASE + 2_000 });

    render(<FleetAlertCount />);
    expect(screen.getByText("3 events · 2 units")).toBeInTheDocument();
  });

  it("agrees with its own nouns at one", () => {
    raise({ id: "al-001" });
    render(<FleetAlertCount />);
    expect(screen.getByText("1 event · 1 unit")).toBeInTheDocument();
  });

  it("counts the rows on screen, so the header never labels a set nobody can see", () => {
    raise({ id: "al-001" });
    raise({ id: "al-002", unitId: "N-03", ts: BASE + 1_000 });
    render(
      <>
        <FleetAlertCount />
        <AlertFilterToggle />
      </>,
    );

    act(() => {
      useFleetStore.getState().resolveAlert("al-002", { via: "operator" });
    });
    expect(screen.getByText("1 event · 1 unit")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("2 events · 2 units")).toBeInTheDocument();
  });
});
