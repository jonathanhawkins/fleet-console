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
  /** Module-load failure (a 404'd chunk, a throw at module scope) or a later runtime error. */
  onerror: ((ev: unknown) => void) | null;
  /** A message the host sent could not be structured-cloned back to us — a corrupt link. */
  onmessageerror: ((ev: unknown) => void) | null;
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
  /** Storyline ms to resume at — a reload picking the run back up. */
  resumeAtMs?: number;
  /** History handed over after the greeting; see PREROLL_MS. 0 disables it. */
  prerollMs?: number;
  /** Injectable worker constructor for tests; defaults to the bundled sim worker. */
  workerFactory?: () => WorkerLike;
  /**
   * How long to wait for the host's first message before giving up and
   * reporting closed. Generous by default — this is a cold module parse and
   * an engine spin-up on whatever device the operator brought, not network
   * latency — but bounded, so a dead worker cannot hold the chip on "connecting"
   * forever.
   */
  openTimeoutMs?: number;
}

const isDev = process.env.NODE_ENV !== "production";
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;

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
 * - connect() spawns the worker, wires onmessage/onerror/onmessageerror, then
 *   posts the init message ({seed, timeline?, diagScale?}); the host replies
 *   with the snapshot greeting and starts ticking. The browser queues
 *   messages posted before the worker script finishes loading, so this is
 *   race-free.
 * - Status: "open" is proven, not assumed. connect() reports "connecting",
 *   then "open" only once the host's first message passes validation — the
 *   same proof-of-life a socket gets for free from its own "open" event. A
 *   worker that throws on construction, fires onerror/onmessageerror, or
 *   simply never answers within openTimeoutMs is "closed" — the same state
 *   disconnect() reports, because a dead link and a deliberate one are the
 *   same fact to the UI: nothing is coming. Any of those failures also
 *   terminates the worker, so a chunk that 404s can never leave a zombie
 *   handle behind for send() to feed quietly into the void.
 * - disconnect() terminates the worker outright; the sim run dies with it.
 *   A later connect() spawns a fresh worker and a fresh run (same seed →
 *   the same storyline).
 */
export class WorkerTransport implements TelemetryTransport, ConnectionStatusSource {
  private readonly init: SimWorkerInit;
  private readonly factory: () => WorkerLike;
  private readonly openTimeoutMs: number;

  private worker: WorkerLike | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
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
      resumeAtMs: options.resumeAtMs,
      prerollMs: options.prerollMs,
    };
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
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
    this.setStatus("connecting");

    let worker: WorkerLike;
    try {
      worker = this.factory();
    } catch {
      // Failed before it could even start (no Worker support, a synchronous
      // construction error): the same "closed" a worker that never answers
      // gets, not a status this transport never recovers from reporting.
      this.setStatus("closed");
      return;
    }
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
      // Whatever this message is, it is proof the host is alive and speaking
      // the contract — the worker link's equivalent of a socket's own "open".
      this.clearOpenTimer();
      this.setStatus("open");
      gated(result.data);
    };
    worker.onerror = () => this.fail();
    worker.onmessageerror = () => this.fail();

    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      this.fail();
    }, this.openTimeoutMs);

    worker.postMessage(this.init);
  }

  send(cmd: OperatorCommand): void {
    if (!this.worker) return; // not connected: drop, mirroring a closed ws
    const msg: SimWorkerInMessage = { type: "cmd", cmd };
    this.worker.postMessage(msg);
  }

  disconnect(): void {
    this.teardownWorker();
    this.setStatus("closed");
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * The link died — before ever proving itself (onerror, onmessageerror, or
   * the open timeout) or after (a later onerror mid-session). Either way,
   * nothing more is coming: tear the worker down and report it honestly
   * rather than let a stale "open" outlive the thing it described.
   */
  private fail(): void {
    const worker = this.teardownWorker();
    if (!worker) return; // already torn down by disconnect() or a prior fail()
    this.setStatus("closed");
  }

  /** Clears the open timer, detaches and terminates the worker. Returns what was there. */
  private teardownWorker(): WorkerLike | null {
    this.clearOpenTimer();
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    return worker;
  }

  private clearOpenTimer(): void {
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.statusListeners) listener(next);
  }
}
