"use client";

import * as React from "react";
import { commandRecalibrate } from "@/components/fleet/telemetry-command";
import { useFleetStore } from "@/lib/stores";
import { ExecuteAction, type ManeuverSpec } from "./execute-action";
import { RECAL_GATE_NOTE, RECAL_GATE_SUFFIX, recalImpact } from "./recalibrate-copy";

/**
 * RECALIBRATE JOINT: the cheapest rung on the recovery ladder, and — since
 * a real one.
 *
 * ## Why the sit is its precondition and not its neighbour
 *
 * A calibration sweep drives the joint through its range. Doing that to a knee
 * the robot is standing on is the failure SAFE SIT exists to prevent, so this
 * control is inert until the unit's posture is "sitting" — the same gate
 * DISABLE JOINT carries, for the same physical reason, and the reason the three
 * recommendations on the verdict card finally read as a *procedure* rather than
 * as a menu. Sit the robot down, then work on it.
 *
 * The gate is not the only thing standing between this button and a driven
 * joint: the sim refuses an unseated RECALIBRATE with REQUIRES SEATED POSTURE
 * whatever the console believes. A physical precondition enforced only by the
 * client is a precondition enforced by nobody.
 *
 * Posture is read live from the fleet store as a primitive subscription, so
 * this re-renders only when the posture value itself moves — and the gate lifts
 * without a remount: SAFE SIT completes, the settle beat's `unit_update` flips
 * posture, and the same button enables in place. An unknown unit gates closed:
 * the schema reads absent posture as "walking", and a safety gate fails safe.
 *
 * ## Why the spec is assembled rather than declared
 *
 * Everything about the maneuver is the same on every fault except one line of
 * the confirmation. The third impact line states the *limit* of a calibration,
 * and a limit is a property of the diagnosis rather than of the button: a gain
 * table is not a tendon, an encoder datum is not a mounting bracket. Since
 * there are two scripted faults and one of them is not a gain fault,
 * so a constant spec would put a sentence about gain in front of an operator
 * whose robot has none. Memoized on the anomaly, because `ExecuteAction` holds
 * the spec and a fresh object every render is a new spec for the same command.
 */
const RECALIBRATE_BASE = {
  cmd: "RECALIBRATE_JOINT",
  send: commandRecalibrate,
  confirmTitle: "Confirm recalibration",
  slot: "recalibrate-confirm",
} as const satisfies Omit<ManeuverSpec, "impact">;

export interface RecalibrateActionProps {
  unitId: string;
  /** The report's own wording ("Recalibrate joint"). */
  action: string;
  /**
   * What the scan concluded — the field the confirmation's limit line is keyed
   * by. Absent falls back to the general statement, which is true of every
   * calibration and specific to none.
   */
  anomaly?: string;
}

export function RecalibrateAction({ unitId, action, anomaly }: RecalibrateActionProps) {
  const seated = useFleetStore((s) => s.units[unitId]?.posture) === "sitting";
  const spec = React.useMemo<ManeuverSpec>(
    () => ({ ...RECALIBRATE_BASE, impact: recalImpact(anomaly ?? "") }),
    [anomaly],
  );
  return (
    <ExecuteAction
      unitId={unitId}
      action={action}
      spec={spec}
      gate={seated ? null : { suffix: RECAL_GATE_SUFFIX, note: RECAL_GATE_NOTE }}
    />
  );
}
