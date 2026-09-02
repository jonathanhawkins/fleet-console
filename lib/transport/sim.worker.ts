import { startSimWorkerHost, type SimWorkerPort } from "@/sim/worker-host";

/**
 * The real Web Worker entry — everything testable lives in
 * `sim/worker-host.ts`; this file only hands the host its port.
 *
 * Bundled by `new Worker(new URL("./sim.worker.ts", import.meta.url))` in
 * workerTransport.ts — the static pattern both webpack and Turbopack compile
 * into a worker chunk without custom config. The engine ships only in that
 * chunk: workerTransport imports from this side of the boundary are
 * type-only, so the main bundle stays sim-free.
 *
 * `self` here is DedicatedWorkerGlobalScope, which satisfies SimWorkerPort
 * structurally; the cast avoids pulling the webworker lib into a DOM-lib
 * program.
 */
startSimWorkerHost(self as unknown as SimWorkerPort);
