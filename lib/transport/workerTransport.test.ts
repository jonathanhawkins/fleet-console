// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FleetMessage } from "@/lib/schema";
import { createSimEngine } from "@/sim/engine";
import { startSimWorkerHost, type SimWorkerHost } from "@/sim/worker-host";
import { createTransport } from "./createTransport";
import { type ConnectionStatus } from "./types";
import { WorkerTransport, type WorkerLike } from "./workerTransport";
import { WsTransport } from "./wsTransport";

/**
 * A stand-in Worker wired to the REAL host + REAL engine, in-process: what
 * the transport posts is delivered to the host port, what the host posts
 * comes back through `onmessage`. The only fake part is the process
 * boundary, so these tests exercise the exact production message path.
 *
 * Its replies are synchronous (the host answers `postMessage` in the same
 * call), which is what lets the happy-path test observe the full
 * connecting -> open walk within a single `connect()` call — a real worker
 * answers on its own clock, but the proof-of-life contract is identical
 * either way (see SilentWorker below for the asynchronous shape).
 */
class FakeWorker implements WorkerLike {
  static instances: FakeWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessageerror: ((ev: unknown) => void) | null = null;
  terminated = false;
  private readonly host: SimWorkerHost;
  private readonly listeners: Array<(ev: { data: unknown }) => void> = [];

  constructor() {
    FakeWorker.instances.push(this);
    this.host = startSimWorkerHost({
      postMessage: (message) => this.onmessage?.({ data: message }),
      addEventListener: (_type, listener) => {
        this.listeners.push(listener);
      },
    });
  }

  postMessage(message: unknown): void {
    if (this.terminated) return;
    for (const l of this.listeners) l({ data: message });
  }

  terminate(): void {
    this.terminated = true;
    this.host.stop();
  }

  /** The worker side speaking out of contract (tests only). */
  emitRaw(data: unknown): void {
    this.onmessage?.({ data });
  }
}

/**
 * A worker with no host behind it at all: `postMessage` just records what it
 * was sent, and nothing answers back until a test calls `onmessage`/`onerror`/
 * `onmessageerror` by hand. This is what a chunk that 404s, or a worker that
 * hangs mid-boot, looks like from the transport's side of the boundary.
 */
class SilentWorker implements WorkerLike {
  static instances: SilentWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessageerror: ((ev: unknown) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  constructor() {
    SilentWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const makeTransport = (
  overrides: ConstructorParameters<typeof WorkerTransport>[0] = {},
) =>
  new WorkerTransport({
    seed: 42,
    workerFactory: () => new FakeWorker(),
    ...overrides,
  });

beforeEach(() => {
  FakeWorker.instances = [];
  SilentWorker.instances = [];
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("WorkerTransport — the same interface, the same stream", () => {
  it("connects open immediately and delivers the seeded engine's exact stream", () => {
    const received: FleetMessage[] = [];
    const statuses: ConnectionStatus[] = [];
    const transport = makeTransport({ seed: 7 });
    transport.onStatus((s) => statuses.push(s));
    expect(transport.getStatus()).toBe("idle");

    transport.connect((m) => received.push(m));
    // The fake host answers postMessage synchronously, so by the time
    // connect() returns the status has already walked connecting -> open —
    // proven by the snapshot that arrived, not assumed because the link is
    // in-page.
    expect(statuses).toEqual(["connecting", "open"]);
    expect(transport.getStatus()).toBe("open");
    expect(received).toHaveLength(1); // the snapshot greeting

    vi.advanceTimersByTime(300);

    // Byte-for-byte what a directly driven engine (the ws server's core)
    // produces for the same seed and clock: the transports are equivalent.
    const engine = createSimEngine({ seed: 7, startTimeMs: 0 });
    const direct: FleetMessage[] = [engine.snapshot()];
    for (let t = 100; t <= 300; t += 100) direct.push(...engine.advance(t));
    expect(JSON.stringify(received)).toBe(JSON.stringify(direct));

    transport.disconnect();
  });

  it("connect() is idempotent while connected", () => {
    const transport = makeTransport();
    transport.connect(() => {});
    transport.connect(() => {});
    expect(FakeWorker.instances).toHaveLength(1);
    transport.disconnect();
  });

  it("zod-validates at the worker boundary and drops rogue frames with a dev warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const received: FleetMessage[] = [];
    const transport = makeTransport();
    transport.connect((m) => received.push(m));

    const worker = FakeWorker.instances[0]!;
    worker.emitRaw({ t: "telemetry", unitId: "N-07" }); // missing fields
    worker.emitRaw("not a message");
    worker.emitRaw({ t: "mystery" });
    expect(received).toHaveLength(1); // still just the snapshot
    expect(warn).toHaveBeenCalledTimes(3);
    transport.disconnect();
  });
});

describe("WorkerTransport — commands", () => {
  it("send() forwards RUN_DIAGNOSTIC into the engine; scan_start comes back", () => {
    const received: FleetMessage[] = [];
    const transport = makeTransport();
    transport.connect((m) => received.push(m));
    vi.advanceTimersByTime(100);

    transport.send({ c: "RUN_DIAGNOSTIC", unitId: "N-07" });
    expect(received.at(-1)).toMatchObject({
      t: "diag_event",
      unitId: "N-07",
      ev: { k: "scan_start" },
    });
    transport.disconnect();
  });

  it("send() forwards RESET_SIM; the fresh snapshot comes back", () => {
    const received: FleetMessage[] = [];
    const transport = makeTransport();
    transport.connect((m) => received.push(m));
    vi.advanceTimersByTime(500);

    transport.send({ c: "RESET_SIM" });
    expect(received.at(-1)).toMatchObject({ t: "fleet_snapshot" });
    transport.disconnect();
  });

  it("send() before connect or after disconnect is a quiet drop", () => {
    const transport = makeTransport();
    expect(() => transport.send({ c: "RESET_SIM" })).not.toThrow();

    transport.connect(() => {});
    transport.disconnect();
    expect(() => transport.send({ c: "RESET_SIM" })).not.toThrow();
    expect(FakeWorker.instances).toHaveLength(1); // no sneaky respawn
  });
});

describe("WorkerTransport — disconnect and status", () => {
  it("disconnect terminates the worker, silences delivery, and reports closed", () => {
    const statuses: ConnectionStatus[] = [];
    const received: FleetMessage[] = [];
    const transport = makeTransport();
    transport.onStatus((s) => statuses.push(s));

    transport.connect((m) => received.push(m));
    vi.advanceTimersByTime(200);
    const before = received.length;

    transport.disconnect();
    const worker = FakeWorker.instances[0]!;
    expect(worker.terminated).toBe(true);
    expect(transport.getStatus()).toBe("closed");
    vi.advanceTimersByTime(1_000);
    expect(received).toHaveLength(before); // nothing after termination
    expect(statuses).toEqual(["connecting", "open", "closed"]);
  });

  it("a reconnect spawns a fresh worker and a fresh run of the same storyline", () => {
    const first: FleetMessage[] = [];
    const second: FleetMessage[] = [];
    const transport = makeTransport({ seed: 7 });

    transport.connect((m) => first.push(m));
    vi.advanceTimersByTime(300);
    transport.disconnect();

    vi.setSystemTime(0); // pin the second run's epoch to match the first
    transport.connect((m) => second.push(m));
    vi.advanceTimersByTime(300);
    transport.disconnect();

    expect(FakeWorker.instances).toHaveLength(2);
    expect(second.length).toBeGreaterThan(1);
    // same seed -> the storyline replays byte-identically
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

/**
 * The console reporting a healthy link over a dead worker is the failure
 * this whole file is guarding against: every path here must land on
 * "closed" — never a stale "open" — and must leave no live worker handle
 * behind for a later send() to feed into the void.
 */
describe("WorkerTransport — link health", () => {
  it("a worker that throws on construction reports closed, not open", () => {
    const statuses: ConnectionStatus[] = [];
    const transport = makeTransport({
      workerFactory: () => {
        throw new Error("chunk failed to load");
      },
    });
    transport.onStatus((s) => statuses.push(s));

    expect(() => transport.connect(() => {})).not.toThrow();
    expect(transport.getStatus()).toBe("closed");
    expect(statuses).toEqual(["connecting", "closed"]);
  });

  it("a worker that errors after construction reports closed and is terminated", () => {
    const statuses: ConnectionStatus[] = [];
    const transport = makeTransport({ workerFactory: () => new SilentWorker() });
    transport.onStatus((s) => statuses.push(s));

    transport.connect(() => {});
    expect(transport.getStatus()).toBe("connecting");

    const worker = SilentWorker.instances[0]!;
    worker.onerror?.({});
    expect(transport.getStatus()).toBe("closed");
    expect(worker.terminated).toBe(true);
    expect(statuses).toEqual(["connecting", "closed"]);

    // The link is dead: detached, not just failed once — a stray late
    // message cannot resurrect it.
    expect(worker.onmessage).toBeNull();
  });

  it("a worker that fails a message (onmessageerror) reports closed and is terminated", () => {
    const statuses: ConnectionStatus[] = [];
    const transport = makeTransport({ workerFactory: () => new SilentWorker() });
    transport.onStatus((s) => statuses.push(s));

    transport.connect(() => {});
    const worker = SilentWorker.instances[0]!;
    worker.onmessageerror?.({});
    expect(transport.getStatus()).toBe("closed");
    expect(worker.terminated).toBe(true);
    expect(statuses).toEqual(["connecting", "closed"]);
  });

  it("a worker that never answers times out to closed and is terminated", () => {
    const statuses: ConnectionStatus[] = [];
    const transport = makeTransport({
      workerFactory: () => new SilentWorker(),
      openTimeoutMs: 1_000,
    });
    transport.onStatus((s) => statuses.push(s));

    transport.connect(() => {});
    const worker = SilentWorker.instances[0]!;
    expect(transport.getStatus()).toBe("connecting");

    vi.advanceTimersByTime(999);
    expect(transport.getStatus()).toBe("connecting"); // still inside the grace window
    expect(worker.terminated).toBe(false);

    vi.advanceTimersByTime(1);
    expect(transport.getStatus()).toBe("closed");
    expect(worker.terminated).toBe(true);
    expect(statuses).toEqual(["connecting", "closed"]);

    // Same quiet drop any other closed link gets — no sneaky respawn either.
    expect(() => transport.send({ c: "RESET_SIM" })).not.toThrow();
    expect(worker.posted).toHaveLength(1); // only the init already in flight
  });

  it("a slow but alive worker still reaches open before the timeout, and the timer goes inert", () => {
    const statuses: ConnectionStatus[] = [];
    const received: FleetMessage[] = [];
    const transport = makeTransport({
      workerFactory: () => new SilentWorker(),
      openTimeoutMs: 1_000,
    });
    transport.onStatus((s) => statuses.push(s));
    transport.connect((m) => received.push(m));

    const worker = SilentWorker.instances[0]!;
    vi.advanceTimersByTime(900); // late, but inside the window
    const engine = createSimEngine({ seed: 42, startTimeMs: 0 });
    worker.onmessage?.({ data: engine.snapshot() });

    expect(transport.getStatus()).toBe("open");
    expect(received).toHaveLength(1);
    expect(statuses).toEqual(["connecting", "open"]);

    // The timeout that would have failed a silent worker is now inert.
    vi.advanceTimersByTime(1_000);
    expect(transport.getStatus()).toBe("open");
    expect(worker.terminated).toBe(false);
  });
});

describe("createTransport — env selection", () => {
  it("returns WorkerTransport for NEXT_PUBLIC_TRANSPORT=worker, WsTransport by default", () => {
    vi.stubEnv("NEXT_PUBLIC_TRANSPORT", "worker");
    expect(createTransport()).toBeInstanceOf(WorkerTransport);

    vi.stubEnv("NEXT_PUBLIC_TRANSPORT", "ws");
    expect(createTransport()).toBeInstanceOf(WsTransport);

    vi.stubEnv("NEXT_PUBLIC_TRANSPORT", "carrier-pigeon");
    expect(() => createTransport()).toThrow(/expected "ws" or "worker"/);
  });
});
