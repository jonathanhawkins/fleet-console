import { create } from "zustand";
import {
  type CommandEventMessage,
  type ExecutedCommand,
  type FleetCommand,
  type FleetCommandEventMessage,
} from "@/lib/schema";
import { FLEET_AUDIT_SCOPE, useAuditStore, type AuditEntry } from "./auditStore";

/**
 * Command store: the per-unit command state machine, driven entirely by
 * streamed command_events. The wire-side lifecycle is
 *
 * (UI sends COMMAND_SAFE_SIT) ──accepted──▶ pending ──progress──▶ progress
 * progress ──progress──▶ progress (pct/note advance)
 * progress ──complete──▶ complete · any ──failed──▶ failed
 *
 * `idle` and `confirming` are deliberately NOT here: whether a confirm dialog
 * is open is one component's business (like the verdict card's minimize).
 * This store begins at `accepted` — the first thing the machine said — and a
 * unit with no entry has no live command.
 *
 * **Out-of-order policy: seq is the ordering authority, per entry.** Every
 * command_event carries an engine-monotonic `seq`; an event whose seq is <=
 * the last one applied for that *entry* is dropped (stale delivery or replay —
 * same answer either way). A re-issued command starts at a higher seq, so it
 * replaces a terminal entry naturally. See the stores README, "Out-of-order
 * and replay policy".
 *
 * **An entry is `(unitId, cmd)`, not `unitId`.** One slot per unit was
 * safe while there was one executed command. With two, the unit's slot became a
 * lane shared by two lifecycles whose seqs are not comparable: the sim
 * allocates every beat of an accepted maneuver's narration at accept time, so a
 * refusal *issued later* carries a *higher* seq than a sit's own `complete`,
 * which is still two seconds away on the clock. Sharing one slot, that refusal
 * lands first and the completion is then dropped by the seq gate as stale —
 * "SAFE SIT COMPLETE" never renders, no `command-complete` receipt is ever
 * written, and the robot is in fact sitting. The displacement is the same bug
 * standing still: a finished maneuver's receipt vanishing under the next
 * command's, mid-session, with nothing saying it was replaced. Keyed by command
 * the two lifecycles gate independently and neither can answer for the other —
 * which is the fix the fleet slice below was born with, for the same reason.
 *
 * Terminal states (`complete` / `failed`) stay on screen until the UI calls
 * `dismissCommand(unitId, cmd)` — the operator saw the outcome and put it away
 * — or a snapshot restates the world.
 *
 * The FLEET slice is the same machine driven by
 * `fleet_command_event`s, keyed by command name instead of unit id
 * (`fleetCommands`), because HALT_ROLLOUT and ROLLBACK_COHORT act on the
 * rollout program, not on a robot. Its seq gate is per command entry (the
 * transport's ordering gate already enforces the single fleet lane); its
 * audit receipts are the fleet-scoped kinds — `rollback-started` on accepted,
 * `rollout-halted` / `rollback-complete` on complete, `command-failed` on a
 * refusal — all under FLEET_AUDIT_SCOPE.
 */

export type CommandPhase = "pending" | "progress" | "complete" | "failed";

/** Human-readable labels for executed commands (UI + audit summaries). */
export const COMMAND_LABELS: Record<ExecutedCommand, string> = {
  COMMAND_SAFE_SIT: "SAFE SIT",
  RECALIBRATE_JOINT: "RECALIBRATION",
};

/** Human-readable labels for fleet-scoped commands (UI + audit summaries). */
export const FLEET_COMMAND_LABELS: Record<FleetCommand, string> = {
  HALT_ROLLOUT: "HALT ROLLOUT",
  ROLLBACK_COHORT: "ROLLBACK COHORT",
};

/**
 * The key one command's lifecycle occupies on one unit.
 *
 * Both halves are in the key because both are in the identity: `N-07`'s sit and
 * `N-07`'s recalibration are two things the machine can be saying at once (see
 * the note at the top of this file). The separator cannot occur in either half
 * — unit ids are `N-07`-shaped and command names are SCREAMING_SNAKE — so the
 * key is unambiguous rather than merely unlikely to collide.
 */
export const commandKey = (unitId: string, cmd: ExecutedCommand): string =>
  `${unitId}::${cmd}`;

export interface UnitCommandState {
  /**
   * The unit this lifecycle belongs to. Redundant with the key's first half,
   * deliberately — the same way `FleetCommandState.cmd` restates its own key —
   * so a state read out of the map still says who it is about, and the status
   * rule can gather a unit's lifecycles without parsing keys.
   */
  unitId: string;
  cmd: ExecutedCommand;
  phase: CommandPhase;
  /** 0 while pending, the latest progress pct, 100 on complete. */
  pct: number;
  /** Latest progress note (machine voice, print verbatim); null before the first. */
  note: string | null;
  /** Refusal/failure reason (machine voice, print verbatim); failed phase only. */
  reason: string | null;
  /** Last applied seq — the out-of-order gate. */
  seq: number;
  /** ts of the last applied event (sim wall clock). */
  updatedAt: number;
}

/**
 * One fleet-scoped command's execution state — the same machine as
 * UnitCommandState, scoped to the fleet instead of a unit and keyed by the
 * command name, so a HALT_ROLLOUT refusal landing mid-rollback cannot clobber
 * the ROLLBACK_COHORT lifecycle the card is rendering. `fw` is the firmware
 * the command concerns, straight off the envelope.
 */
export interface FleetCommandState {
  cmd: FleetCommand;
  /** The firmware the command concerns (the halted rollout's build; the rolled-back cohort's). */
  fw: string | null;
  phase: CommandPhase;
  pct: number;
  note: string | null;
  reason: string | null;
  seq: number;
  updatedAt: number;
}

export interface CommandState {
  /**
   * Live commands, keyed by `commandKey(unitId, cmd)`; absent key = no live
   * lifecycle for that command on that unit. Entry identity moves per applied
   * event.
   */
  commands: Record<string, UnitCommandState>;
  /**
   * Live fleet-scoped commands, keyed by command name (HALT_ROLLOUT /
   * ROLLBACK_COHORT); absent key = no live lifecycle for that command.
   */
  fleetCommands: Record<string, FleetCommandState>;

  /** Feed every command_event message here (bindTransport does). */
  applyCommandEvent(msg: CommandEventMessage): void;
  /** Feed every fleet_command_event message here (bindTransport does). */
  applyFleetCommandEvent(msg: FleetCommandEventMessage): void;
  /**
   * A fleet_snapshot restated the world (fresh connect, reconnect, RESET_SIM):
   * live commands (per-unit AND fleet-scoped) and their seq gates clear. The
   * host replays the command_events of any still-in-flight sit — and the
   * fleet_command_events of an in-flight staged rollback — right after the
   * snapshot, so a genuinely live command rebuilds itself; one killed by
   * RESET_SIM does not.
   */
  applySnapshot(): void;
  /** UI: put away a finished (complete/failed) command. No-op mid-flight. */
  dismissCommand(unitId: string, cmd: ExecutedCommand): void;
  /** UI: put away a finished (complete/failed) fleet command. No-op mid-flight. */
  dismissFleetCommand(cmd: FleetCommand): void;
  reset(): void;
}

export const useCommandStore = create<CommandState>()((set) => ({
  commands: {},
  fleetCommands: {},

  applyCommandEvent: (msg) => {
    let audit: Omit<AuditEntry, "id"> | null = null;

    set((s) => {
      const key = commandKey(msg.unitId, msg.cmd);
      const prev = s.commands[key];
      if (prev !== undefined && msg.seq <= prev.seq) return s; // stale or replayed

      const label = COMMAND_LABELS[msg.cmd];
      const ref = `${msg.cmd}#${msg.seq}`;
      let next: UnitCommandState;
      switch (msg.ev.k) {
        case "accepted":
          next = {
            unitId: msg.unitId,
            cmd: msg.cmd,
            phase: "pending",
            pct: 0,
            note: null,
            reason: null,
            seq: msg.seq,
            updatedAt: msg.ts,
          };
          audit = {
            ts: msg.ts,
            kind: "command-accepted",
            unitId: msg.unitId,
            summary: `${label} accepted`,
            ref,
          };
          break;
        case "progress":
          next = {
            unitId: msg.unitId,
            cmd: msg.cmd,
            phase: "progress",
            pct: msg.ev.pct,
            note: msg.ev.note,
            reason: null,
            seq: msg.seq,
            updatedAt: msg.ts,
          };
          break; // progress is narration, not record: no audit entry
        case "complete":
          next = {
            unitId: msg.unitId,
            cmd: msg.cmd,
            phase: "complete",
            pct: 100,
            note: prev?.note ?? null,
            reason: null,
            seq: msg.seq,
            updatedAt: msg.ts,
          };
          audit = {
            ts: msg.ts,
            kind: "command-complete",
            unitId: msg.unitId,
            summary: `${label} complete`,
            ref,
          };
          break;
        case "failed":
          next = {
            unitId: msg.unitId,
            cmd: msg.cmd,
            phase: "failed",
            pct: prev?.pct ?? 0,
            note: prev?.note ?? null,
            reason: msg.ev.reason,
            seq: msg.seq,
            updatedAt: msg.ts,
          };
          audit = {
            ts: msg.ts,
            kind: "command-failed",
            unitId: msg.unitId,
            summary: `${label} failed: ${msg.ev.reason}`,
            ref,
          };
          break;
      }
      return { commands: { ...s.commands, [key]: next } };
    });

    if (audit !== null) useAuditStore.getState().append(audit);
  },

  applyFleetCommandEvent: (msg) => {
    let audit: Omit<AuditEntry, "id"> | null = null;

    set((s) => {
      const prev = s.fleetCommands[msg.cmd];
      if (prev !== undefined && msg.seq <= prev.seq) return s; // stale or replayed

      const label = FLEET_COMMAND_LABELS[msg.cmd];
      const ref = `${msg.cmd}#${msg.seq}`;
      const fw = msg.fw ?? prev?.fw ?? null;
      let next: FleetCommandState;
      switch (msg.ev.k) {
        case "accepted":
          next = {
            cmd: msg.cmd,
            fw,
            phase: "pending",
            pct: 0,
            note: null,
            reason: null,
            seq: msg.seq,
            updatedAt: msg.ts,
          };
          // The record for a staged rollback is its start and its completion.
          // HALT_ROLLOUT's accepted is deliberately not logged: the whole
          // lifecycle is synchronous and its one durable receipt is the
          // `rollout-halted` line below.
          if (msg.cmd === "ROLLBACK_COHORT") {
            audit = {
              ts: msg.ts,
              kind: "rollback-started",
              unitId: FLEET_AUDIT_SCOPE,
              summary:
                fw !== null ? `Staged rollback of ${fw} started` : `${label} started`,
              ref,
            };
          }
          break;
        case "progress":
          next = {
            cmd: msg.cmd,
            fw,
            phase: "progress",
            pct: msg.ev.pct,
            note: msg.ev.note,
            reason: null,
            seq: msg.seq,
            updatedAt: msg.ts,
          };
          break; // narration, not record — same rule as per-unit progress
        case "complete":
          next = {
            cmd: msg.cmd,
            fw,
            phase: "complete",
            pct: 100,
            note: prev?.note ?? null,
            reason: null,
            seq: msg.seq,
            updatedAt: msg.ts,
          };
          audit =
            msg.cmd === "HALT_ROLLOUT"
              ? {
                  ts: msg.ts,
                  kind: "rollout-halted",
                  unitId: FLEET_AUDIT_SCOPE,
                  // The engine's receipt line, verbatim — "ROLLOUT HALTED —
                  // N-05 REMAINS ON 2.3.7". The demonstrable non-event IS the
                  // record.
                  summary: prev?.note ?? `${label} complete`,
                  ref,
                }
              : {
                  ts: msg.ts,
                  kind: "rollback-complete",
                  unitId: FLEET_AUDIT_SCOPE,
                  summary:
                    fw !== null
                      ? `Staged rollback of ${fw} complete`
                      : `${label} complete`,
                  ref,
                };
          break;
        case "failed":
          next = {
            cmd: msg.cmd,
            fw,
            phase: "failed",
            pct: prev?.pct ?? 0,
            note: prev?.note ?? null,
            reason: msg.ev.reason,
            seq: msg.seq,
            updatedAt: msg.ts,
          };
          audit = {
            ts: msg.ts,
            kind: "command-failed",
            unitId: FLEET_AUDIT_SCOPE,
            summary: `${label} failed: ${msg.ev.reason}`,
            ref,
          };
          break;
      }
      return { fleetCommands: { ...s.fleetCommands, [msg.cmd]: next } };
    });

    if (audit !== null) useAuditStore.getState().append(audit);
  },

  applySnapshot: () => set({ commands: {}, fleetCommands: {} }),

  dismissCommand: (unitId, cmd) =>
    set((s) => {
      const key = commandKey(unitId, cmd);
      const c = s.commands[key];
      if (!c || (c.phase !== "complete" && c.phase !== "failed")) return s;
      const commands = { ...s.commands };
      delete commands[key];
      return { commands };
    }),

  dismissFleetCommand: (cmd) =>
    set((s) => {
      const c = s.fleetCommands[cmd];
      if (!c || (c.phase !== "complete" && c.phase !== "failed")) return s;
      const fleetCommands = { ...s.fleetCommands };
      delete fleetCommands[cmd];
      return { fleetCommands };
    }),

  reset: () => set({ commands: {}, fleetCommands: {} }),
}));

// ---------------------------------------------------------------------------
// narrow selectors

/**
 * One command's lifecycle on one unit (undefined = none). Identity moves only
 * on applied events.
 *
 * A control asks for *its own* command, which is why `cmd` is a parameter and
 * not something the caller filters out of the answer: a control that reads a
 * slot and then checks what came back is a control that can be handed the other
 * maneuver's words for one frame, and it was.
 */
export const selectUnitCommand =
  (unitId: string, cmd: ExecutedCommand) =>
  (s: CommandState): UnitCommandState | undefined =>
    s.commands[commandKey(unitId, cmd)];

const inFlight = (c: UnitCommandState): boolean =>
  c.phase === "pending" || c.phase === "progress";

/** Narration precedence: in flight first, then the machine's most recent word. */
const outranks = (c: UnitCommandState, best: UnitCommandState): boolean => {
  if (inFlight(c) !== inFlight(best)) return inFlight(c);
  if (c.updatedAt !== best.updatedAt) return c.updatedAt > best.updatedAt;
  return c.seq > best.seq;
};

/**
 * The one command a unit's *status rule* narrates: the live one if there is
 * one, else the machine's most recent word about that unit.
 *
 * Each control on the card reads its own entry (`selectUnitCommand`). The rule
 * at the bottom of machine space has no command of its own — it outlives every
 * card on the surface and narrates whatever the unit is doing — so with two
 * entries possible per unit ("SAFE SIT COMPLETE" awaiting dismissal beside a
 * running recalibration) the choice is made here, once, rather than invented in
 * the component.
 *
 * In flight outranks finished: a maneuver the robot is performing now is the
 * more load-bearing thing to be saying while it happens, and the sim runs at
 * most one per unit. Among finished ones the latest `updatedAt` wins — event
 * time, not seq, because seq is *allocation* order and the sim allocates a
 * whole narration up front, which would rank a refusal issued at t+2 s above a
 * completion that lands at t+4 s.
 *
 * Returns a stored object, never a derived one, so identity moves only when the
 * entry it picks does: safe bare (no `useShallow`).
 */
export const selectUnitLiveCommand =
  (unitId: string) =>
  (s: CommandState): UnitCommandState | undefined => {
    let best: UnitCommandState | undefined;
    for (const c of Object.values(s.commands)) {
      if (c.unitId !== unitId) continue;
      if (best === undefined || outranks(c, best)) best = c;
    }
    return best;
  };

/** One fleet command's live lifecycle (undefined = none). Identity moves only on applied events. */
export const selectFleetCommand =
  (cmd: FleetCommand) =>
  (s: CommandState): FleetCommandState | undefined =>
    s.fleetCommands[cmd];
