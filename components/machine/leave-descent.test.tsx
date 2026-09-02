import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type DiagEvent, type DiagEventMessage, type VerdictReport } from "@/lib/schema";
import { useIncidentStore } from "@/lib/stores";
import { closeDescent } from "./leave-descent";
import { ScanHeader } from "./scan-header";

/**
 * one control, two meanings, and the whole feature turns on which one
 * fires.
 *
 * Mid-scan CLOSE must leave the session alone — wiring it to `abortSession`
 * looks identical for one frame and then discards a diagnostic the sim is
 * still executing. At the verdict it must be RETURN exactly, incident and all
 * — a close that skipped the archive would throw away the only thing the
 * descent produced, through the control an operator reaches for without
 * reading.
 */

const ev = (e: DiagEvent, unitId = "N-07"): DiagEventMessage => ({
  t: "diag_event",
  unitId,
  ev: e,
});

const report: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LEFT KNEE ACTUATOR A-07 GAIN ANOMALY",
  recommendations: ["Dispatch service"],
  ts: 120_000,
};

const toScanning = () =>
  act(() => {
    const store = useIncidentStore.getState();
    store.beginDescent("N-07");
    store.applyDiagEvent(ev({ k: "scan_start" }));
    store.applyDiagEvent(ev({ k: "walk", path: "/sys/core/heartbeat.svc" }));
  });

const toVerdict = () => {
  toScanning();
  act(() => useIncidentStore.getState().applyDiagEvent(ev({ k: "verdict", report })));
};

beforeEach(() => {
  useIncidentStore.getState().reset();
});

describe("closeDescent", () => {
  it("leaves a running scan without ending it", () => {
    toScanning();
    act(() => closeDescent());

    const state = useIncidentStore.getState();
    expect(state.watching).toBe(false);
    expect(state.phase).toBe("scanning");
    expect(state.session?.walkLines).toEqual(["/sys/core/heartbeat.svc"]);
    expect(state.history).toHaveLength(0);
  });

  it("is RETURN at the verdict — the incident is logged", () => {
    toVerdict();
    act(() => closeDescent());

    const state = useIncidentStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.session).toBeNull();
    expect(state.watching).toBe(false);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.report).toEqual(report);
  });

  it("carries acknowledgements into the record, exactly as RETURN does", () => {
    toVerdict();
    act(() => useIncidentStore.getState().acknowledgeRecommendation("Dispatch service"));
    act(() => closeDescent());

    expect(useIncidentStore.getState().history[0]?.acknowledged).toEqual([
      "Dispatch service",
    ]);
  });

  it("minimizing does not change what closing means", () => {
    toVerdict();
    // Minimize is a view decision held in the stage, not the store — the phase
    // is still `verdict`, so the strip's RETURN and the header's CLOSE are the
    // same gesture. This asserts the store-level fact that makes that true.
    expect(useIncidentStore.getState().phase).toBe("verdict");
    act(() => closeDescent());
    expect(useIncidentStore.getState().history).toHaveLength(1);
  });
});

describe("the header's close control", () => {
  const header = (phase: "scanning" | "verdict") =>
    render(
      <ScanHeader
        unitId="N-07"
        startedAt={1_700_000_000_000}
        link="open"
        phase={phase}
        showReturn={false}
      />,
    );

  it("is present in every phase, named for the surface it closes", () => {
    toScanning();
    header("scanning");
    expect(screen.getByRole("button", { name: "Close diagnostic view" })).toBeVisible();
  });

  it("says which of the two things it is about to do", () => {
    toScanning();
    const view = header("scanning");
    expect(
      screen.getByRole("button", { name: "Close diagnostic view" }),
    ).toHaveAccessibleDescription("Returns to the console. The scan keeps running.");

    view.unmount();
    toVerdict();
    header("verdict");
    expect(
      screen.getByRole("button", { name: "Close diagnostic view" }),
    ).toHaveAccessibleDescription("Returns to the console. The incident is logged.");
  });

  it("leaves the scan running when pressed mid-scan", async () => {
    toScanning();
    header("scanning");
    await userEvent.click(screen.getByRole("button", { name: "Close diagnostic view" }));

    expect(useIncidentStore.getState().phase).toBe("scanning");
    expect(useIncidentStore.getState().watching).toBe(false);
  });

  it("returns with the incident when pressed at the verdict", async () => {
    toVerdict();
    header("verdict");
    await userEvent.click(screen.getByRole("button", { name: "Close diagnostic view" }));

    expect(useIncidentStore.getState().phase).toBe("idle");
    expect(useIncidentStore.getState().history).toHaveLength(1);
  });
});
