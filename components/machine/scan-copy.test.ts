// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  anomalyDifferential,
  elapsedLabel,
  machineComponent,
  machineJoint,
  scanPhaseWord,
  scanStatusLine,
  sessionTag,
  verdictChipLabel,
  type ScanProgress,
} from "./scan-copy";
import { type VerdictReport } from "@/lib/schema";

/**
 * The machine's voice is a design surface, so it gets asserted like one. The
 * rule under every case here: the status line may never claim progress the
 * session has not actually received, and a held link outranks whatever the
 * numbers said a moment ago.
 */

const progress = (over: Partial<ScanProgress> = {}): ScanProgress => ({
  walked: 0,
  channels: 0,
  flagged: false,
  hasVerdict: false,
  ...over,
});

describe("machine vocabulary", () => {
  it("keeps wire names as wire names", () => {
    expect(machineJoint("knee_L")).toBe("KNEE_L");
  });

  it("renders component ids the way the verdict headline says them", () => {
    expect(machineComponent("actuator_A07")).toBe("ACTUATOR A-07");
  });

  it("collapses the verdict to the three facts that decide whether to reopen it", () => {
    const report: VerdictReport = {
      unitId: "N-07",
      joint: "knee_L",
      component: "actuator_A07",
      anomaly: "gain",
      summary: "LEFT KNEE ACTUATOR A-07: GAIN ANOMALY.",
      recommendations: ["Dispatch service"],
      ts: 120_000,
    };
    expect(verdictChipLabel(report)).toBe("VERDICT · KNEE_L · A-07 GAIN");
  });

  it("keeps a component's full name when its tail is not a part number", () => {
    const report: VerdictReport = {
      unitId: "N-07",
      joint: "spine",
      component: "spine_bus",
      anomaly: "noise",
      summary: "SPINE BUS: NOISE.",
      recommendations: [],
      ts: 1,
    };
    // Shortening SPINE BUS to BUS would trade a fact for four characters.
    expect(verdictChipLabel(report)).toBe("VERDICT · SPINE · SPINE BUS NOISE");
  });

  it("does not name a part on a clean scan", () => {
    const report: VerdictReport = {
      unitId: "N-07",
      joint: "all",
      component: "all",
      anomaly: "none",
      summary: "NO ANOMALY DETECTED.",
      recommendations: ["No action required"],
      ts: 1,
    };
    expect(verdictChipLabel(report)).toBe("VERDICT · NO ANOMALY");
  });

  it("counts elapsed time from zero, in minutes and seconds", () => {
    expect(elapsedLabel(0)).toBe("T+00:00");
    expect(elapsedLabel(7_400)).toBe("T+00:07");
    expect(elapsedLabel(83_000)).toBe("T+01:23");
    expect(elapsedLabel(-5)).toBe("T+00:00");
  });

  it("tags a session deterministically, and differently per scan", () => {
    expect(sessionTag("N-07", 1000)).toBe(sessionTag("N-07", 1000));
    expect(sessionTag("N-07", 1000)).not.toBe(sessionTag("N-07", 2000));
    expect(sessionTag("N-07", 1000)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it("frames a gain verdict as a hypothesis with a differential", () => {
    // the scan measured a signature; it did not open the knee. The
    // line under the headline lists what produces that signature.
    expect(anomalyDifferential("gain")).toBe(
      "CONSISTENT WITH GAIN DRIFT · TENDON WEAR · ACTUATOR DEGRADATION",
    );
  });

  it("improvises no differential for anomalies it has no table for", () => {
    // The machine lists what it knows or says nothing — and the healthy
    // verdict never shows one ("none" is deliberately not a key).
    expect(anomalyDifferential("none")).toBeNull();
    expect(anomalyDifferential("noise")).toBeNull();
  });
});

describe("scanStatusLine", () => {
  it("opens by admitting it has nothing yet", () => {
    expect(scanStatusLine(progress(), "open", "scanning")).toBe(
      "INITIALISING SCAN · AWAITING SUBSYSTEM TREE",
    );
  });

  it("counts walked nodes without inventing a total it cannot know", () => {
    expect(scanStatusLine(progress({ walked: 7 }), "open", "scanning")).toBe(
      "WALKING SUBSYSTEM TREE · NODE 07",
    );
  });

  it("counts channels against the six a leg has", () => {
    expect(
      scanStatusLine(progress({ walked: 20, channels: 3 }), "open", "scanning"),
    ).toBe("SCANNING ACTUATOR BUS · CHANNEL 03/06");
  });

  it("carries the divergence forward once it has been flagged", () => {
    expect(
      scanStatusLine(progress({ channels: 4, flagged: true }), "open", "scanning"),
    ).toBe("SCANNING ACTUATOR BUS · CHANNEL 04/06 · DIVERGENCE HELD");
  });

  it("summarises the finished scan by what it found", () => {
    expect(
      scanStatusLine(
        progress({ channels: 6, flagged: true, hasVerdict: true }),
        "open",
        "verdict",
      ),
    ).toBe("SCAN COMPLETE · 06 CHANNELS · 01 ANOMALY");
    expect(
      scanStatusLine(progress({ channels: 6, hasVerdict: true }), "open", "verdict"),
    ).toBe("SCAN COMPLETE · 06 CHANNELS · NO ANOMALY");
  });

  it("says what became of the anomaly once the machine has re-measured it", () => {
    // The count does not move — one was found, one is on the record — and the
    // last line of chrome on the surface stops disagreeing with the board.
    expect(
      scanStatusLine(
        progress({ channels: 6, flagged: true, hasVerdict: true, cleared: true }),
        "open",
        "verdict",
      ),
    ).toBe("SCAN COMPLETE · 06 CHANNELS · 01 ANOMALY CLEARED");
  });

  it("lets a held link outrank progress, in every phase", () => {
    // The count is still true about what arrived and completely misleading
    // about what is happening, so it does not get said.
    expect(scanStatusLine(progress({ channels: 3 }), "lost", "scanning")).toBe(
      "HOLD · LINK LOST · SESSION RETAINED",
    );
    expect(scanStatusLine(progress({ channels: 6 }), "resumed", "verdict")).toBe(
      "HOLD · LINK RESTORED · AWAITING SEQUENCE",
    );
  });
});

describe("scanPhaseWord", () => {
  it("names the phase, unless the link is what matters", () => {
    expect(scanPhaseWord("open", "scanning")).toBe("SCANNING");
    expect(scanPhaseWord("open", "verdict")).toBe("VERDICT");
    expect(scanPhaseWord("lost", "scanning")).toBe("HOLD");
    expect(scanPhaseWord("resumed", "verdict")).toBe("HOLD");
  });

  it("prints the newest true word once the correction has landed", () => {
    // CLEARED displaces VERDICT rather than qualifying it: by then the verdict
    // is the older fact. A partial deliberately leaves VERDICT (and with it the
    // header's amber) standing — the fault is still there.
    expect(scanPhaseWord("open", "verdict", true)).toBe("CLEARED");
    expect(scanPhaseWord("open", "verdict", false)).toBe("VERDICT");
    // The link still outranks everything: a cleared channel on a dead socket is
    // a claim the console cannot currently stand behind.
    expect(scanPhaseWord("lost", "verdict", true)).toBe("HOLD");
  });
});
