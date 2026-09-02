// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { type DiagEvent, type DiagEventMessage, type VerdictReport } from "@/lib/schema";
import { useAuditStore } from "./auditStore";
import {
  selectExiting,
  selectShownPhase,
  selectShownSession,
  selectUnitHistory,
  useIncidentStore,
} from "./incidentStore";

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
  recommendations: ["Disable joint", "Command safe sit", "Dispatch service"],
  ts: 120_000,
};

const flag: DiagEvent = {
  k: "flag",
  joint: "knee_L",
  component: "actuator_A07",
  anomaly: "gain",
};

beforeEach(() => {
  useIncidentStore.getState().reset();
});

describe("incident store — the happy descent", () => {
  it("walks idle -> descending -> scanning -> verdict -> history -> idle", () => {
    const store = useIncidentStore;
    expect(store.getState().phase).toBe("idle");

    store.getState().beginDescent("N-07");
    expect(store.getState().phase).toBe("descending");
    expect(store.getState().session?.unitId).toBe("N-07");

    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    expect(store.getState().phase).toBe("scanning");

    store.getState().applyDiagEvent(ev({ k: "walk", path: "/sys/actuator_bus/scan" }));
    store.getState().applyDiagEvent(ev({ k: "walk", path: "/sys/actuator_bus/07" }));
    store
      .getState()
      .applyDiagEvent(ev({ k: "channel", joint: "hip_L", wave: [0, 1], ref: [0, 1] }));
    store
      .getState()
      .applyDiagEvent(ev({ k: "channel", joint: "knee_L", wave: [0, 2.4], ref: [0, 1] }));
    store.getState().applyDiagEvent(ev(flag));

    const session = store.getState().session!;
    expect(session.walkLines).toHaveLength(2);
    expect(session.channels.map((c) => c.joint)).toEqual(["hip_L", "knee_L"]);
    expect(session.flag?.component).toBe("actuator_A07");

    store.getState().applyDiagEvent(ev({ k: "verdict", report }));
    expect(store.getState().phase).toBe("verdict");
    expect(store.getState().session?.report?.anomaly).toBe("gain");

    store.getState().completeAscent();
    expect(store.getState().phase).toBe("idle");
    expect(store.getState().session).toBeNull();
    expect(store.getState().history).toHaveLength(1);
    expect(store.getState().history[0]).toMatchObject({ unitId: "N-07" });
    expect(selectUnitHistory("N-07")(store.getState())).toHaveLength(1);
    expect(selectUnitHistory("N-01")(store.getState())).toHaveLength(0);

    // The archive carries its own evidence: the traces the verdict was drawn
    // from, and the session clock the press times are keyed by.
    const archived = store.getState().history[0]!;
    expect(archived.channels?.map((c) => c.joint)).toEqual(["hip_L", "knee_L"]);
    expect(archived.channels?.[1]?.wave).toEqual([0, 2.4]);
    expect(archived.startedAt).toBe(session.startedAt);
  });

  it("stacks completed incidents newest first", () => {
    const store = useIncidentStore;
    for (const ts of [1000, 2000]) {
      store.getState().beginDescent("N-07");
      store.getState().applyDiagEvent(ev({ k: "scan_start" }));
      store.getState().applyDiagEvent(ev({ k: "verdict", report: { ...report, ts } }));
      store.getState().completeAscent();
    }
    expect(store.getState().history.map((r) => r.report.ts)).toEqual([2000, 1000]);
  });
});

describe("incident store — guarded transitions", () => {
  it("ignores scan events while idle (walk/channel/flag/verdict need a session)", () => {
    const store = useIncidentStore;
    store.getState().applyDiagEvent(ev({ k: "walk", path: "/x" }));
    store.getState().applyDiagEvent(ev({ k: "verdict", report }));
    expect(store.getState().phase).toBe("idle");
    expect(store.getState().session).toBeNull();
    expect(store.getState().history).toHaveLength(0);
  });

  it("adopts an in-flight scan if scan_start arrives while idle (refresh mid-scan)", () => {
    const store = useIncidentStore;
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    expect(store.getState().phase).toBe("scanning");
    expect(store.getState().session?.unitId).toBe("N-07");
  });

  it("ignores events for a different unit than the session's", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }, "N-03"));
    expect(store.getState().phase).toBe("descending");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    store.getState().applyDiagEvent(ev({ k: "walk", path: "/other" }, "N-03"));
    expect(store.getState().session?.walkLines).toEqual([]);
  });

  it("ignores beginDescent when a session is already active", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().beginDescent("N-03");
    expect(store.getState().session?.unitId).toBe("N-07");
  });

  it("ignores a verdict before scanning and completeAscent before verdict", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "verdict", report })); // still descending
    expect(store.getState().phase).toBe("descending");
    store.getState().completeAscent();
    expect(store.getState().phase).toBe("descending");
    expect(store.getState().history).toHaveLength(0);
  });

  it("abortSession returns to idle from any active phase without archiving", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    store.getState().applyDiagEvent(ev({ k: "walk", path: "/x" }));
    store.getState().abortSession(); // mid-scan disconnect
    expect(store.getState().phase).toBe("idle");
    expect(store.getState().session).toBeNull();
    expect(store.getState().history).toHaveLength(0);
  });
});

/**
 * DoD: a scan that loses its link mid-sweep and gets the whole
 * emitted prefix re-sent on reconnect must render the same log and the same
 * board it had before the blip — not two of everything.
 */
describe("incident store — replayed prefix on reconnect", () => {
  const channel = (joint: string, gain = 1): DiagEvent => ({
    k: "channel",
    joint,
    wave: [0.1 * gain, 0.2 * gain, 0.3 * gain],
    ref: [0.1, 0.2, 0.3],
  });

  /** What sim/server.ts sends a joining socket: scan_start, then the prefix. */
  const prefix: DiagEvent[] = [
    { k: "scan_start" },
    { k: "walk", path: "/sys/core/heartbeat.svc" },
    { k: "walk", path: "/sys/actuator_bus/enumerate" },
    channel("hip_L"),
    channel("knee_L", 1.6),
    flag,
  ];

  const play = (events: DiagEvent[]) => {
    for (const e of events) useIncidentStore.getState().applyDiagEvent(ev(e));
  };

  it("admits each walk line and channel exactly once across a full re-send", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    play(prefix);

    const before = store.getState().session;
    expect(before?.walkLines).toHaveLength(2);
    expect(before?.channels).toHaveLength(2);

    play(prefix); // the reconnect replay

    const after = store.getState().session;
    expect(after?.walkLines).toEqual([
      "/sys/core/heartbeat.svc",
      "/sys/actuator_bus/enumerate",
    ]);
    expect(after?.channels.map((c) => c.joint)).toEqual(["hip_L", "knee_L"]);
    expect(after?.flag).toEqual(flag);
    // Nothing changed, so nothing re-rendered: the session keeps its identity.
    expect(after).toBe(before);
  });

  it("keeps the first payload for a channel rather than the replayed copy", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    play([{ k: "scan_start" }, channel("knee_L", 1.6)]);
    play([channel("knee_L", 9)]); // a redelivery cannot rewrite the evidence
    const kept = channel("knee_L", 1.6);
    expect(store.getState().session?.channels[0]?.wave).toEqual(
      kept.k === "channel" ? kept.wave : [],
    );
  });

  it("resumes the live scan after the replay, appending only what is new", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    play(prefix);
    play(prefix);
    play([channel("knee_R"), { k: "verdict", report }]);

    expect(store.getState().phase).toBe("verdict");
    expect(store.getState().session?.channels.map((c) => c.joint)).toEqual([
      "hip_L",
      "knee_L",
      "knee_R",
    ]);
  });

  it("reconstructs a scan joined late from the prefix alone (page refresh)", () => {
    const store = useIncidentStore;
    play(prefix); // no beginDescent: this console was not the one that started it
    expect(store.getState().phase).toBe("scanning");
    expect(store.getState().session?.walkLines).toHaveLength(2);
    expect(store.getState().session?.channels).toHaveLength(2);
    expect(store.getState().session?.flag).toEqual(flag);
  });
});

/**
 * the verdict card's three actions are acknowledgements, and the
 * incident record is where they are kept.
 */
describe("incident store — acknowledged recommendations", () => {
  const toVerdict = () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    store.getState().applyDiagEvent(ev({ k: "verdict", report }));
  };

  it("records each action once, in press order, and archives them with the incident", () => {
    const store = useIncidentStore;
    toVerdict();

    store.getState().acknowledgeRecommendation("Dispatch service");
    store.getState().acknowledgeRecommendation("Disable joint");
    store.getState().acknowledgeRecommendation("Dispatch service"); // pressed twice
    expect(store.getState().session?.acknowledged).toEqual([
      "Dispatch service",
      "Disable joint",
    ]);

    store.getState().completeAscent();
    expect(selectUnitHistory("N-07")(store.getState())[0]?.acknowledged).toEqual([
      "Dispatch service",
      "Disable joint",
    ]);
  });

  it("ignores acknowledgements outside the verdict phase", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    store.getState().acknowledgeRecommendation("Disable joint");
    expect(store.getState().session?.acknowledged).toEqual([]);
  });
});

/**
 * leaving machine space is not ending the scan.
 *
 * The console gained a CLOSE control that ascends mid-scan, and the property
 * that makes it safe is that `watching` and `phase` are independent: a scan
 * nobody is looking at is still scanning, still accumulating, and still the
 * same session when the operator comes back. The failure this guards against
 * is the obvious implementation — wiring CLOSE to `abortSession` — which looks
 * identical for the first frame and then quietly throws away a diagnostic the
 * sim is still running.
 */
describe("incident store — leaving and re-entering a live session", () => {
  it("keeps the session, its identity and its events across a leave", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    expect(store.getState().watching).toBe(true);
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    store.getState().applyDiagEvent(ev({ k: "walk", path: "/sys/core/heartbeat.svc" }));
    const startedAt = store.getState().session?.startedAt;

    store.getState().leaveSession();
    expect(store.getState().watching).toBe(false);
    // Everything else is exactly as it was.
    expect(store.getState().phase).toBe("scanning");
    expect(store.getState().session?.walkLines).toEqual(["/sys/core/heartbeat.svc"]);
    expect(store.getState().session?.startedAt).toBe(startedAt);

    // …and the scan goes on without an audience.
    store
      .getState()
      .applyDiagEvent(ev({ k: "walk", path: "/sys/core/power_rail/v48_main" }));
    store
      .getState()
      .applyDiagEvent(ev({ k: "channel", joint: "hip_L", wave: [0, 1], ref: [0, 1] }));
    expect(store.getState().session?.walkLines).toHaveLength(2);
    expect(store.getState().session?.channels).toHaveLength(1);

    store.getState().watchSession();
    expect(store.getState().watching).toBe(true);
    // The board the operator comes back to is the one the scan built while
    // they were away — same session object identity for the id and the clock.
    expect(store.getState().session?.startedAt).toBe(startedAt);
    expect(store.getState().session?.walkLines).toHaveLength(2);
  });

  it("lets the verdict land on a session nobody is watching", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    store.getState().leaveSession();

    store.getState().applyDiagEvent(ev({ k: "verdict", report }));
    expect(store.getState().phase).toBe("verdict");
    expect(store.getState().watching).toBe(false);
    // Nothing is archived until someone returns with it — the incident record
    // is written by the ascent, not by the verdict arriving.
    expect(store.getState().history).toHaveLength(0);

    store.getState().watchSession();
    store.getState().completeAscent();
    expect(store.getState().history).toHaveLength(1);
    expect(store.getState().watching).toBe(false);
  });

  it("never leaves `watching` true without a session behind it", () => {
    const store = useIncidentStore;
    // Idle: neither action invents a session to watch.
    store.getState().watchSession();
    store.getState().leaveSession();
    expect(store.getState().watching).toBe(false);

    store.getState().beginDescent("N-07");
    store.getState().abortSession();
    expect(store.getState().watching).toBe(false);
    expect(store.getState().session).toBeNull();
  });

  it("puts an adopted scan on screen — a mid-scan reload is watching by definition", () => {
    const store = useIncidentStore;
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    expect(store.getState().phase).toBe("scanning");
    expect(store.getState().watching).toBe(true);
  });
});

/**
 * the departing session, modelled once.
 *
 * `completeAscent()` and `abortSession()` null the live fields in the same
 * commit that starts an animation the surface has to outlive, so for ~250 ms
 * there are two right answers to "what scan is this". `exiting` is the second
 * one, and the whole point of putting it here rather than in a ref per surface
 * is that it can be reasoned about in one place — which also means it is the
 * one thing in this store that can be *stranded*, and every test below is
 * either about what it holds or about who is obliged to let it go.
 */
describe("incident store — the departing session", () => {
  const toVerdict = () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    store.getState().applyDiagEvent(ev({ k: "walk", path: "/sys/core/heartbeat.svc" }));
    store.getState().applyDiagEvent(ev(flag));
    store.getState().applyDiagEvent(ev({ k: "verdict", report }));
  };

  it("snapshots the session and its phase when the ascent archives it", () => {
    const store = useIncidentStore;
    toVerdict();
    const live = store.getState().session!;

    store.getState().completeAscent();

    // The live fields are exactly as empty as they always were…
    expect(store.getState().phase).toBe("idle");
    expect(store.getState().session).toBeNull();
    expect(store.getState().watching).toBe(false);
    expect(store.getState().history).toHaveLength(1);

    // …and the surface still has the scan it is leaving with, by identity, in
    // the phase it ended in — not "idle", which would print SCANNING on the way
    // out, and not a copy, which would re-render every panel subscribed to it.
    expect(store.getState().exiting).toEqual({ session: live, phase: "verdict" });
    expect(store.getState().exiting?.session).toBe(live);
  });

  it("reads through the snapshot for the shown session and phase only", () => {
    const store = useIncidentStore;
    toVerdict();
    const live = store.getState().session!;

    // While the session is live the two selectors are the live ones.
    expect(selectShownSession(store.getState())).toBe(live);
    expect(selectShownPhase(store.getState())).toBe("verdict");
    expect(selectExiting(store.getState())).toBe(false);

    store.getState().completeAscent();
    expect(selectShownSession(store.getState())).toBe(live);
    expect(selectShownPhase(store.getState())).toBe("verdict");
    expect(selectExiting(store.getState())).toBe(true);

    store.getState().dismissExit();
    expect(selectShownSession(store.getState())).toBeNull();
    expect(selectShownPhase(store.getState())).toBe("idle");
    expect(selectExiting(store.getState())).toBe(false);
    // Idempotent: both callers of it fire unconditionally.
    store.getState().dismissExit();
    expect(store.getState().exiting).toBeNull();
  });

  it("snapshots an abort too, in the phase it aborted from", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    const live = store.getState().session!;

    store.getState().abortSession();
    expect(store.getState().session).toBeNull();
    expect(store.getState().exiting).toEqual({ session: live, phase: "scanning" });
    expect(store.getState().history).toHaveLength(0);
  });

  /**
   * Audit 1. Mid-scan CLOSE is the operator looking away, not the session
   * ending: the scan is still in the store, still accumulating, and a surface
   * animating its way out renders it *live*. A snapshot here would freeze a
   * scan that is still happening, which is a lie in the other direction.
   */
  it("writes nothing on leaveSession — the session is still alive", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));

    store.getState().leaveSession();
    expect(store.getState().exiting).toBeNull();
    expect(store.getState().phase).toBe("scanning");

    // …and the shown session stays the live one, right through the exit, as
    // more of the scan lands.
    store.getState().applyDiagEvent(ev({ k: "walk", path: "/sys/core/power_rail" }));
    expect(selectShownSession(store.getState())?.walkLines).toEqual([
      "/sys/core/power_rail",
    ]);
    expect(selectShownPhase(store.getState())).toBe("scanning");
  });

  /**
   * Audit 3, half of it. A snapshot nobody is showing can never be cleared by a
   * surface, because there is no surface — so it is never written. These are
   * the transitions that end a session with the stage down.
   */
  it("writes nothing when no surface is showing the session", () => {
    const store = useIncidentStore;

    // Aborted during `descending`: the stage mounts on `scanning`, so nothing
    // was ever on screen to animate out.
    store.getState().beginDescent("N-07");
    store.getState().abortSession();
    expect(store.getState().exiting).toBeNull();

    // Aborted after the operator left the scan: same, one step later.
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    store.getState().leaveSession();
    store.getState().abortSession();
    expect(store.getState().exiting).toBeNull();

    // Archived from a page the operator was not watching (the verdict landed
    // while they were away, and they returned with it from the banner).
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    store.getState().applyDiagEvent(ev({ k: "verdict", report }));
    store.getState().leaveSession();
    store.getState().completeAscent();
    expect(store.getState().history).toHaveLength(1);
    expect(store.getState().exiting).toBeNull();
  });

  /**
   * Audit 3, the other half: every entry point that opens or re-enters a
   * session collects the snapshot on the way in. A new session is never a
   * departing one, and a store field — unlike the ref this replaced — does not
   * die with the component that stopped needing it.
   */
  describe("every entry point clears it", () => {
    const strand = () => {
      const store = useIncidentStore;
      store.getState().beginDescent("N-07");
      store.getState().applyDiagEvent(ev({ k: "scan_start" }));
      store.getState().abortSession();
      expect(store.getState().exiting).not.toBeNull();
    };

    it("beginDescent", () => {
      strand();
      useIncidentStore.getState().beginDescent("N-03");
      expect(useIncidentStore.getState().exiting).toBeNull();
      expect(selectShownSession(useIncidentStore.getState())?.unitId).toBe("N-03");
    });

    it("an adopted scan_start", () => {
      strand();
      useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" }, "N-03"));
      expect(useIncidentStore.getState().exiting).toBeNull();
      expect(selectShownSession(useIncidentStore.getState())?.unitId).toBe("N-03");
    });

    it("watchSession", () => {
      const store = useIncidentStore;
      // A live session the operator has stepped out of, with a stale snapshot
      // from an earlier exit still standing.
      store.getState().beginDescent("N-07");
      store.getState().applyDiagEvent(ev({ k: "scan_start" }));
      store.getState().leaveSession();
      store.setState({ exiting: { session: freshLike(), phase: "verdict" } });

      store.getState().watchSession();
      expect(store.getState().watching).toBe(true);
      expect(store.getState().exiting).toBeNull();
    });

    it("reset", () => {
      strand();
      useIncidentStore.getState().reset();
      expect(useIncidentStore.getState().exiting).toBeNull();
    });
  });

  /** A session shaped like any other, for the stale-snapshot cases above. */
  function freshLike() {
    return {
      unitId: "N-01",
      startedAt: 1,
      walkLines: [],
      channels: [],
      flag: null,
      report: null,
      acknowledged: [],
      calibration: null,
    };
  }
});

describe("incident store — audit trail", () => {
  beforeEach(() => {
    useAuditStore.getState().reset();
  });

  it("logs diag-start once per scan and the verdict with its future incident id", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    store.getState().applyDiagEvent(ev({ k: "scan_start" })); // replay: reducer ignores, no log
    store.getState().applyDiagEvent(ev({ k: "verdict", report }));

    const entries = useAuditStore.getState().entries;
    expect(entries.map((e) => e.kind)).toEqual(["diag-verdict", "diag-start"]);
    expect(entries[1]).toMatchObject({
      unitId: "N-07",
      summary: "Diagnostic scan started",
    });
    // ref pre-computes the history record id completeAscent will mint
    expect(entries[0]).toMatchObject({
      unitId: "N-07",
      summary: report.summary,
      ref: "inc-N-07-120000",
      ts: 120_000,
    });
    store.getState().completeAscent();
    expect(store.getState().history[0]!.id).toBe("inc-N-07-120000");
  });

  it("logs an adopted scan too — a mid-scan reload still gets a session log", () => {
    useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" }));
    const entries = useAuditStore.getState().entries;
    expect(entries.map((e) => e.kind)).toEqual(["diag-start"]);
  });

  it("logs nothing for walk/channel/flag narration or off-script events", () => {
    const store = useIncidentStore;
    store.getState().beginDescent("N-07");
    store.getState().applyDiagEvent(ev({ k: "scan_start" }));
    useAuditStore.getState().reset();
    store.getState().applyDiagEvent(ev({ k: "walk", path: "/sys/core/heartbeat.svc" }));
    store
      .getState()
      .applyDiagEvent(ev({ k: "channel", joint: "hip_L", wave: [0], ref: [0] }));
    store.getState().applyDiagEvent(ev(flag));
    store.getState().applyDiagEvent(ev({ k: "verdict", report }, "N-03")); // wrong unit
    expect(useAuditStore.getState().entries).toEqual([]);
  });
});

/**
 * The one diag event that belongs to a scan that is already over, and the
 * one that can rewrite a filed report's conclusion.
 */
describe("incident store — the recalibration gate", () => {
  const toVerdict = () => {
    const s = useIncidentStore.getState();
    s.beginDescent("N-07");
    s.applyDiagEvent(ev({ k: "scan_start" }));
    s.applyDiagEvent(ev({ k: "channel", joint: "knee_L", wave: [1, 2], ref: [1, 2] }));
    s.applyDiagEvent(ev({ k: "verdict", report }));
    useAuditStore.getState().reset();
  };

  const remeasure = (joint: string): DiagEvent => ({
    k: "recalibration",
    joint,
    wave: [1, 2],
    ref: [1, 2],
    outcome: "cleared",
  });

  it("admits a re-measure of the joint the verdict flagged", () => {
    toVerdict();
    useIncidentStore.getState().applyDiagEvent(ev(remeasure("knee_L")));
    expect(useIncidentStore.getState().session?.calibration?.joint).toBe("knee_L");
    expect(useAuditStore.getState().entries.map((e) => e.kind)).toEqual([
      "diag-recalibrated",
    ]);
  });

  it("drops a re-measure of a joint this verdict never flagged", () => {
    // The report says knee_L. A calibration of knee_R admitted here would put
    // "the fault cleared without a visit" over an exhibit of the untouched
    // original — the record would be a claim about a different actuator.
    toVerdict();
    useIncidentStore.getState().applyDiagEvent(ev(remeasure("knee_R")));
    expect(useIncidentStore.getState().session?.calibration).toBeNull();
    expect(useAuditStore.getState().entries).toEqual([]);

    // …and the record it archives says nobody tried the cheap rung, which is
    // what actually happened to this joint.
    useIncidentStore.getState().completeAscent();
    expect(useIncidentStore.getState().history[0]?.calibration).toBeUndefined();
  });
});
