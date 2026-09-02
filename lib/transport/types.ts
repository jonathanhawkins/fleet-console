import { type FleetMessage, type OperatorCommand } from "@/lib/schema";

/**
 * The transport abstraction — the key architectural move (PRD §4). One
 * interface, two implementations: WsTransport speaks to the local ws sim
 * server in dev; WorkerTransport runs the identical sim inside a Web Worker
 * (hosted by sim/worker-host.ts) so the deployed demo is fully static. Same
 * message contract, same zod schemas, swapped by env flag in createTransport.
 */
export interface TelemetryTransport {
  connect(onMessage: (msg: FleetMessage) => void): void;
  send(cmd: OperatorCommand): void; // e.g. RUN_DIAGNOSTIC
  disconnect(): void;
}

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/**
 * Optional companion interface: a transport that can report link health. The
 * UI surfaces this (header connection chip); the stores feature-detect it in
 * `bindTransport` so the core TelemetryTransport contract stays PRD-exact.
 */
export interface ConnectionStatusSource {
  getStatus(): ConnectionStatus;
  /** Subscribe to status changes; returns an unsubscribe function. */
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
}

export function hasConnectionStatus(
  transport: TelemetryTransport,
): transport is TelemetryTransport & ConnectionStatusSource {
  const t = transport as Partial<ConnectionStatusSource>;
  return typeof t.getStatus === "function" && typeof t.onStatus === "function";
}
