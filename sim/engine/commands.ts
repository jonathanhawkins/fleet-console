import { type FleetMessage, type OperatorCommand } from "@/lib/schema";
import { chapterSeekMs, type StorylineChapter } from "./chapters";
import { storylineCrossings } from "./crossings";
import { handleRunDiagnostic } from "./diagnostics";
import { initUnits } from "./fleet";
import { resolveByCalibration } from "./incident-offset";
import { buildRecalibration, handleRecalibrate } from "./recalibrate";
import { handleHaltRollout, handleRollbackCohort } from "./rollout";
import { handleSafeSit } from "./safe-sit";
import {
  findUnit,
  nowTotalMs,
  resetStoryline,
  snapshot,
  summarize,
  type EngineConfig,
  type EngineState,
  type UnitState,
} from "./state";

/**
 * Operator command intake and the per-unit command drain. Each command's
 * refusals and beats live with its own module; this file routes, and owns
 * RESET_SIM because a reset touches every storyline at once.
 */

/**
 * Emit every per-unit command beat due by totalMs; a `complete` retires its
 * session. The sit's settle beat emits a `unit_update` (posture is
 * snapshot-carried state); the recalibration's `complete` emits a
 * `diag_event` carrying the re-measured channel. Neither consequence is added
 * to `emitted`: late joiners read posture from the snapshot, and a completed
 * recalibration has no lifetime left to replay.
 */
export function drainCommands(
  cfg: EngineConfig,
  st: EngineState,
  totalMs: number,
): FleetMessage[] {
  const out: FleetMessage[] = [];
  for (const [unitId, session] of st.commandSessions) {
    while (session.pending.length > 0 && session.pending[0]!.atTotalMs <= totalMs) {
      const beat = session.pending.shift()!;
      let settled: UnitState | undefined;
      if (beat.consequence === "settle") {
        settled = findUnit(st, unitId);
        if (settled) settled.posture = "sitting";
      }
      out.push(beat.msg);
      if (settled) out.push({ t: "unit_update", unit: summarize(settled) });
      if (beat.consequence === "remeasure") {
        const evidence = buildRecalibration(cfg, st, unitId, session.slot);
        if (evidence) {
          out.push(evidence);
          // Evidence first: the measurement justifies the clear that follows it.
          if (evidence.ev.k === "recalibration" && evidence.ev.outcome === "cleared") {
            out.push(...resolveByCalibration(cfg, st, unitId, beat.atTotalMs));
          }
        }
      }
      if (beat.msg.ev.k === "complete") {
        st.commandSessions.delete(unitId); // maneuver over: nothing left to replay
      } else {
        session.emitted.push(beat.msg);
      }
    }
  }
  return out;
}

/**
 * RESET_SIM: restart the storyline from the current instant — same seed, same
 * character, same beats. Every in-flight scan, command and rollback vanishes
 * with the fresh fleet; alert ids and command seqs keep counting.
 */
function handleReset(cfg: EngineConfig, st: EngineState): FleetMessage[] {
  resetStoryline(st, initUnits(cfg.seed, cfg.unitCount), nowTotalMs(cfg, st));
  return [snapshot(st)];
}

/**
 * SEEK_STORYLINE: replay the run and stop just short of a chapter.
 *
 * A reset, then one wide crossing window. Seeking is a reset first because
 * beats do not un-fire: from 4:00 there is no way back to 2:00 except to start
 * the story again, and doing it unconditionally is what makes the chapter
 * button land on the same board every time it is pressed rather than on
 * whatever the last five minutes happened to leave behind.
 *
 * The window is `(0, target]` — the whole run up to the chapter, in one call.
 * Every storyline gates on `prevMs < at && curMs >= at`, so each beat in that
 * span fires exactly once and the fleet arrives carrying its history: the knee
 * already red when the cohort forms, because by 3:00 it is.
 */
function handleSeek(
  cfg: EngineConfig,
  st: EngineState,
  chapter: StorylineChapter,
): FleetMessage[] {
  const targetMs = chapterSeekMs(cfg, chapter);
  const startMs = nowTotalMs(cfg, st) - targetMs;
  resetStoryline(st, initUnits(cfg.seed, cfg.unitCount), startMs);
  return [snapshot(st), ...storylineCrossings(cfg, st, 0, targetMs)];
}

/** Apply an operator command; returns messages to broadcast. */
export function handleCommand(
  cfg: EngineConfig,
  st: EngineState,
  cmd: OperatorCommand,
): FleetMessage[] {
  switch (cmd.c) {
    case "RESET_SIM":
      return handleReset(cfg, st);
    case "SEEK_STORYLINE":
      return handleSeek(cfg, st, cmd.chapter);
    case "COMMAND_SAFE_SIT":
      return handleSafeSit(cfg, st, cmd);
    case "RECALIBRATE_JOINT":
      return handleRecalibrate(cfg, st, cmd);
    case "HALT_ROLLOUT":
      return handleHaltRollout(cfg, st);
    case "ROLLBACK_COHORT":
      return handleRollbackCohort(cfg, st, cmd);
    case "RUN_DIAGNOSTIC":
      return handleRunDiagnostic(cfg, st, cmd);
  }
}
