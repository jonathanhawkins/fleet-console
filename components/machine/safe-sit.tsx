"use client";

import * as React from "react";
import { commandSafeSit } from "@/components/console";
import { useFleetStore } from "@/lib/stores";
import { ExecuteAction, type ManeuverSpec } from "./execute-action";
import { SIT_GATE_NOTE, SIT_GATE_SUFFIX, SIT_IMPACT } from "./safe-sit-copy";

/**
 * SAFE SIT: the first control in this console that moved a robot.
 *
 * Everything that makes commanding a robot safe — the confirmation that states
 * consequences before they happen, ABORT holding initial focus, Escape stopped
 * before it can ascend, focus never falling to `<body>` mid-maneuver, the
 * store-owned narration — lives in `execute-action.tsx`, because none of it is
 * about sitting down. What is about sitting down is here: what to
 * send, what it does to the unit, and when there is no longer any point.
 *
 * That last one is the mirror of RECALIBRATE's gate (recalibrate.tsx): a robot
 * that is already in a seated hold cannot be sat down again, the sim refuses it
 * in those words, and the two controls together read as a sequence rather than
 * a pair of alternatives. See SIT_GATE_SUFFIX.
 */
export const SAFE_SIT_SPEC: ManeuverSpec = {
  cmd: "COMMAND_SAFE_SIT",
  send: commandSafeSit,
  confirmTitle: "Confirm safe sit",
  impact: SIT_IMPACT,
  slot: "safe-sit-confirm",
};

export interface SafeSitActionProps {
  unitId: string;
  /**
   * The report's own wording for this recommendation ("Command safe sit").
   * Printed on the button and recorded against the incident on confirm, so the
   * incident history says the operator acted on *that* line of the report
   * rather than on a string this file made up.
   */
  action: string;
}

export function SafeSitAction({ unitId, action }: SafeSitActionProps) {
  const seated = useFleetStore((s) => s.units[unitId]?.posture) === "sitting";
  return (
    <ExecuteAction
      unitId={unitId}
      action={action}
      spec={SAFE_SIT_SPEC}
      gate={seated ? { suffix: SIT_GATE_SUFFIX, note: SIT_GATE_NOTE } : null}
    />
  );
}
