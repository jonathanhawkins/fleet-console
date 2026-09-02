"use client";

import {
  useCommandStore,
  FLEET_COMMAND_LABELS,
  type FleetCommandState,
} from "@/lib/stores";
import { cn } from "@/lib/utils";
import {
  haltReceipt,
  refusalNote,
  rollbackLine,
  rollbackRows,
  ROLLBACK_PHASE_COPY,
  type RollbackUnitRow,
} from "../cohort-copy";
import { ConsoleButton } from "../console-button";

/**
 * Put a finished lifecycle away; a no-op mid-flight by the store's own rule.
 * One per readout, because the halt and the rollback are two lifecycles with
 * two receipts. Clearing a receipt puts away a COMMAND, never the incident —
 * it is only offered while the incident is live.
 */
function ClearButton({ state }: { state: FleetCommandState }) {
  if (state.phase !== "complete" && state.phase !== "failed") return null;
  return (
    <ConsoleButton
      variant="ghost"
      size="sm"
      aria-label={`Clear ${FLEET_COMMAND_LABELS[state.cmd].toLowerCase()}`}
      onClick={() => useCommandStore.getState().dismissFleetCommand(state.cmd)}
    >
      Clear
    </ConsoleButton>
  );
}

/**
 * The halt: one sentence in every state. The engine answers HALT_ROLLOUT
 * synchronously, so there is no progress to draw — only the receipt.
 */
export function HaltReadout({
  state,
  dismissible,
}: {
  state: FleetCommandState;
  dismissible: boolean;
}) {
  const failed = state.phase === "failed";
  const receipt = haltReceipt(state.note);
  const note = failed ? refusalNote(state.reason) : null;

  return (
    <div
      data-slot="halt-readout"
      data-phase={state.phase}
      className="flex flex-col gap-1"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p
          aria-live="polite"
          className={cn("text-small font-medium", failed ? "text-alert-ink" : "text-ink")}
        >
          {failed
            ? // A refusal is the fleet's own words; carry them verbatim.
              `Refused — ${state.reason ?? "no reason given"}`
            : (receipt ?? "Halt accepted — awaiting the rollout program")}
        </p>
        {dismissible ? <ClearButton state={state} /> : null}
      </div>
      {note ? <p className="text-label tracking-normal text-ink-soft">{note}</p> : null}
    </div>
  );
}

/**
 * The staged rollback: one line of state and one row per unit. Every row's
 * state is read from firmware, never from the engine's narration
 * (`rollbackRows`), so it cannot drift from the rail and the map.
 */
export function RollbackReadout({
  state,
  roster,
  fwOf,
  fw,
  dismissible,
}: {
  /**
   * The walk, frozen at the press when this card saw it — otherwise the units
   * still on the suspect build (a card that came back mid-rollback lists what
   * is left rather than inventing what it missed).
   */
  roster: readonly string[];
  state: FleetCommandState;
  fwOf: (unitId: string) => string | undefined;
  fw: string;
  /** False once the incident is settled: the close-out is the only door out. */
  dismissible: boolean;
}) {
  const failed = state.phase === "failed";
  const note = failed ? refusalNote(state.reason) : null;

  const rows: RollbackUnitRow[] = failed
    ? []
    : rollbackRows(roster, fwOf, fw, state.phase);
  const restoredTo = rows.find((r) => r.phase === "restored")?.unitId;

  return (
    <div
      data-slot="rollback-readout"
      data-phase={state.phase}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p
          aria-live="polite"
          className={cn("text-small font-medium", failed ? "text-alert-ink" : "text-ink")}
        >
          {failed
            ? `Refused — ${state.reason ?? "no reason given"}`
            : rollbackLine(rows, state.phase, restoredTo ? fwOf(restoredTo) : undefined)}
        </p>
        {dismissible ? <ClearButton state={state} /> : null}
      </div>
      {note ? <p className="text-label tracking-normal text-ink-soft">{note}</p> : null}

      {rows.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <li
              key={row.unitId}
              data-slot="rollback-unit"
              data-unit={row.unitId}
              data-phase={row.phase}
              className="flex items-center gap-2.5 text-label tracking-normal"
            >
              {/* Empty ring waiting, half-inked underway, filled restored. */}
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full border border-ink-muted",
                  row.phase === "restored" && "border-nominal bg-nominal",
                  row.phase === "rolling-back" && "border-warn bg-warn/40",
                )}
              />
              <span className="w-12 shrink-0 tnum text-ink">{row.unitId}</span>
              <span className="text-ink-soft">{ROLLBACK_PHASE_COPY[row.phase]}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
