import { type FleetMessage, type OperatorCommand } from "@/lib/schema";
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

/** Apply an operator command; returns messages to broadcast. */
export function handleCommand(
  cfg: EngineConfig,
  st: EngineState,
  cmd: OperatorCommand,
): FleetMessage[] {
  switch (cmd.c) {
    case "RESET_SIM":
      return handleReset(cfg, st);
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
