import * as z from "zod/mini";
import { operatorCommandSchema, type FleetMessage } from "@/lib/schema";
import { collectPreroll, prerollFor, PREROLL_MS } from "./engine/preroll";
import { DEFAULT_TIMELINE } from "./engine/incident-knee";
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
  /**
   * Storyline ms to arrive at, for a console that is resuming rather than
   * starting. The engine is wound forward *before* the greeting, so the
   * snapshot the console receives is already the resumed fleet — no flash of
   * t=0, and no second round trip to correct it.
   */
  resumeAtMs: z.optional(nonNegativeMs),
  /**
   * How much history to hand the console, overriding `PREROLL_MS`. The e2e
   * builds pass 0: they compress the storyline into seconds, where a
   * pre-roll measured against the real one would play the whole incident
   * before the greeting.
   */
  prerollMs: z.optional(nonNegativeMs),
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
  /** This run's pre-roll, so a restart can hand over history the same way. */
  let runPrerollMs = 0;
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
      // A run does not begin at zero. It begins with a past: `PREROLL_MS` of
      // storyline the fleet has already lived, or wherever the last page left
      // off, whichever is further along.
      const resumeAtMs = msg.resumeAtMs ?? 0;
      const prerollMs = prerollFor(
        msg.prerollMs ?? PREROLL_MS,
        msg.timeline?.onsetMs ?? DEFAULT_TIMELINE.onsetMs,
      );
      runPrerollMs = prerollMs;
      const startAtMs = Math.max(prerollMs, resumeAtMs);
      startedAt = now() - startAtMs;
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

      // Wind the storyline forward with the output discarded: advance() skips
      // stale telemetry across a long gap but still fires every beat inside
      // it, so the engine ends up holding the alerts and statuses the run had
      // at that instant — which is exactly what the greeting below reads.
      //
      // The last stretch is walked rather than jumped, because that skipping
      // is the point: a jump lands the engine in the right *state* with none
      // of the samples that got it there, and the samples are what the trend
      // watch fits. So the bulk is a jump and the window is a walk.
      const created = engine;
      const historyFrom = Math.max(0, startAtMs - prerollMs);
      if (historyFrom > 0) created.advance(historyFrom);
      const history = collectPreroll(
        (t) => created.advance(t),
        historyFrom,
        startAtMs,
        tickMs,
      );

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

      // After the greeting, never before: the snapshot seams the console's
      // telemetry channel, and history delivered ahead of it would land on the
      // wrong side of that seam and be ignored. See collectPreroll.
      for (const m of history) port.postMessage(m);

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
    if (msg.cmd.c === "RESET_SIM" && runPrerollMs > 0) {
      /**
       * A reset is the "let me watch that again" gesture, and it restarts the
       * storyline at zero — which restates the world, seams the console's
       * telemetry channel, and leaves the trend watch with nothing to fit.
       * Before the incident was pulled forward that cost nothing, because the
       * onset was further out than the window; now the fault would arrive
       * before the console could form an opinion about it, and a replay would
       * quietly be a worse demo than the first run.
       *
       * So a reset begins the way a connection does: the snapshot the engine
       * just produced, then the history under it.
       */
      const restarted = engine;
      // `advance` counts total elapsed ms, not storyline ms, and refuses to go
      // backwards — a reset moves the storyline's origin up to here rather
      // than rewinding the engine. So the replay's history is the stretch of
      // total time *after* the reset, which is storyline 0 -> the pre-roll.
      const resetAtTotalMs = now() - startedAt;
      post(restarted.handle(msg.cmd));
      const history = collectPreroll(
        (t) => restarted.advance(t),
        resetAtTotalMs,
        resetAtTotalMs + runPrerollMs,
        tickMs,
      );
      // The run is now that much further along, so the clock the ticks read
      // from moves back by the same amount.
      startedAt -= runPrerollMs;
      post(history);
      return;
    }
    post(engine.handle(msg.cmd));
  });

  return { stop: stopTicking };
}
