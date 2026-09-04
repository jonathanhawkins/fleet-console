import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { type DiagChannel, type DiagSession } from "@/lib/stores";
import { type VerdictReport } from "@/lib/schema";
import { ScanStatusBar } from "./scan-header";

/**
 * The bottom rule prints every tick of progress and *speaks* far fewer of
 * them — the fix for a screen reader still reading walk paths after the
 * verdict has already landed on screen. These tests are about the spoken
 * channel only; scan-copy.test.ts already covers what the printed line says
 * and when, from the same `scanStatusLine`.
 */

const session = (over: Partial<DiagSession> = {}): DiagSession => ({
  unitId: "N-07",
  startedAt: 0,
  walkLines: [],
  channels: [],
  flag: null,
  report: null,
  acknowledged: [],
  calibration: null,
  ...over,
});

const ch = (joint: string): DiagChannel => ({ joint, wave: [0, 1, 0], ref: [0, 1, 0] });

const report: VerdictReport = {
  unitId: "N-07",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
  summary: "LEFT KNEE ACTUATOR A-07 GAIN ANOMALY.",
  recommendations: ["Recalibrate joint"],
  ts: 15_000,
};

/** The spoken channel's current text — empty until the first beat lands. */
const announced = (container: HTMLElement): string =>
  container.querySelector('[data-slot="scan-announce"]')?.textContent ?? "";

/** The printed line — unthrottled, moves on every tick of progress. */
const printed = (container: HTMLElement): string =>
  container.querySelector("p")?.textContent ?? "";

describe("ScanStatusBar — the spoken channel", () => {
  it("is a visually hidden, atomic live region, separate from the printed line", () => {
    const { container } = render(
      <ScanStatusBar session={session()} link="open" phase="scanning" />,
    );
    const region = container.querySelector('[data-slot="scan-announce"]');
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region?.className).toContain("sr-only");
    // Not the same element the sighted line prints from — the printed line
    // carries no aria-live of its own any more.
    expect(container.querySelector("p")).not.toHaveAttribute("aria-live");
  });

  it("does not repeat itself for every node walked in the same subsystem", () => {
    const paths = [
      "/sys/core/heartbeat.svc",
      "/sys/core/power_rail/v48_main",
      "/sys/core/thermal/zone_map.cfg",
      "/sys/actuator_bus/enumerate",
      "/sys/actuator_bus/hip_L/actuator_A03",
    ];
    const { container, rerender } = render(
      <ScanStatusBar
        session={session({ walkLines: [paths[0]!] })}
        link="open"
        phase="scanning"
      />,
    );
    const firstSpoken = announced(container);
    expect(firstSpoken).toMatch(/^WALKING SUBSYSTEM TREE/);

    // Four more nodes land, all still under /sys/ — the printed line counts
    // up (NODE 01 → NODE 05) but nothing the operator has not already been
    // told gets announced again.
    for (let i = 2; i <= paths.length; i += 1) {
      rerender(
        <ScanStatusBar
          session={session({ walkLines: paths.slice(0, i) })}
          link="open"
          phase="scanning"
        />,
      );
    }
    expect(printed(container)).toContain(`NODE 0${paths.length}`);
    expect(announced(container)).toBe(firstSpoken);
  });

  it("speaks again when the walk crosses into a different subsystem", () => {
    const { container, rerender } = render(
      <ScanStatusBar
        session={session({ walkLines: ["/sys/actuator_bus/enumerate"] })}
        link="open"
        phase="scanning"
      />,
    );
    const underSys = announced(container);

    rerender(
      <ScanStatusBar
        session={session({
          walkLines: ["/sys/actuator_bus/enumerate", "/firmware/gait/park_pose.ko"],
        })}
        link="open"
        phase="scanning"
      />,
    );
    const underFirmware = announced(container);
    expect(underFirmware).toMatch(/^WALKING SUBSYSTEM TREE/);
    expect(underFirmware).not.toBe(underSys);
  });

  it("speaks once for the channel sweep opening, not once per channel counted", () => {
    const { container, rerender } = render(
      <ScanStatusBar
        session={session({ channels: [ch("hip_L")] })}
        link="open"
        phase="scanning"
      />,
    );
    const sweepBegin = announced(container);
    expect(sweepBegin).toMatch(/^SCANNING ACTUATOR BUS/);

    for (const joints of [
      ["hip_L", "hip_R"],
      ["hip_L", "hip_R", "knee_L"],
      ["hip_L", "hip_R", "knee_L", "knee_R"],
    ]) {
      rerender(
        <ScanStatusBar
          session={session({ channels: joints.map(ch) })}
          link="open"
          phase="scanning"
        />,
      );
    }
    expect(printed(container)).toContain("CHANNEL 04/06");
    expect(announced(container)).toBe(sweepBegin);
  });

  it("speaks again the moment a divergence is flagged, and not again after", () => {
    const { container, rerender } = render(
      <ScanStatusBar
        session={session({ channels: [ch("knee_L")] })}
        link="open"
        phase="scanning"
      />,
    );
    const beforeFlag = announced(container);

    const flagged = () => (
      <ScanStatusBar
        session={session({
          channels: [ch("knee_L"), ch("knee_R")],
          flag: {
            k: "flag",
            joint: "knee_L",
            component: "actuator_A07",
            anomaly: "gain",
          },
        })}
        link="open"
        phase="scanning"
      />
    );
    rerender(flagged());
    const afterFlag = announced(container);
    expect(afterFlag).not.toBe(beforeFlag);
    expect(afterFlag).toMatch(/DIVERGENCE HELD/);

    // A further channel arrives with the flag already standing — no second
    // announcement for it.
    rerender(
      <ScanStatusBar
        session={session({
          channels: [ch("knee_L"), ch("knee_R"), ch("ankle_L")],
          flag: {
            k: "flag",
            joint: "knee_L",
            component: "actuator_A07",
            anomaly: "gain",
          },
        })}
        link="open"
        phase="scanning"
      />,
    );
    expect(announced(container)).toBe(afterFlag);
  });

  it("speaks the verdict once it lands", () => {
    const { container, rerender } = render(
      <ScanStatusBar
        session={session({ channels: [ch("knee_L")] })}
        link="open"
        phase="scanning"
      />,
    );
    rerender(
      <ScanStatusBar
        session={session({ channels: [ch("knee_L")], report })}
        link="open"
        phase="verdict"
      />,
    );
    expect(announced(container)).toMatch(/^SCAN COMPLETE/);
  });

  it("speaks a held link immediately, outranking whatever progress was showing", () => {
    const { container, rerender } = render(
      <ScanStatusBar
        session={session({ walkLines: ["/sys/core/heartbeat.svc"] })}
        link="open"
        phase="scanning"
      />,
    );
    rerender(
      <ScanStatusBar
        session={session({ walkLines: ["/sys/core/heartbeat.svc"] })}
        link="lost"
        phase="scanning"
      />,
    );
    expect(announced(container)).toMatch(/^HOLD/);
  });
});
