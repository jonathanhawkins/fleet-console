// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { type FleetMessage, type TelemetryMessage } from "@/lib/schema";
import { getUnitBuffers, useAuditStore, useFleetStore } from "@/lib/stores";
import { createSimEngine } from "@/sim/engine";
import { createOrderingGate } from "./orderingGate";

/**
 * Out-of-order receipts at fleet scale.
 *
 * The policy lives in `createOrderingGate` and is specified in
 * orderingGate.test.ts; this file is the *stress receipt*: the real engine's
 * 500-unit stream, deliberately mangled the way a bad network would (whole
 * waves redelivered, a late straggler wave, seeded pairwise shuffling), pushed
 * through the gate's `onDrop` instrumentation — a dev-only counter — and into
 * the real fleet store. The numbers asserted here
 * are the numbers quoted in docs/perf.md ("Scale + ordering"): drop counts
 * are exact, admitted batches are exactly the stream minus the drops, and
 * the ring buffers a sparkline reads stay strictly monotonic in time.
 *
 * Nothing user-facing surfaces the counter by design: transports log a dev
 * console.warn per drop, and the receipt lives here and in docs/perf.md.
 */

const UNITS = 500;
const WAVE_MS = 100;

/** Deterministic PRNG (mulberry32, same construction the engine uses). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(input: readonly T[], random: () => number): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The engine's next 10 Hz wave: exactly one telemetry batch per unit. */
function nextWave(
  engine: ReturnType<typeof createSimEngine>,
  wave: number,
): TelemetryMessage[] {
  const messages = engine.advance(wave * WAVE_MS);
  const telemetry = messages.filter((m): m is TelemetryMessage => m.t === "telemetry");
  expect(telemetry).toHaveLength(UNITS);
  return telemetry;
}

interface Receipt {
  delivered: number;
  admitted: number;
  dropped: number;
  droppedByType: Record<string, number>;
}

/** The gate, wired the way the transports wire it — plus the drop counter. */
function instrumentedGate(onMessage: (m: FleetMessage) => void) {
  const receipt: Receipt = {
    delivered: 0,
    admitted: 0,
    dropped: 0,
    droppedByType: {},
  };
  const gate = createOrderingGate(
    (m) => {
      receipt.admitted += 1;
      onMessage(m);
    },
    (m) => {
      receipt.dropped += 1;
      receipt.droppedByType[m.t] = (receipt.droppedByType[m.t] ?? 0) + 1;
    },
  );
  return {
    receipt,
    deliver(m: FleetMessage) {
      receipt.delivered += 1;
      gate(m);
    },
  };
}

beforeEach(() => {
  useFleetStore.getState().reset();
  useAuditStore.getState().reset();
});

describe("ordering gate under a 500-unit mangled stream", () => {
  it("drops exactly the stale deliveries and admits a monotonic stream into the store", () => {
    const engine = createSimEngine({ seed: 7, unitCount: UNITS });
    const fleet = useFleetStore.getState();

    const { receipt, deliver } = instrumentedGate((m) => {
      if (m.t === "fleet_snapshot") fleet.applySnapshot(m);
      if (m.t === "telemetry") fleet.applyTelemetry(m);
    });

    deliver(engine.snapshot());
    const waves = [1, 2, 3, 4, 5].map((n) => nextWave(engine, n));
    const [wave1, wave2, wave3, wave4, wave5] = waves as [
      TelemetryMessage[],
      TelemetryMessage[],
      TelemetryMessage[],
      TelemetryMessage[],
      TelemetryMessage[],
    ];

    // -- 1. clean delivery of two waves ------------------------------------
    for (const m of wave1) deliver(m);
    for (const m of wave2) deliver(m);
    expect(receipt.dropped).toBe(0);

    // -- 2. the network re-sends wave 2 wholesale (500 duplicates) ---------
    for (const m of wave2) deliver(m);
    expect(receipt.dropped).toBe(UNITS);

    // -- 3. wave 4 overtakes wave 3; the straggler arrives late ------------
    for (const m of wave4) deliver(m);
    for (const m of wave3) deliver(m); // 500 stale batches
    expect(receipt.dropped).toBe(2 * UNITS);

    // -- 4. waves 5 + a re-send of wave 4, pairwise shuffled (seeded) ------
    // For each unit two batches are in flight (ts4 < ts5). After the shuffle
    // a unit's pair arrives either in order (ts4 admitted? no — ts4 is a
    // duplicate of step 3's wave 4, so it is stale either way; ts5 passes)
    // or inverted (ts5 first — admitted; then ts4 — stale). Every unit
    // therefore admits exactly its wave-5 batch and drops exactly one: 500
    // more drops, whatever the shuffle order. The receipt cares that the
    // count is *exact* and the survivor is always the newest truth.
    const mangled = shuffled([...wave5, ...wave4], rng(0x6b07));
    for (const m of mangled) deliver(m);
    expect(receipt.dropped).toBe(3 * UNITS);

    // -- totals ------------------------------------------------------------
    // 1 snapshot + waves 1/3/5 delivered once + waves 2/4 delivered twice
    // = 3,501 deliveries, of which exactly 1,500 were disorder.
    expect(receipt.delivered).toBe(1 + 7 * UNITS);
    expect(receipt.admitted).toBe(receipt.delivered - receipt.dropped);
    expect(receipt.droppedByType).toEqual({ telemetry: 3 * UNITS });

    // -- the store only ever saw ordered truth -----------------------------
    const state = useFleetStore.getState();
    expect(state.unitIds).toHaveLength(UNITS);
    // Every unit admitted exactly 4 batches — waves 1, 2, 4, 5. Wave 3 is
    // *gone*, and that is the policy stated plainly: a straggler overtaken by
    // newer truth is dropped, never reordered back in. The sparkline shows a
    // 100 ms notch rather than time flowing backwards.
    for (const id of state.unitIds) {
      expect(state.unitTelemetryVersions[id]).toBe(4);
      const ts = getUnitBuffers(id)?.ts.toArray() ?? [];
      expect(ts).toHaveLength(4);
      for (let i = 1; i < ts.length; i++) {
        expect(ts[i]!).toBeGreaterThan(ts[i - 1]!);
      }
    }
    expect(state.telemetryVersion).toBe(4 * UNITS);
  });

  it("a snapshot resets the gates so a reconnect replay is not counted as disorder", () => {
    const engine = createSimEngine({ seed: 7, unitCount: UNITS });
    const { receipt, deliver } = instrumentedGate(() => {});

    deliver(engine.snapshot());
    const wave1 = nextWave(engine, 1);
    const wave2 = nextWave(engine, 2);
    for (const m of wave2) deliver(m);

    // Reconnect: the world restates, then the host replays history that would
    // be stale under the old gate. Policy: the snapshot is amnesty.
    deliver(engine.snapshot());
    for (const m of wave1) deliver(m);
    expect(receipt.dropped).toBe(0);
    expect(receipt.admitted).toBe(2 + 2 * UNITS);
  });

  it("command_event disorder resolves by seq, telemetry disorder by ts — independently", () => {
    const { receipt, deliver } = instrumentedGate(() => {});
    const cmd = (seq: number): FleetMessage => ({
      t: "command_event",
      unitId: "N-07",
      cmd: "COMMAND_SAFE_SIT",
      seq,
      ts: 1000 + seq,
      ev: { k: "progress", pct: seq, note: "GAIT ARRESTED" },
    });
    // Delivered [2,1,3,3,5,4]: 1 is late (< 2), the second 3 is a duplicate,
    // 4 is late (< 5) — three drops, lifecycle admitted as 2,3,5.
    for (const seq of [2, 1, 3, 3, 5, 4]) deliver(cmd(seq));
    expect(receipt.dropped).toBe(3);
    expect(receipt.droppedByType).toEqual({ command_event: 3 });
  });
});
