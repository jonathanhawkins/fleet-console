"use client";

import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { type VerdictReport } from "@/lib/schema";
import {
  selectDiagPhase,
  selectUnit,
  selectUnitHistory,
  useFleetStore,
  useIncidentStore,
  type IncidentState,
} from "@/lib/stores";
import {
  ConsoleButton,
  needsAttention,
  type ConsoleButtonProps,
} from "@/components/console";
import { useDiagnosticView } from "@/lib/prefs/diagnostic-view";
import { runDiagnostic } from "./telemetry-command";

/* The diagnostic action and the one derivation every surface that offers it
   reads. One primary pill per screen: it belongs to the alert state only. */

/** Any diagnostic session, on any unit, in any phase but idle. */
const selectDiagBusy = (s: IncidentState): boolean => s.phase !== "idle";
const selectSessionUnitId = (s: IncidentState): string | undefined => s.session?.unitId;

/** The sim runs one scan at a time, so every run control is disabled at once. */
export const RUN_BLOCKED_REASON = "Diagnostic in progress";

/** True while any unit is being scanned — every run control is off. */
export function useDiagnosticBusy(): boolean {
  return useIncidentStore(selectDiagBusy);
}

export interface RunDiagnosticButtonProps extends Omit<
  ConsoleButtonProps,
  "onClick" | "children" | "disabled"
> {
  unitId: string;
  /** Sentence case, always: "Run diagnostic", "Run diagnostic again". */
  children?: React.ReactNode;
}

/**
 * `runDiagnostic` sends the wire command and opens the local session as one
 * call; never split the pair. Disabled, not hidden, with the reason described.
 */
export function RunDiagnosticButton({
  unitId,
  children = "Run diagnostic",
  variant = "secondary",
  ...props
}: RunDiagnosticButtonProps) {
  const busy = useDiagnosticBusy();
  const reasonId = React.useId();

  return (
    <>
      <ConsoleButton
        variant={variant}
        disabled={busy}
        aria-describedby={busy ? reasonId : undefined}
        onClick={() => runDiagnostic(unitId)}
        {...props}
      >
        {children}
      </ConsoleButton>
      {busy ? (
        <span id={reasonId} className="sr-only">
          {RUN_BLOCKED_REASON}
        </span>
      ) : null}
    </>
  );
}

/**
 * One derivation, two consumers: the banner renders every state but `none`;
 * the identity header renders the run control exactly when it is `none`.
 */
export type UnitDiagnosticState =
  /** Troubled, undiagnosed: the banner and its black pill. */
  | "raised"
  /** This unit's scan is open — descending or scanning. */
  | "running"
  /** This unit's verdict is in and has not been returned with yet. */
  | "complete"
  /** A diagnosis is on file recommending service; the unit is still troubled. */
  | "resolved"
  /** Nothing to say. The identity header carries the run control. */
  | "none";

export interface UnitDiagnostic {
  state: UnitDiagnosticState;
  /**
   * A machine-space session to go (back) into that the operator is not
   * watching; false while descending.
   *
   * Only ever true when machine space is the operator's chosen view. In the
   * calm default the scan and its verdict are already on the page, in the
   * diagnostic panel, so a control offering to "view" them would be offering a
   * second copy — and would quietly be a door into the surface the default
   * exists to keep shut.
   */
  viewable: boolean;
  /** The live session's verdict, in the `complete` state. */
  report: VerdictReport | null;
  /** The newest archived verdict for this unit, in the `resolved` state. */
  archived: VerdictReport | null;
}

const selectSessionReport = (s: IncidentState): VerdictReport | null =>
  s.session?.report ?? null;
const selectWatching = (s: IncidentState): boolean => s.watching;

export function useUnitDiagnostic(unitId: string): UnitDiagnostic {
  const unit = useFleetStore(selectUnit(unitId));
  const phase = useIncidentStore(selectDiagPhase);
  const sessionUnitId = useIncidentStore(selectSessionUnitId);
  const report = useIncidentStore(selectSessionReport);
  const watching = useIncidentStore(selectWatching);
  const view = useDiagnosticView();
  // Derived array selector, so useShallow (lib/stores/README.md).
  const history = useIncidentStore(useShallow(selectUnitHistory(unitId)));

  const mine = sessionUnitId === unitId;
  const archived = history[0]?.report ?? null;
  const viewable =
    mine &&
    !watching &&
    view === "machine" &&
    (phase === "scanning" || phase === "verdict");

  if (mine && (phase === "descending" || phase === "scanning")) {
    return { state: "running", viewable, report: null, archived };
  }
  if (mine && phase === "verdict") {
    return { state: "complete", viewable, report, archived };
  }

  // A clean scan is deliberately not `resolved`: nothing is outstanding.
  const serviceable = archived !== null && archived.anomaly !== "none";
  if (serviceable) return { state: "resolved", viewable, report: null, archived };

  if (unit && needsAttention(unit.status)) {
    return { state: "raised", viewable, report: null, archived };
  }
  return { state: "none", viewable, report: null, archived };
}

export interface ViewDiagnosticButtonProps extends Omit<ConsoleButtonProps, "onClick"> {
  children: React.ReactNode;
}

/** The door back into a scan the operator stepped out of; the store holds one session. */
export function ViewDiagnosticButton({
  children,
  variant = "secondary",
  ...props
}: ViewDiagnosticButtonProps) {
  return (
    <ConsoleButton
      variant={variant}
      onClick={() => useIncidentStore.getState().watchSession()}
      {...props}
    >
      {children}
    </ConsoleButton>
  );
}
