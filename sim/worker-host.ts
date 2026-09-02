import * as z from "zod/mini";
import { operatorCommandSchema, type FleetMessage } from "@/lib/schema";
import {
  createSimEngine,
  DEFAULT_DIAG_TIMELINE,
  scaleDiagTimeline,
  type SimEngine,
} from "./engine";

/**
 * Static-deploy transport host: the same pure sim engine `sim/server.ts` runs
 * behind a WebSocket, hosted inside a Web Worker instead (PRD §4 — one
 * interface, two implementations, so the deployed demo needs no backend).
 *
 * Mirror-image of the ws server, member for member:
 *
 * ws server worker host
 * --------- -----------
 * socket.on("message") + zod -> port message event + zod
 * broadcast(JSON frames) -> port.postMessage(structured clone)
 * greet: snapshot/alerts/diag -> same, on `init`
 * setInterval(Date.now tick) -> same, self-scheduled INSIDE the worker
 *
 * The host is factored on a `SimWorkerPort` — the postMessage/addEventListener
 * shape both `DedicatedWorkerGlobalScope` (the real worker entry passes
 * `self`) and an in-process fake (vitest) satisfy. All simulation logic stays
 * in engine.ts; this file owns only the clock, the greeting, and command
 * intake. The engine is created lazily on `init` so the client controls seed
 * and pacing — the worker equivalent of the dev server's SIM_SEED /
 * SIM_ONSET_MS / SIM_DIAG_SCALE env knobs.
 */

// ---------------------------------------------------------------------------
// protocol (client -> worker; worker -> client is plain FleetMessage)

/**
 * Storyline beat overrides — the SIM_ONSET_MS / SIM_AMBER_MS / SIM_RED_MS
 * equivalents. (zod/mini, like the shared contract in lib/schema: this file
 * ships in the worker chunk and the functional API tree-shakes. zod 4's
 * z.number() already rejects NaN and ±Infinity, so the old `.finite()`
 * checks are structural no-ops here.)
 */
const nonNegativeMs = z.number().check(z.nonnegative());
const timelineOverrideSchema = z.partial(
  z.object({
    onsetMs: nonNegativeMs,
    amberAtMs: nonNegativeMs,
    redAtMs: nonNegativeMs,
  }),
);

/** N-03 blocked-navigation beats — the SIM_N03_BLOCK_MS / SIM_N03_CLEAR_MS twins. */
const navOverrideSchema = z.partial(
  z.object({
    blockAtMs: nonNegativeMs,
    clearAtMs: nonNegativeMs,
  }),
);

/**
 * Firmware-cohort beats + staged-rollback pacing — the SIM_COHORT_ONSET_MS /
 * SIM_COHORT_STAGGER_MS / SIM_COHORT_PENDING_AT_MS / SIM_COHORT_ROLLBACK_MS
 * twins.
 */
const cohortOverrideSchema = z.partial(
  z.object({
    onsetMs: nonNegativeMs,
    staggerMs: nonNegativeMs,
    pendingAtMs: nonNegativeMs,
    rollbackPerUnitMs: nonNegativeMs,
  }),
);

/**
 * First message after the worker spawns. Creates (or, sent again, replaces)
 * the engine: same seed → same storyline as the ws sim, beat for beat.
 * `diagScale` compresses the scan choreography exactly like SIM_DIAG_SCALE;
 * `units` is the SIM_UNITS twin (fleet size, clamped by the engine to 8–500);
 * `nav` repins the N-03 self-recovery storyline like SIM_N03_*; `cohort`
 * repins the firmware-cohort storyline like SIM_COHORT_*.
 */
export const simWorkerInitSchema = z.object({
  type: z.literal("init"),
  seed: z.optional(z.int()),
  units: z.optional(z.int().check(z.positive())),
  timeline: z.optional(timelineOverrideSchema),
  nav: z.optional(navOverrideSchema),
  cohort: z.optional(cohortOverrideSchema),
  diagScale: z.optional(z.number().check(z.positive())),
});
export type SimWorkerInit = z.infer<typeof simWorkerInitSchema>;

/** Everything the console can post into the worker. */
export const simWorkerInMessageSchema = z.discriminatedUnion("type", [
  simWorkerInitSchema,
  z.object({ type: z.literal("cmd"), cmd: operatorCommandSchema }),
]);
export type SimWorkerInMessage = z.infer<typeof simWorkerInMessageSchema>;

// ---------------------------------------------------------------------------
// host

/**
 * What the host needs from its side of the boundary. Structurally satisfied
 * by `DedicatedWorkerGlobalScope`; tests pass an in-process fake and drive
 * the host without a real Worker.
 */
export interface SimWorkerPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}

export interface SimWorkerHostOptions {
  /** Engine tick cadence. Default 100 ms — the 10 Hz batch interval. */
  tickMs?: number;
  /** Clock; injectable for tests. Default Date.now. */
  now?: () => number;
}

export interface SimWorkerHost {
  /** Stop the tick loop. The real worker dies by terminate(); tests call this. */
  stop(): void;
}

const isDev = process.env.NODE_ENV !== "production";

export function startSimWorkerHost(
  port: SimWorkerPort,
  options: SimWorkerHostOptions = {},
): SimWorkerHost {
  const tickMs = options.tickMs ?? 100;
  const now = options.now ?? (() => Date.now());

  let engine: SimEngine | null = null;
  let startedAt = 0;
  let interval: ReturnType<typeof setInterval> | null = null;

  const post = (messages: FleetMessage[]): void => {
    for (const m of messages) port.postMessage(m);
  };

  const stopTicking = (): void => {
    if (interval !== null) clearInterval(interval);
    interval = null;
  };

  port.addEventListener("message", (ev) => {
    const result = simWorkerInMessageSchema.safeParse(ev.data);
    if (!result.success) {
      if (isDev)
        console.warn("[sim-worker] dropped invalid message", result.error.issues);
      return;
    }
    const msg = result.data;

    if (msg.type === "init") {
      // (Re-)init starts a fresh run — the worker equivalent of restarting
      // `pnpm sim`. RESET_SIM (a cmd) is the in-run replay; this replaces
      // the engine wholesale.
      stopTicking();
      startedAt = now();
      engine = createSimEngine({
        seed: msg.seed,
        unitCount: msg.units,
        timeline: msg.timeline,
        navTimeline: msg.nav,
        cohortTimeline: msg.cohort,
        diagTimeline:
          msg.diagScale === undefined
            ? undefined
            : scaleDiagTimeline(DEFAULT_DIAG_TIMELINE, msg.diagScale),
        startTimeMs: startedAt,
      });

      // Greet exactly like the ws server greets a connection: snapshot, then
      // this run's alerts, then any in-flight scan's emitted prefix, then any
      // in-flight SAFE SIT's command_events, then an in-flight staged
      // rollback's fleet_command_events. (Fresh engines have nothing to
      // replay; the symmetry keeps the host honest.)
      port.postMessage(engine.snapshot());
      for (const alert of engine.activeAlerts()) port.postMessage(alert);
      for (const diag of engine.activeDiagEvents()) port.postMessage(diag);
      for (const cmdEv of engine.activeCommandEvents()) port.postMessage(cmdEv);
      for (const fleetEv of engine.activeFleetCommandEvents()) port.postMessage(fleetEv);

      // Self-scheduled ticks inside the worker: the engine stays pure — the
      // host owns the clock, same inversion as the ws server.
      const running = engine;
      interval = setInterval(() => {
        post(running.advance(now() - startedAt));
      }, tickMs);
      return;
    }

    if (engine === null) {
      if (isDev) console.warn("[sim-worker] dropped command before init");
      return;
    }
    post(engine.handle(msg.cmd));
  });

  return { stop: stopTicking };
}
