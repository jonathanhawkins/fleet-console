// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type DiagSession } from "@/lib/stores";
import { buildScanLog, type ScanLogLine } from "./scan-log-lines";

/**
 * DoD: the log survives a mid-scan disconnect and a replayed prefix.
 *
 * Both properties are properties of *this function*, because the component
 * around it holds no state: the log is a projection of the session, so
 * "dedupes on replay" reduces to "same session, same lines", and that is a
 * thing a pure test can pin down completely.
 */

const session = (over: Partial<DiagSession> = {}): DiagSession => ({
  unitId: "N-07",
  startedAt: 1_700_000_000_000,
  walkLines: [],
  channels: [],
  flag: null,
  report: null,
  acknowledged: [],
  calibration: null,
  ...over,
});

const flag = {
  k: "flag" as const,
  joint: "knee_L" as const,
  component: "actuator_A07" as const,
  anomaly: "gain" as const,
};

/** A channel that hugs its reference, and one that does not. */
const ref = [0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5];
const healthy = { joint: "hip_L", ref, wave: ref.map((v) => v * 1.01) };
const failing = { joint: "knee_L", ref, wave: ref.map((v) => v * 1.6) };

const texts = (lines: ScanLogLine[]) => lines.map((l) => l.text);
const kinds = (lines: ScanLogLine[]) => lines.map((l) => l.kind);

describe("buildScanLog", () => {
  it("says nothing without a session", () => {
    expect(buildScanLog({ session: null, link: "open", complete: false })).toEqual([]);
  });

  it("opens on SCAN START and numbers the walk from 0001", () => {
    const lines = buildScanLog({
      session: session({ walkLines: ["/sys/core/heartbeat.svc", "/proprio/imu/fusion"] }),
      link: "open",
      complete: false,
    });

    expect(kinds(lines)).toEqual(["phase", "walk", "walk"]);
    expect(lines[0]?.text).toBe("SCAN START · SUBSYSTEM TREE");
    expect(lines[1]?.gutter).toBe("0001");
    expect(lines[2]?.gutter).toBe("0002");
    expect(lines[1]?.text).toBe("/sys/core/heartbeat.svc");
  });

  it("announces the sweep once, then measures every channel it was sent", () => {
    const lines = buildScanLog({
      session: session({ channels: [healthy, failing] }),
      link: "open",
      complete: false,
    });

    expect(texts(lines)).toContain("CHANNEL SWEEP BEGIN · ACTUATOR BUS");
    expect(lines.filter((l) => l.text.startsWith("CHANNEL SWEEP"))).toHaveLength(1);

    const measured = lines.filter((l) => l.kind === "channel");
    expect(measured.map((l) => l.text)).toEqual(["HIP_L", "KNEE_L"]);
    expect(measured[0]?.gutter).toBe("CH01");
    // The log says a channel arrived and how much of it there was. What it
    // *measured* is in the readout beside the traces (channel-readout.tsx) —
    // one number, one place.
    expect(measured[0]?.trailing).toBe(`${ref.length} SMPL`);
    expect(measured.every((l) => !/RMS/.test(l.trailing ?? ""))).toBe(true);
  });

  it("places DIVERGENCE FLAGGED immediately after its own joint's channel", () => {
    const lines = buildScanLog({
      session: session({
        channels: [healthy, failing, { ...healthy, joint: "knee_R" }],
        flag,
      }),
      link: "open",
      complete: false,
    });

    const at = lines.findIndex((l) => l.kind === "flag");
    expect(lines[at - 1]?.text).toBe("KNEE_L");
    expect(lines[at]?.text).toBe("DIVERGENCE · KNEE_L · A07 GAIN");
    // …and the scan keeps going after it.
    expect(lines[at + 1]?.text).toBe("KNEE_R");
    expect(lines.filter((l) => l.kind === "flag")).toHaveLength(1);
  });

  it("still says the flag when its channel is not in the session", () => {
    const lines = buildScanLog({
      session: session({ flag }),
      link: "open",
      complete: false,
    });
    expect(kinds(lines)).toContain("flag");
  });

  it("is a pure projection: the same session yields the same lines and the same keys", () => {
    const s = session({
      walkLines: ["/sys/core/heartbeat.svc", "/sys/actuator_bus/enumerate"],
      channels: [healthy, failing],
      flag,
    });
    const first = buildScanLog({ session: s, link: "open", complete: false });
    const second = buildScanLog({ session: s, link: "open", complete: false });

    expect(second).toEqual(first);
    // Keys are content-derived, so a replayed line reuses its row rather than
    // mounting a second one beneath it.
    const keys = first.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("w:/sys/core/heartbeat.svc");
    expect(keys).toContain("c:knee_L");
  });

  it("holds at the tail when the link drops, without discarding what arrived", () => {
    const s = session({ walkLines: ["/sys/core/heartbeat.svc"], channels: [healthy] });
    const lines = buildScanLog({ session: s, link: "lost", complete: false });

    expect(lines.at(-1)).toMatchObject({
      kind: "hold",
      text: "HOLD — LINK LOST · SEQUENCE SUSPENDED",
    });
    // Everything the scan managed to say is still on screen above the hold.
    expect(texts(lines)).toContain("/sys/core/heartbeat.svc");
    expect(texts(lines)).toContain("HIP_L");
  });

  it("distinguishes a restored link with no sequence behind it", () => {
    const lines = buildScanLog({ session: session(), link: "resumed", complete: false });
    expect(lines.at(-1)?.text).toBe("HOLD — LINK RESTORED · AWAITING SEQUENCE");
  });

  it("closes on the verdict, naming the component", () => {
    const lines = buildScanLog({
      session: session({
        channels: [failing],
        flag,
        report: {
          unitId: "N-07",
          joint: "knee_L",
          component: "actuator_A07",
          anomaly: "gain",
          summary: "…",
          recommendations: ["Disable joint"],
          ts: 1,
        },
      }),
      link: "open",
      complete: true,
    });
    expect(lines.at(-1)?.text).toBe("VERDICT LOGGED · ACTUATOR A-07");
  });
});
