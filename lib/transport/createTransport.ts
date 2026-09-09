import { type TelemetryTransport } from "./types";
import { readStorylineResumeMs } from "@/lib/session/storyline-session";
import { WorkerTransport } from "./workerTransport";
import { DEFAULT_WS_URL, WsTransport } from "./wsTransport";

/**
 * Chooses the transport implementation by env flag:
 *
 *   NEXT_PUBLIC_TRANSPORT=ws      (default) — WsTransport → local sim server
 *   NEXT_PUBLIC_TRANSPORT=worker  — WorkerTransport, the identical sim inside
 *                                   a Web Worker for the static deploy.
 *
 * WsTransport knob:
 *   NEXT_PUBLIC_WS_URL         ws endpoint (default ws://localhost:8791)
 *
 * WorkerTransport knobs (the dev sim server's env knobs, NEXT_PUBLIC_-ed so
 * the static build — and Playwright against it — can pin the storyline):
 *   NEXT_PUBLIC_SIM_SEED       engine seed: same seed, same storyline
 *   NEXT_PUBLIC_SIM_UNITS      fleet size, 8–500        (SIM_UNITS twin)
 *   NEXT_PUBLIC_SIM_ONSET_MS   incident onset beat      (SIM_ONSET_MS twin)
 *   NEXT_PUBLIC_SIM_AMBER_MS   amber alert beat         (SIM_AMBER_MS twin)
 *   NEXT_PUBLIC_SIM_RED_MS     red alert beat           (SIM_RED_MS twin)
 *   NEXT_PUBLIC_SIM_N03_BLOCK_MS  N-03 nav-blocked beat (SIM_N03_BLOCK_MS twin)
 *   NEXT_PUBLIC_SIM_N03_CLEAR_MS  N-03 self-recovery    (SIM_N03_CLEAR_MS twin)
 *   NEXT_PUBLIC_SIM_COHORT_ONSET_MS    first cohort amber   (SIM_COHORT_ONSET_MS twin)
 *   NEXT_PUBLIC_SIM_COHORT_STAGGER_MS  raise cadence        (SIM_COHORT_STAGGER_MS twin)
 *   NEXT_PUBLIC_SIM_COHORT_PENDING_AT_MS  queued install    (SIM_COHORT_PENDING_AT_MS twin)
 *   NEXT_PUBLIC_SIM_COHORT_ROLLBACK_MS rollback pace / unit (SIM_COHORT_ROLLBACK_MS twin)
 *   NEXT_PUBLIC_SIM_DIAG_SCALE diag pacing multiplier   (SIM_DIAG_SCALE twin)
 *
 * NEXT_PUBLIC_ values are inlined at build time, so every read below is a
 * static `process.env.NEXT_PUBLIC_*` member expression — never dynamic.
 */

const envInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
};

const envFloat = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function createTransport(): TelemetryTransport {
  const kind = process.env.NEXT_PUBLIC_TRANSPORT ?? "ws";
  switch (kind) {
    case "ws":
      return new WsTransport({ url: process.env.NEXT_PUBLIC_WS_URL ?? DEFAULT_WS_URL });
    case "worker": {
      const onsetMs = envInt(process.env.NEXT_PUBLIC_SIM_ONSET_MS);
      const amberAtMs = envInt(process.env.NEXT_PUBLIC_SIM_AMBER_MS);
      const redAtMs = envInt(process.env.NEXT_PUBLIC_SIM_RED_MS);
      const timeline = {
        ...(onsetMs !== undefined ? { onsetMs } : {}),
        ...(amberAtMs !== undefined ? { amberAtMs } : {}),
        ...(redAtMs !== undefined ? { redAtMs } : {}),
      };
      const blockAtMs = envInt(process.env.NEXT_PUBLIC_SIM_N03_BLOCK_MS);
      const clearAtMs = envInt(process.env.NEXT_PUBLIC_SIM_N03_CLEAR_MS);
      const nav = {
        ...(blockAtMs !== undefined ? { blockAtMs } : {}),
        ...(clearAtMs !== undefined ? { clearAtMs } : {}),
      };
      const cohortOnsetMs = envInt(process.env.NEXT_PUBLIC_SIM_COHORT_ONSET_MS);
      const cohortStaggerMs = envInt(process.env.NEXT_PUBLIC_SIM_COHORT_STAGGER_MS);
      const cohortPendingAtMs = envInt(process.env.NEXT_PUBLIC_SIM_COHORT_PENDING_AT_MS);
      const cohortRollbackMs = envInt(process.env.NEXT_PUBLIC_SIM_COHORT_ROLLBACK_MS);
      const cohort = {
        ...(cohortOnsetMs !== undefined ? { onsetMs: cohortOnsetMs } : {}),
        ...(cohortStaggerMs !== undefined ? { staggerMs: cohortStaggerMs } : {}),
        ...(cohortPendingAtMs !== undefined ? { pendingAtMs: cohortPendingAtMs } : {}),
        ...(cohortRollbackMs !== undefined
          ? { rollbackPerUnitMs: cohortRollbackMs }
          : {}),
      };
      // The worker init schema requires a positive int; a zero/negative env
      // value must degrade to the default rather than invalidate the init.
      const unitsRaw = envInt(process.env.NEXT_PUBLIC_SIM_UNITS);
      return new WorkerTransport({
        seed: envInt(process.env.NEXT_PUBLIC_SIM_SEED),
        units: unitsRaw !== undefined && unitsRaw > 0 ? unitsRaw : undefined,
        timeline: Object.keys(timeline).length > 0 ? timeline : undefined,
        nav: Object.keys(nav).length > 0 ? nav : undefined,
        cohort: Object.keys(cohort).length > 0 ? cohort : undefined,
        diagScale: envFloat(process.env.NEXT_PUBLIC_SIM_DIAG_SCALE),
        // Only the worker resumes. The dev ws sim is a separate process whose
        // clock never stopped, so a reloaded page there rejoins a run already
        // in progress — there is nothing to wind forward.
        resumeAtMs: readStorylineResumeMs(),
        // The e2e builds compress the storyline into seconds and pin this to
        // 0: a pre-roll measured against the real timeline would play their
        // whole incident before the console was greeted.
        prerollMs: envInt(process.env.NEXT_PUBLIC_SIM_PREROLL_MS),
      });
    }
    default:
      throw new Error(
        `Unknown NEXT_PUBLIC_TRANSPORT "${kind}" (expected "ws" or "worker")`,
      );
  }
}
