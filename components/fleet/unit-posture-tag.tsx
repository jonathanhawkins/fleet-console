"use client";

import { type Posture } from "@/lib/schema";
import { selectUnit, useFleetStore } from "@/lib/stores";
import { PostureTag, type PostureTagProps } from "@/components/console";

/**
 * One unit's posture: `UnitSummary.posture`, the wire's single authority.
 *
 * It arrives with every `fleet_snapshot` AND live on the settle beat's
 * `unit_update`, so a client that watched a sit complete flips in
 * place, and RESET_SIM's snapshot stands the fleet back up. The subscription
 * is the posture primitive itself — the tag re-renders only when the word
 * would change, not when the unit's battery restates.
 */
export function useUnitPosture(unitId: string): Posture | undefined {
  return useFleetStore((s) => selectUnit(unitId)(s)?.posture);
}

export interface UnitPostureTagProps extends Omit<PostureTagProps, "posture"> {
  unitId: string;
}

/** The tag, wired. For hosts that have a unit id and no posture in hand. */
export function UnitPostureTag({ unitId, ...props }: UnitPostureTagProps) {
  return <PostureTag posture={useUnitPosture(unitId)} {...props} />;
}
