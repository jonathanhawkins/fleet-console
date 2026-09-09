import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  operatorCommandSchema,
  type FleetMessage,
  type TelemetryMessage,
} from "@/lib/schema";
import { PREROLL_MS } from "./engine";
import {
  createSimEngine,
  DEFAULT_COHORT_TIMELINE,
  DEFAULT_DIAG_TIMELINE,
  DEFAULT_NAV_TIMELINE,
  DEFAULT_TIMELINE,
  MAX_UNIT_COUNT,
  MIN_UNIT_COUNT,
  scaleDiagTimeline,
  type CohortTimeline,
  type DiagTimeline,
  type IncidentTimeline,
  type NavTimeline,
  type SitTimeline,
} from "./engine";

/**
 * Dev transport host: a plain node `ws` server wrapping the pure sim engine.
 * `pnpm sim` runs it on ws://localhost:8791 alongside `pnpm dev`.
 *
 * All simulation logic lives in engine.ts; this file only owns the clock
 * (Date.now → engine.advance), fan-out to clients, and command intake.
 * Every inbound client frame is zod-validated before it reaches the engine.
 *
 * Env overrides (all optional):
 *   SIM_PORT        listen port          (default 8791)
 *   SIM_SEED        engine seed          (default engine's)
 *   SIM_UNITS       fleet size           (default 8, clamped 8–500; the
 *                   NEXT_PUBLIC_SIM_UNITS twin for the worker transport)
 *   SIM_ONSET_MS    incident onset       (default 15000)
 *   SIM_AMBER_MS    amber alert beat     (default 28000)
 *   SIM_RED_MS      red alert beat       (default 38000)
 *   SIM_N03_BLOCK_MS  N-03 navigation-blocked beat  (default 120000)
 *   SIM_N03_CLEAR_MS  N-03 self-recovery beat       (default 160000; > block)
 *   SIM_COHORT_ONSET_MS    first cohort-signature amber     (default 180000)
 *   SIM_COHORT_STAGGER_MS  cadence between the raises       (default 10000)
 *   SIM_COHORT_PENDING_AT_MS  queued install lands unless halted (default 270000)
 *   SIM_COHORT_ROLLBACK_MS staged-rollback pace per unit    (default 4000)
 *   SIM_DIAG_SCALE  diag scan pacing multiplier (default 1; 0.1 = command →
 *                   verdict in ~1.5 s instead of ~15 s)
 * Compressing the beat times gives a fast storyline for smoke tests.
 */

export const SIM_PORT = 8791;

export interface SimServerOptions {
  /** Listen port; 0 asks the OS for an ephemeral one (tests). Default 8791. */
  port?: number;
  seed?: number;
  /** Fleet size (SIM_UNITS), clamped by the engine to 8–500. Default 8. */
  units?: number;
  timeline?: Partial<IncidentTimeline>;
  /** Diagnostic scan pacing (tests compress it; see DEFAULT_DIAG_TIMELINE). */
  diagTimeline?: Partial<DiagTimeline>;
  /** SAFE SIT pacing (tests compress it; see DEFAULT_SIT_TIMELINE). */
  sitTimeline?: Partial<SitTimeline>;
  /** N-03 blocked-navigation beats (see DEFAULT_NAV_TIMELINE). */
  navTimeline?: Partial<NavTimeline>;
  /** Firmware-cohort beats + rollback pacing (see DEFAULT_COHORT_TIMELINE). */
  cohortTimeline?: Partial<CohortTimeline>;
  /** How often the host clock drives engine.advance(). Default 100 ms (the batch interval). */
  tickMs?: number;
  log?: (line: string) => void;
}

export interface SimServer {
  /** The actual bound port (useful when created with port 0). */
  port: number;
  clientCount(): number;
  close(): Promise<void>;
}

export function startSimServer(options: SimServerOptions = {}): Promise<SimServer> {
  const port = options.port ?? SIM_PORT;
  const tickMs = options.tickMs ?? 100;
  const log = options.log ?? ((line: string) => console.log(line));

  const startedAt = Date.now();
  const engine = createSimEngine({
    seed: options.seed,
    unitCount: options.units,
    timeline: options.timeline,
    diagTimeline: options.diagTimeline,
    sitTimeline: options.sitTimeline,
    navTimeline: options.navTimeline,
    cohortTimeline: options.cohortTimeline,
    startTimeMs: startedAt,
  });

  const wss = new WebSocketServer({ port });

  const broadcast = (messages: FleetMessage[]): void => {
    if (messages.length === 0) return;
    const frames = messages.map((m) => JSON.stringify(m));
    for (const client of wss.clients) {
      if (client.readyState !== client.OPEN) continue;
      for (const frame of frames) client.send(frame);
    }
  };

  /**
   * The last `PREROLL_MS` of telemetry this run has already broadcast.
   *
   * The worker host manufactures its history at connect, because a page load
   * is the start of its run. This process has been going the whole time, so
   * its history is simply what it already said — kept so a console that joins
   * ten seconds in is handed the same window as one that joins at minute ten,
   * and so `pnpm dev` behaves like the artifact that ships rather than like a
   * console whose trend watch is permanently ten seconds behind.
   */
  const history: TelemetryMessage[] = [];

  const interval = setInterval(() => {
    const out = engine.advance(Date.now() - startedAt);
    for (const m of out) if (m.t === "telemetry") history.push(m);
    const cutoff = (history.at(-1)?.ts ?? 0) - PREROLL_MS;
    let stale = 0;
    while (stale < history.length && history[stale]!.ts < cutoff) stale += 1;
    if (stale > 0) history.splice(0, stale);
    broadcast(out);
  }, tickMs);

  wss.on("connection", (socket: WebSocket) => {
    // Greet with current state, then replay this run's alerts so a client
    // joining (or refreshing) mid-incident still gets the full alert feed,
    // then replay any in-flight scan's diag_events so far — the incident
    // store adopts an in-flight scan on scan_start, so a page refreshed
    // mid-descent resumes coherently instead of stranding in operator space —
    // then replay in-flight SAFE SIT command_events, so a client joining
    // mid-maneuver sees the command executing (the command store rebuilds
    // pending/progress from them), then replay an in-flight staged rollback's
    // fleet_command_events — firmware itself needs no replay, the snapshot
    // carries fw/fwPending per unit.
    socket.send(JSON.stringify(engine.snapshot()));
    for (const alert of engine.activeAlerts()) socket.send(JSON.stringify(alert));
    for (const ev of engine.activeDiagEvents()) socket.send(JSON.stringify(ev));
    for (const ev of engine.activeCommandEvents()) socket.send(JSON.stringify(ev));
    for (const ev of engine.activeFleetCommandEvents()) socket.send(JSON.stringify(ev));
    // After the greeting, never before: a snapshot seams the console's
    // telemetry channel, and history sent ahead of one lands on the far side
    // of that seam. Same contract as the worker host's pre-roll.
    for (const m of history) socket.send(JSON.stringify(m));
    log(`[sim] client connected (${wss.clients.size} total)`);

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        log("[sim] dropped non-JSON client frame");
        return;
      }
      const result = operatorCommandSchema.safeParse(parsed);
      if (!result.success) {
        log("[sim] dropped invalid OperatorCommand");
        return;
      }
      log(`[sim] command: ${result.data.c}`);
      broadcast(engine.handle(result.data));
    });

    socket.on("close", () =>
      log(`[sim] client disconnected (${wss.clients.size} total)`),
    );
    socket.on("error", () => socket.close());
  });

  return new Promise((resolve, reject) => {
    wss.on("error", reject);
    wss.on("listening", () => {
      const address = wss.address();
      const boundPort =
        typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: boundPort,
        clientCount: () => wss.clients.size,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(interval);
            for (const client of wss.clients) client.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// CLI entry: `pnpm sim`

const envInt = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
};

const envFloat = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const timeline: Partial<IncidentTimeline> = {};
  const onset = envInt("SIM_ONSET_MS");
  const amber = envInt("SIM_AMBER_MS");
  const red = envInt("SIM_RED_MS");
  if (onset !== undefined) timeline.onsetMs = onset;
  if (amber !== undefined) timeline.amberAtMs = amber;
  if (red !== undefined) timeline.redAtMs = red;

  const navTimeline: Partial<NavTimeline> = {};
  const navBlock = envInt("SIM_N03_BLOCK_MS");
  const navClear = envInt("SIM_N03_CLEAR_MS");
  if (navBlock !== undefined) navTimeline.blockAtMs = navBlock;
  if (navClear !== undefined) navTimeline.clearAtMs = navClear;

  const cohortTimeline: Partial<CohortTimeline> = {};
  const cohortOnset = envInt("SIM_COHORT_ONSET_MS");
  const cohortStagger = envInt("SIM_COHORT_STAGGER_MS");
  const cohortPendingAt = envInt("SIM_COHORT_PENDING_AT_MS");
  const cohortRollback = envInt("SIM_COHORT_ROLLBACK_MS");
  if (cohortOnset !== undefined) cohortTimeline.onsetMs = cohortOnset;
  if (cohortStagger !== undefined) cohortTimeline.staggerMs = cohortStagger;
  if (cohortPendingAt !== undefined) cohortTimeline.pendingAtMs = cohortPendingAt;
  if (cohortRollback !== undefined) cohortTimeline.rollbackPerUnitMs = cohortRollback;

  const diagScale = envFloat("SIM_DIAG_SCALE");
  const diagTimeline =
    diagScale === undefined
      ? undefined
      : scaleDiagTimeline(DEFAULT_DIAG_TIMELINE, diagScale);

  const units = envInt("SIM_UNITS");
  // Mirror the engine's clamp so the startup line reports the real fleet size.
  const clampedUnits = Math.min(
    MAX_UNIT_COUNT,
    Math.max(MIN_UNIT_COUNT, units ?? MIN_UNIT_COUNT),
  );
  startSimServer({
    port: envInt("SIM_PORT"),
    seed: envInt("SIM_SEED"),
    units,
    timeline,
    diagTimeline,
    navTimeline,
    cohortTimeline,
  })
    .then((server) => {
      const t = { ...DEFAULT_TIMELINE, ...timeline };
      const d = diagTimeline ?? DEFAULT_DIAG_TIMELINE;
      const n = { ...DEFAULT_NAV_TIMELINE, ...navTimeline };
      const co = { ...DEFAULT_COHORT_TIMELINE, ...cohortTimeline };
      console.log(
        `[sim] fleet simulator on ws://localhost:${server.port} (${clampedUnits} units)`,
      );
      console.log(
        `[sim] storyline: onset ${t.onsetMs / 1000}s -> amber ${t.amberAtMs / 1000}s -> red ${t.redAtMs / 1000}s (RESET_SIM replays)`,
      );
      console.log(
        `[sim] n-03: navigation blocked ${n.blockAtMs / 1000}s -> self-recovered ${n.clearAtMs / 1000}s (SIM_N03_* overrides)`,
      );
      console.log(
        `[sim] cohort: 2.4.1 ambers from ${co.onsetMs / 1000}s every ${co.staggerMs / 1000}s, queued install ${co.pendingAtMs / 1000}s, rollback ${co.rollbackPerUnitMs / 1000}s/unit (SIM_COHORT_* overrides)`,
      );
      console.log(
        `[sim] diagnostic: RUN_DIAGNOSTIC -> verdict in ~${d.verdictAtMs / 1000}s (SIM_DIAG_SCALE compresses)`,
      );
      const shutdown = () => {
        console.log("\n[sim] shutting down");
        void server.close().then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err: unknown) => {
      console.error("[sim] failed to start:", err);
      process.exit(1);
    });
}
