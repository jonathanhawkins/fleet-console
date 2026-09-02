import {
  fleetMessageSchema,
  type FleetMessage,
  type OperatorCommand,
} from "@/lib/schema";
import { createOrderingGate } from "./orderingGate";
import {
  type ConnectionStatus,
  type ConnectionStatusSource,
  type TelemetryTransport,
} from "./types";

export const DEFAULT_WS_URL = "ws://localhost:8791";

/** Minimal surface we need from a WebSocket — lets tests inject a fake. */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const WS_OPEN = 1;

export interface WsTransportOptions {
  url?: string;
  /** Injectable socket constructor for tests; defaults to the platform WebSocket. */
  webSocketFactory?: (url: string) => WsLike;
  /** First reconnect delay; doubles per attempt. */
  baseBackoffMs?: number;
  /** Backoff cap. */
  maxBackoffMs?: number;
}

const isDev = process.env.NODE_ENV !== "production";

/**
 * Browser client for the dev ws sim server.
 *
 * - Every inbound frame is zod-validated against `fleetMessageSchema`; frames
 *   that fail are dropped (and console.warn'd in dev) — the stores only ever
 *   see contract-true messages (CLAUDE.md non-negotiable #4).
 * - Delivery runs through `createOrderingGate`: stale telemetry (ts <= last
 *   per unit) and stale command_events (seq <= last per unit) are dropped at
 *   this boundary, so the stores also only ever see *ordered* messages. The
 *   gate resets itself on every fleet_snapshot, which reconnects always
 *   begin with.
 * - Reconnects automatically with exponential backoff capped at
 *   `maxBackoffMs`; the attempt counter resets on a successful open.
 * - Commands sent while the link is down are buffered (bounded) and flushed
 *   on open, so "Run diagnostic" clicked during a blip still lands.
 * - Link health is observable via `getStatus`/`onStatus` for the UI.
 */
export class WsTransport implements TelemetryTransport, ConnectionStatusSource {
  private readonly url: string;
  private readonly factory: (url: string) => WsLike;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  private socket: WsLike | null = null;
  private onMessage: ((msg: FleetMessage) => void) | null = null;
  private status: ConnectionStatus = "idle";
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private sendQueue: string[] = [];
  private static readonly SEND_QUEUE_MAX = 32;

  constructor(options: WsTransportOptions = {}) {
    this.url = options.url ?? DEFAULT_WS_URL;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 8_000;
    const factory = options.webSocketFactory;
    this.factory =
      factory ??
      ((url: string) => {
        if (typeof WebSocket === "undefined") {
          throw new Error(
            "WsTransport needs a WebSocket implementation (browser or Node >= 22)",
          );
        }
        return new WebSocket(url) as unknown as WsLike;
      });
  }

  connect(onMessage: (msg: FleetMessage) => void): void {
    if (this.socket) return; // already connected/connecting; connect() is idempotent
    this.manuallyClosed = false;
    this.onMessage = createOrderingGate(onMessage, (dropped) => {
      if (isDev) console.warn("[transport] dropped out-of-order message", dropped.t);
    });
    this.open("connecting");
  }

  send(cmd: OperatorCommand): void {
    const data = JSON.stringify(cmd);
    if (this.socket && this.socket.readyState === WS_OPEN) {
      this.socket.send(data);
      return;
    }
    if (this.manuallyClosed) return; // deliberate disconnect: drop, don't hoard
    if (this.sendQueue.length >= WsTransport.SEND_QUEUE_MAX) this.sendQueue.shift();
    this.sendQueue.push(data);
  }

  disconnect(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
    this.sendQueue = [];
    this.setStatus("closed");
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // -------------------------------------------------------------------------

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.statusListeners) listener(next);
  }

  private open(phase: "connecting" | "reconnecting"): void {
    this.setStatus(phase);
    const socket = this.factory(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
      const queued = this.sendQueue;
      this.sendQueue = [];
      for (const data of queued) socket.send(data);
    };

    socket.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        if (isDev) console.warn("[transport] dropped non-JSON frame");
        return;
      }
      const result = fleetMessageSchema.safeParse(parsed);
      if (!result.success) {
        if (isDev)
          console.warn("[transport] dropped invalid FleetMessage", result.error.issues);
        return;
      }
      this.onMessage?.(result.data);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return; // superseded
      this.socket = null;
      if (this.manuallyClosed) return;
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose follows onerror; reconnection is handled there.
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.baseBackoffMs * 2 ** this.reconnectAttempt,
      this.maxBackoffMs,
    );
    this.reconnectAttempt += 1;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manuallyClosed) return;
      this.open("reconnecting");
    }, delay);
  }
}
