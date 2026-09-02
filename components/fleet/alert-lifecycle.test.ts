import { describe, expect, it } from "vitest";
import { type Alert } from "@/lib/schema";
import { type AlertMeta } from "@/lib/stores";
import {
  clockTime,
  deriveAlertViews,
  durationSince,
  formatDuration,
  isOpen,
  resolutionVia,
} from "./alert-lifecycle";

/**
 * Escalation is the interesting half of this file. It is the one fact in the
 * alert lifecycle that no single row can see — the store deliberately stores no
 * flag for it, because a red landing on a unit that already had an amber IS the
 * escalation — so the pairing has to be right here or the feed tells a story
 * that did not happen.
 */

const BASE = 1_700_000_000_000;

/** Newest first, as the store keeps the feed. */
function feed(...alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => b.ts - a.ts);
}

function alert(over: Partial<Alert> & Pick<Alert, "id">): Alert {
  return {
    unitId: "N-07",
    severity: "amber",
    message: "Sagebrush House: left knee actuator running hot",
    ts: BASE,
    ...over,
  };
}

describe("deriveAlertViews — escalation pairing", () => {
  it("pairs a red with the amber it took over on the same unit", () => {
    const amber = alert({ id: "al-001", ts: BASE });
    const red = alert({ id: "al-002", ts: BASE + 40_000, severity: "red" });

    const [newest, oldest] = deriveAlertViews(feed(amber, red), {});

    expect(newest?.alert.id).toBe("al-002");
    expect(newest?.escalatedFrom).toBe(amber.ts);
    expect(newest?.escalated).toBe(false);

    expect(oldest?.escalated).toBe(true);
    expect(oldest?.escalatedFrom).toBeUndefined();
  });

  it("claims no ancestry for a red that arrived on a quiet unit", () => {
    const red = alert({ id: "al-002", severity: "red", ts: BASE + 40_000 });
    const [view] = deriveAlertViews(feed(red), {});
    expect(view?.escalatedFrom).toBeUndefined();
    expect(view?.escalated).toBe(false);
  });

  it("does not pair across units — two houses are two situations", () => {
    const amber = alert({ id: "al-001", unitId: "N-03" });
    const red = alert({
      id: "al-002",
      unitId: "N-07",
      severity: "red",
      ts: BASE + 5_000,
    });

    const views = deriveAlertViews(feed(amber, red), {});
    expect(views.find((v) => v.alert.id === "al-002")?.escalatedFrom).toBeUndefined();
    expect(views.find((v) => v.alert.id === "al-001")?.escalated).toBe(false);
  });

  it("spends each amber once, so two escalations read as two", () => {
    const first = alert({ id: "al-001", ts: BASE });
    const second = alert({ id: "al-002", ts: BASE + 1_000 });
    const redA = alert({ id: "al-003", severity: "red", ts: BASE + 2_000 });
    const redB = alert({ id: "al-004", severity: "red", ts: BASE + 3_000 });

    const views = deriveAlertViews(feed(first, second, redA, redB), {});
    const byId = new Map(views.map((v) => [v.alert.id, v]));

    // The newest standing amber is taken first, so the pairing nests rather
    // than crossing: both reds cite a different amber and neither is doubled.
    expect(byId.get("al-003")?.escalatedFrom).toBe(second.ts);
    expect(byId.get("al-004")?.escalatedFrom).toBe(first.ts);
    expect(byId.get("al-001")?.escalated).toBe(true);
    expect(byId.get("al-002")?.escalated).toBe(true);
  });

  it("never pairs a red with an amber that arrived after it", () => {
    const red = alert({ id: "al-001", severity: "red", ts: BASE });
    const amber = alert({ id: "al-002", ts: BASE + 10_000 });

    const views = deriveAlertViews(feed(red, amber), {});
    expect(views.find((v) => v.alert.id === "al-001")?.escalatedFrom).toBeUndefined();
    expect(views.find((v) => v.alert.id === "al-002")?.escalated).toBe(false);
  });
});

describe("deriveAlertViews — lifecycle", () => {
  const meta = (m: AlertMeta): Record<string, AlertMeta> => ({ "al-001": m });

  it("is open until someone touches it", () => {
    const [view] = deriveAlertViews(feed(alert({ id: "al-001" })), {});
    expect(view?.lifecycle).toBe("open");
    expect(isOpen(view!)).toBe(true);
  });

  it("reads acked from the store's own record, operator and all", () => {
    const views = deriveAlertViews(
      feed(alert({ id: "al-001" })),
      meta({ ackedAt: BASE + 1_000, ackedBy: "Operator" }),
    );
    expect(views[0]?.lifecycle).toBe("acked");
    expect(views[0]?.meta?.ackedBy).toBe("Operator");
  });

  it("counts an acked alert as still open — ownership is not closure", () => {
    const views = deriveAlertViews(
      feed(alert({ id: "al-001" })),
      meta({ ackedAt: BASE }),
    );
    expect(isOpen(views[0]!)).toBe(true);
  });

  it("lets resolution win over ack, whatever order they landed in", () => {
    const views = deriveAlertViews(
      feed(alert({ id: "al-001" })),
      meta({
        ackedAt: BASE + 1_000,
        resolvedAt: BASE + 2_000,
        resolution: { via: "incident", ref: "inc-N-07-1" },
      }),
    );
    expect(views[0]?.lifecycle).toBe("resolved");
    expect(isOpen(views[0]!)).toBe(false);
  });
});

describe("formatDuration", () => {
  it("counts seconds bare under a minute", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42_000)).toBe("42s");
  });

  it("pads below the leading unit so a ticking row keeps its width", () => {
    expect(formatDuration(67_000)).toBe("1m 07s");
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(3_840_000)).toBe("1h 04m");
  });

  it("drops seconds past an hour, where they are noise", () => {
    expect(formatDuration(7_200_000)).toBe("2h 00m");
  });

  it("never counts backwards from a clock that disagrees", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("durationSince", () => {
  it("says nothing before the client clock has started", () => {
    expect(durationSince(BASE, 0)).toBeNull();
  });

  it("says nothing about an alert with no timestamp", () => {
    expect(durationSince(undefined, BASE)).toBeNull();
  });

  it("is now minus then", () => {
    expect(durationSince(BASE, BASE + 134_000)).toBe("2m 14s");
  });
});

describe("clockTime", () => {
  it("is 24 hour and includes the second — a record, not a relative label", () => {
    expect(clockTime(BASE)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("resolutionVia", () => {
  it("says what closed it in operator words, not store enums", () => {
    expect(resolutionVia({ via: "incident", ref: "inc-N-07-1" })).toBe("diagnostic");
    expect(resolutionVia({ via: "safe-sit", ref: "COMMAND_SAFE_SIT#3" })).toBe(
      "safe sit",
    );
    expect(resolutionVia({ via: "operator" })).toBe("operator");
    expect(resolutionVia(undefined)).toBe("operator");
  });

  it("credits the robot when the unit resolved its own alert", () => {
    // The N-03 blocked-navigation storyline: nobody in the room did this, and
    // the row must not imply an operator.
    expect(resolutionVia({ via: "self-recovery" })).toBe("self-recovered");
  });
});
