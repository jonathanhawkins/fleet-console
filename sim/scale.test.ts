// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  fleetMessageSchema,
  unitIdSchema,
  type FleetMessage,
  type TelemetryMessage,
} from "@/lib/schema";
import {
  createSimEngine,
  FLEET_UNITS,
  GEN_REGION,
  INCIDENT_UNIT_ID,
  MAX_UNIT_COUNT,
  MIN_UNIT_COUNT,
} from "./engine";

/**
 * (d): the SIM_UNITS / NEXT_PUBLIC_SIM_UNITS scale knob. Generation
 * is deterministic, the core eight (and N-07's storyline) survive any fleet
 * size byte-for-byte, and the 500-unit snapshot stays a sane payload.
 */

const FAST = { onsetMs: 300, amberAtMs: 600, redAtMs: 900 };

const isTelemetry = (m: FleetMessage): m is TelemetryMessage => m.t === "telemetry";

describe("fleet scale — deterministic 500-unit generation", () => {
  const snap500 = createSimEngine({ seed: 7, unitCount: 500 }).snapshot();

  it("generates exactly 500 units, the core eight first and untouched", () => {
    expect(snap500.units).toHaveLength(500);
    expect(snap500.units.slice(0, 8).map((u) => u.id)).toEqual(
      FLEET_UNITS.map((u) => u.id),
    );
    for (const [i, u] of FLEET_UNITS.entries()) {
      expect(snap500.units[i]).toMatchObject({ id: u.id, name: u.name, pos: u.pos });
    }
    expect(snap500.units[6]).toMatchObject({
      id: INCIDENT_UNIT_ID,
      name: "Elm House",
    });
  });

  it("gives generated units schema-valid three-digit ids N-009…N-500", () => {
    expect(snap500.units[8]!.id).toBe("N-009");
    expect(snap500.units.at(-1)!.id).toBe("N-500");
    for (const u of snap500.units) expect(() => unitIdSchema.parse(u.id)).not.toThrow();
    // and the whole snapshot passes the wire contract
    expect(() => fleetMessageSchema.parse(snap500)).not.toThrow();
  });

  it("keeps every generated name unique and every generated home inside the Peninsula region box", () => {
    const names = snap500.units.map((u) => u.name);
    expect(new Set(names).size).toBe(names.length);
    for (const u of snap500.units.slice(8)) {
      expect(u.pos.lat).toBeGreaterThanOrEqual(GEN_REGION.latMin);
      expect(u.pos.lat).toBeLessThanOrEqual(GEN_REGION.latMax);
      expect(u.pos.lng).toBeGreaterThanOrEqual(GEN_REGION.lngMin);
      expect(u.pos.lng).toBeLessThanOrEqual(GEN_REGION.lngMax);
    }
    // grid-jitter, not a lattice: a pure grid would have exactly one lat per
    // row (22 of them); the jitter spreads the 492 homes over hundreds
    // (4-decimal rounding makes a few collide — that's fine).
    const lats = new Set(snap500.units.slice(8).map((u) => u.pos.lat));
    expect(lats.size).toBeGreaterThan(300);
  });

  it("is a pure function of the seed: same seed identical, another seed different", () => {
    const again = createSimEngine({ seed: 7, unitCount: 500 }).snapshot();
    expect(JSON.stringify(again)).toBe(JSON.stringify(snap500));
    const other = createSimEngine({ seed: 8, unitCount: 500 }).snapshot();
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(snap500));
  });

  it("clamps unitCount to [8, 500] and uses two-digit ids for sub-100 fleets", () => {
    expect(MIN_UNIT_COUNT).toBe(8);
    expect(MAX_UNIT_COUNT).toBe(500);
    expect(createSimEngine({ unitCount: 3 }).snapshot().units).toHaveLength(8);
    expect(createSimEngine({ unitCount: 10_000 }).snapshot().units).toHaveLength(500);
    const snap42 = createSimEngine({ seed: 7, unitCount: 42 }).snapshot();
    expect(snap42.units[8]!.id).toBe("N-09");
    expect(snap42.units.at(-1)!.id).toBe("N-42");
  });

  it("keeps the 500-unit snapshot payload sane (measured, < 96 KB)", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(snap500)).length;
    expect(bytes).toBeLessThan(96_000);
    expect(bytes).toBeGreaterThan(30_000); // and it IS 500 real units, not a stub
  });
});

describe("fleet scale — the eight-unit story survives at 500", () => {
  it("emits byte-identical N-01…N-08 telemetry at 8 units and at 500 (same seed)", () => {
    const run = (unitCount: number) => {
      const engine = createSimEngine({ seed: 7, timeline: FAST, unitCount });
      const out: FleetMessage[] = [];
      for (let t = 100; t <= 1000; t += 100) out.push(...engine.advance(t));
      return out;
    };
    const coreIds = new Set(FLEET_UNITS.map((u) => u.id));
    const core = (msgs: FleetMessage[]) =>
      msgs.filter((m) => !isTelemetry(m) || coreIds.has(m.unitId));
    expect(JSON.stringify(core(run(500)))).toBe(JSON.stringify(core(run(8))));
  });

  it("plays N-07's incident on schedule in a 500-unit fleet", () => {
    const engine = createSimEngine({ seed: 7, timeline: FAST, unitCount: 500 });
    const msgs: FleetMessage[] = [];
    for (let t = 100; t <= 1000; t += 100) msgs.push(...engine.advance(t));
    const alerts = msgs.filter((m) => m.t === "alert");
    expect(alerts.map((m) => m.alert.severity)).toEqual(["amber", "red"]);
    expect(alerts.every((m) => m.alert.unitId === INCIDENT_UNIT_ID)).toBe(true);
    expect(engine.snapshot().units.find((u) => u.id === INCIDENT_UNIT_ID)!.status).toBe(
      "red",
    );
  });

  it("treats generated units as full citizens: N-500 takes a SAFE SIT", () => {
    const engine = createSimEngine({
      seed: 7,
      timeline: FAST,
      unitCount: 500,
      sitTimeline: { rampMs: 400, completeAtMs: 800 },
    });
    engine.advance(1000);
    const [accepted] = engine.handle({ c: "COMMAND_SAFE_SIT", unitId: "N-500" });
    expect(accepted).toMatchObject({
      t: "command_event",
      unitId: "N-500",
      ev: { k: "accepted" },
    });
    for (let t = 1100; t <= 2000; t += 100) engine.advance(t);
    expect(engine.snapshot().units.at(-1)).toMatchObject({
      id: "N-500",
      posture: "sitting",
    });
  });
});
