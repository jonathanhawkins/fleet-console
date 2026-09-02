import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAuditStore, useFleetStore, type AuditEntry } from "@/lib/stores";
import { SessionLog, UnitAuditLog } from "./audit-log";

/**
 * The session log is the console's answer to "what happened on your watch".
 * Two things have to hold: it must be this unit's story and nobody else's, and
 * it must read in the order the events happened — a record that has to be
 * reversed in the reader's head is a record they will get wrong under pressure.
 */

const BASE = 1_700_000_000_000;

function append(entry: Omit<AuditEntry, "id">) {
  useAuditStore.getState().append(entry);
}

/** The scripted incident, in the order it happens. */
function seedSession() {
  append({
    ts: BASE,
    kind: "alert-raised",
    unitId: "N-07",
    summary: "Sagebrush House: left knee actuator running hot",
    ref: "al-001",
  });
  append({
    ts: BASE + 40_000,
    kind: "escalation",
    unitId: "N-07",
    summary: "Escalated amber → red",
    ref: "al-002",
  });
  append({
    ts: BASE + 56_000,
    kind: "alert-acked",
    unitId: "N-07",
    summary: "Acknowledged by Operator",
    ref: "al-001",
  });
  append({
    ts: BASE + 70_000,
    kind: "diag-start",
    unitId: "N-07",
    summary: "Diagnostic scan started",
  });
}

beforeEach(() => {
  useAuditStore.getState().reset();
  useFleetStore.getState().reset();
  useFleetStore.getState().applySnapshot({
    t: "fleet_snapshot",
    units: [
      {
        id: "N-07",
        name: "Sagebrush House",
        status: "nominal",
        battery: 82,
        pos: { lat: 44.06, lng: -121.31 },
      },
    ],
  });
});

describe("UnitAuditLog", () => {
  it("reads oldest first — the shape of the incident, not a stack of facts", () => {
    seedSession();
    render(<UnitAuditLog unitId="N-07" />);

    const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("Left knee actuator running hot");
    expect(lines[1]).toContain("Escalated to alert");
    expect(lines[2]).toContain("Acknowledged by Operator");
    expect(lines[3]).toContain("Diagnostic scan started");
  });

  it("tags every line with its kind and stamps it with a wall clock", () => {
    seedSession();
    render(<UnitAuditLog unitId="N-07" />);

    const [first] = screen.getAllByRole("listitem");
    expect(within(first!).getByText("Raised")).toBeVisible();
    expect(within(first!).getByRole("time")).toHaveTextContent(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("is this unit's story and nobody else's", () => {
    seedSession();
    append({
      ts: BASE + 5_000,
      kind: "alert-raised",
      unitId: "N-03",
      summary: "Juniper House: battery low",
      ref: "al-900",
    });

    render(<UnitAuditLog unitId="N-07" />);
    expect(screen.queryByText(/Juniper House/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  /**
   * Archiving a diagnostic closes every alert standing on the unit in
   * one pass, so the scripted incident wrote two identical closures a
   * millisecond apart and the log printed the same sentence twice.
   */
  it("prints two alerts closing on one press as one counted line", () => {
    seedSession();
    append({
      ts: BASE + 120_000,
      kind: "resolution",
      unitId: "N-07",
      summary: "Resolved — diagnostic incident logged",
      ref: "al-001",
    });
    append({
      ts: BASE + 120_001,
      kind: "resolution",
      unitId: "N-07",
      summary: "Resolved — diagnostic incident logged",
      ref: "al-002",
    });

    render(<UnitAuditLog unitId="N-07" />);
    const lines = screen.getAllByRole("listitem");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toHaveTextContent("Resolved 2 alerts — diagnostic incident logged");
    expect(screen.getAllByText(/diagnostic incident logged/)).toHaveLength(1);
  });

  it("leaves a single closure saying exactly what the store wrote", () => {
    append({
      ts: BASE + 120_000,
      kind: "resolution",
      unitId: "N-07",
      summary: "Resolved — diagnostic incident logged",
      ref: "al-001",
    });
    render(<UnitAuditLog unitId="N-07" />);
    expect(screen.getByRole("listitem")).toHaveTextContent(
      "Resolved — diagnostic incident logged",
    );
    expect(screen.queryByText(/alerts/)).not.toBeInTheDocument();
  });

  /**
   * The reported session ran ESCALATED 18:08 → DIAGNOSTIC 19:41, with
   * the ninety-three minutes between them carried entirely by two timestamps
   * three columns apart. The pause does that subtraction for the reader.
   */
  it("marks the pauses where the console stood idle", () => {
    seedSession();
    append({
      ts: BASE + 70_000 + 5_600_000, // 1h 33m after the scan started
      kind: "diag-verdict",
      unitId: "N-07",
      summary: "LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE",
      ref: "inc-N-07-1",
    });

    render(<UnitAuditLog unitId="N-07" />);
    const pause = document.querySelector("[data-slot='audit-pause']");
    expect(pause).toHaveTextContent("· 1h 33m later");
    // It stands between the two rows it separates, and is not one of them.
    const rows = screen.getAllByRole("listitem");
    expect(rows[4]).toBe(pause);
    expect(rows[5]).toHaveTextContent("Diagnostic verdict recorded");
  });

  it("does not mark the seconds inside an incident — those are already legible", () => {
    seedSession(); // raise, escalate, ack, scan: 70 seconds end to end
    render(<UnitAuditLog unitId="N-07" />);
    expect(document.querySelector("[data-slot='audit-pause']")).toBeNull();
  });

  /**
   * The dense list is the alert row's own recap, inside a row that already
   * prints how long its alert has been open. A pause there adds height to a
   * summary to say something the row says in its header.
   */
  it("keeps the pause out of the dense recap", () => {
    seedSession();
    append({
      ts: BASE + 70_000 + 5_600_000,
      kind: "resolution",
      unitId: "N-07",
      summary: "Resolved — diagnostic incident logged",
      ref: "al-001",
    });

    render(<UnitAuditLog unitId="N-07" dense />);
    expect(document.querySelector("[data-slot='audit-pause']")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("renders the caller's own empty copy rather than an empty list", () => {
    render(<UnitAuditLog unitId="N-07" empty={<p>Nothing yet.</p>} />);
    expect(screen.getByText("Nothing yet.")).toBeVisible();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("SessionLog", () => {
  it("does not exist for a unit with no history", () => {
    const { container } = render(<SessionLog unitId="N-07" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens closed, but says how much is inside", () => {
    seedSession();
    render(<SessionLog unitId="N-07" />);

    expect(screen.getByText("Session log")).toBeVisible();
    expect(screen.getByText("4 entries")).toBeVisible();

    const toggle = screen.getByRole("button", { name: "Show" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Clipped to zero height, and out of the accessibility tree with it: a
    // keyboard operator must not be able to tab into a panel they cannot see.
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(panel).toHaveAttribute("inert");
  });

  it("opens on the operator's word and closes again on it", () => {
    seedSession();
    render(<SessionLog unitId="N-07" />);

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    const toggle = screen.getByRole("button", { name: "Hide" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(panel).not.toHaveAttribute("inert");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(4);

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  /**
   * The header is a promise about what is behind the disclosure. Counting
   * store entries there while the body collapses two of them into one row would
   * open a "6 entries" log on five lines.
   */
  it("counts the rows the operator will actually see", () => {
    seedSession();
    append({
      ts: BASE + 120_000,
      kind: "resolution",
      unitId: "N-07",
      summary: "Resolved — diagnostic incident logged",
      ref: "al-001",
    });
    append({
      ts: BASE + 120_001,
      kind: "resolution",
      unitId: "N-07",
      summary: "Resolved — diagnostic incident logged",
      ref: "al-002",
    });

    render(<SessionLog unitId="N-07" />);
    expect(screen.getByText("5 entries")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    const panel = document.getElementById(
      screen.getByRole("button", { name: "Hide" }).getAttribute("aria-controls")!,
    )!;
    expect(within(panel).getAllByRole("listitem")).toHaveLength(5);
  });

  it("agrees with its own noun at one entry", () => {
    append({
      ts: BASE,
      kind: "alert-raised",
      unitId: "N-07",
      summary: "Sagebrush House: left knee actuator running hot",
      ref: "al-001",
    });
    render(<SessionLog unitId="N-07" />);
    expect(screen.getByText("1 entry")).toBeVisible();
  });
});
