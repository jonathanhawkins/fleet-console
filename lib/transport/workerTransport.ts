import {
  fleetMessageSchema,
  type FleetMessage,
  type OperatorCommand,
} from "@/lib/schema";
import type { SimWorkerInMessage, SimWorkerInit } from "@/sim/worker-host";
import { createOrderingGate } from "./orderingGate";
import {
  type ConnectionStatus,
  type ConnectionStatusSource,
  type TelemetryTransport,
} from "./types";

/** Minimal surface we need from a Worker — lets tests inject a fake. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface WorkerTransportOptions {
  /** Engine seed — same seed replays the same storyline, beat for beat. */
  seed?: number;
  /** Fleet size (NEXT_PUBLIC_SIM_UNITS), clamped by the engine to 8–500. */
  units?: number;
  /** Incident beat overrides (onset/amber/red), ms of storyline time. */
  timeline?: SimWorkerInit["timeline"];
  /** N-03 blocked-navigation beat overrides (block/clear), ms of storyline time. */
  nav?: SimWorkerInit["nav"];
  /** Firmware-cohort beat overrides (onset/stagger/pendingAt/rollbackPerUnit), NEXT_PUBLIC_SIM_COHORT_* twins. */
  cohort?: SimWorkerInit["cohort"];
  /** Diag choreography compression; 0.1 = command → verdict 10x faster. */
  diagScale?: number;
  /** Injectable worker constructor for tests; defaults to the bundled sim worker. */
  workerFactory?: () => WorkerLike;
}

const isDev = process.env.NODE_ENV !== "production";

/**
 * The static-deploy half of the transport abstraction (PRD §4): the identical
 * sim engine, hosted in a Web Worker (`sim/worker-host.ts`), behind the same
 * TelemetryTransport interface as WsTransport. Swapped in by
 * NEXT_PUBLIC_TRANSPORT=worker; nothing downstream can tell the difference.
 *
 * - Every inbound message is zod-validated against `fleetMessageSchema` and
 *   dropped (dev-warned) on failure, exactly like WsTransport — a worker is
 *   still a boundary, and the stores only ever see contract-true messages
 *   (CLAUDE.md non-negotiable #4).
 * - Delivery runs through `createOrderingGate`, exactly like WsTransport:
 *   stale telemetry (ts <= last per unit) and stale command_events (seq <=
 *   last per unit) are dropped here, so the stores only ever see ordered
 *   messages. postMessage is FIFO in practice, but the ordering contract
 *   belongs to the boundary, not to the current transport's luck.
 * - connect() spawns the worker, wires onmessage, then posts the init message
 *   ({seed, timeline?, diagScale?}); the host replies with the snapshot
 *   greeting and starts ticking. The browser queues messages posted before
 *   the worker script finishes loading, so this is race-free.
 * - Status: an in-page worker link cannot blip, so connect() reports "open"
 *   immediately and disconnect() "closed" — but through the same
 *   ConnectionStatusSource shape as WsTransport, so the UI's connection chip
 *   works unchanged and shows live.
 * - disconnect() terminates the worker outright; the sim run dies with it.
 *   A later connect() spawns a fresh worker and a fresh run (same seed →
 *   the same storyline).
 */
export class WorkerTransport implements TelemetryTransport, ConnectionStatusSource {
  private readonly init: SimWorkerInit;
  private readonly factory: () => WorkerLike;

  private worker: WorkerLike | null = null;
  private status: ConnectionStatus = "idle";
  private statusListeners = new Set<(status: ConnectionStatus) => void>();

  constructor(options: WorkerTransportOptions = {}) {
    this.init = {
      type: "init",
      seed: options.seed,
      units: options.units,
      timeline: options.timeline,
      nav: options.nav,
      cohort: options.cohort,
      diagScale: options.diagScale,
    };
    this.factory =
      options.workerFactory ??
      (() => {
        if (typeof Worker === "undefined") {
          throw new Error(
            "WorkerTransport needs Web Workers (browser only — render it client-side)",
          );
        }
        return new Worker(new URL("./sim.worker.ts", import.meta.url), {
          type: "module",
        }) as unknown as WorkerLike;
      });
  }

  connect(onMessage: (msg: FleetMessage) => void): void {
    if (this.worker) return; // already connected; connect() is idempotent
    const worker = this.factory();
    this.worker = worker;

    const gated = createOrderingGate(onMessage, (dropped) => {
      if (isDev) console.warn("[transport] dropped out-of-order message", dropped.t);
    });
    worker.onmessage = (ev) => {
      const result = fleetMessageSchema.safeParse(ev.data);
      if (!result.success) {
        if (isDev)
          console.warn("[transport] dropped invalid FleetMessage", result.error.issues);
        return;
      }
      gated(result.data);
    };

    worker.postMessage(this.init);
    this.setStatus("open");
  }

  send(cmd: OperatorCommand): void {
    if (!this.worker) return; // not connected: drop, mirroring a closed ws
    const msg: SimWorkerInMessage = { type: "cmd", cmd };
    this.worker.postMessage(msg);
  }

  disconnect(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.terminate();
    }
    this.setStatus("closed");
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.statusListeners) listener(next);
  }
}
