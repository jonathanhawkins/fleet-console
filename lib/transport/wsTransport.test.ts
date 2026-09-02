// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FleetMessage } from "@/lib/schema";
import { type ConnectionStatus } from "./types";
import { WsTransport, type WsLike } from "./wsTransport";

class FakeSocket implements WsLike {
  static instances: FakeSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const makeTransport = (overrides: ConstructorParameters<typeof WsTransport>[0] = {}) =>
  new WsTransport({
    url: "ws://test:8787",
    webSocketFactory: (url) => new FakeSocket(url),
    baseBackoffMs: 500,
    maxBackoffMs: 4000,
    ...overrides,
  });

const validTelemetry = {
  t: "telemetry",
  unitId: "N-07",
  ts: 100,
  batch: [{ joint: "knee_L", tempC: 33, torqueNm: 12, currentA: 1.4, battery: 80 }],
};

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WsTransport — validation", () => {
  it("forwards zod-valid messages and drops invalid ones with a dev warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const received: FleetMessage[] = [];
    const transport = makeTransport();
    transport.connect((m) => received.push(m));

    const socket = FakeSocket.instances[0]!;
    socket.emitOpen();
    socket.emitMessage(JSON.stringify(validTelemetry));
    socket.emitMessage(JSON.stringify({ t: "telemetry", unitId: "N-07" })); // missing fields
    socket.emitMessage("not json at all{");
    socket.emitMessage(JSON.stringify({ t: "mystery" }));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ t: "telemetry", unitId: "N-07" });
    expect(warn).toHaveBeenCalledTimes(3);
    transport.disconnect();
  });
});

describe("WsTransport — sending", () => {
  it("buffers commands while connecting and flushes them on open", () => {
    const transport = makeTransport();
    transport.connect(() => {});
    transport.send({ c: "RUN_DIAGNOSTIC", unitId: "N-07" });

    const socket = FakeSocket.instances[0]!;
    expect(socket.sent).toHaveLength(0);
    socket.emitOpen();
    expect(socket.sent).toEqual([
      JSON.stringify({ c: "RUN_DIAGNOSTIC", unitId: "N-07" }),
    ]);

    transport.send({ c: "RESET_SIM" });
    expect(socket.sent).toHaveLength(2);
    transport.disconnect();
  });

  it("drops sends after a deliberate disconnect", () => {
    const transport = makeTransport();
    transport.connect(() => {});
    FakeSocket.instances[0]!.emitOpen();
    transport.disconnect();
    transport.send({ c: "RESET_SIM" });
    expect(FakeSocket.instances[0]!.sent).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(1); // no sneaky reconnect
  });
});

describe("WsTransport — reconnect and status", () => {
  it("walks idle -> connecting -> open, then reconnects with doubling capped backoff", () => {
    const transport = makeTransport();
    const statuses: ConnectionStatus[] = [];
    transport.onStatus((s) => statuses.push(s));
    expect(transport.getStatus()).toBe("idle");

    transport.connect(() => {});
    FakeSocket.instances[0]!.emitOpen();
    expect(transport.getStatus()).toBe("open");

    // drop the link: first retry after 500 ms
    FakeSocket.instances[0]!.emitClose();
    expect(transport.getStatus()).toBe("reconnecting");
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    // keep failing: 1000, 2000, 4000, then capped at 4000
    for (const delay of [1000, 2000, 4000, 4000]) {
      FakeSocket.instances.at(-1)!.emitClose();
      const before = FakeSocket.instances.length;
      vi.advanceTimersByTime(delay - 1);
      expect(FakeSocket.instances).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(before + 1);
    }

    // a successful open resets the attempt counter
    FakeSocket.instances.at(-1)!.emitOpen();
    expect(transport.getStatus()).toBe("open");
    FakeSocket.instances.at(-1)!.emitClose();
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(7);

    expect(statuses[0]).toBe("connecting");
    expect(statuses).toContain("open");
    expect(statuses).toContain("reconnecting");
    transport.disconnect();
    expect(transport.getStatus()).toBe("closed");
  });

  it("keeps delivering messages through the reconnected socket", () => {
    const received: FleetMessage[] = [];
    const transport = makeTransport();
    transport.connect((m) => received.push(m));
    FakeSocket.instances[0]!.emitOpen();
    FakeSocket.instances[0]!.emitClose();
    vi.advanceTimersByTime(500);

    const second = FakeSocket.instances[1]!;
    second.emitOpen();
    second.emitMessage(JSON.stringify(validTelemetry));
    expect(received).toHaveLength(1);
    transport.disconnect();
  });

  it("disconnect cancels a pending reconnect", () => {
    const transport = makeTransport();
    transport.connect(() => {});
    FakeSocket.instances[0]!.emitOpen();
    FakeSocket.instances[0]!.emitClose();
    transport.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(transport.getStatus()).toBe("closed");
  });
});
