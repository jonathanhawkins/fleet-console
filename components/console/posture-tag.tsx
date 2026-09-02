import * as React from "react";
import { type Posture } from "@/lib/schema";
import { selectUnit, useFleetStore } from "@/lib/stores";
import { cn } from "@/lib/utils";

/**
 * A unit that is sitting down, said quietly.
 *
 * The SAFE SIT maneuver leaves N-07 exactly where the story wants it: broken
 * and safe. The fault stays red — the actuator is still wrong and service is
 * still required — so posture cannot be folded into status without one of the
 * two facts eating the other. It is a second, smaller thing, and it renders as
 * one: a hairline outline against the status chip's tint, muted ink, no colour
 * of its own. Read the row and you get "Fault · Safe sit", which is the whole
 * sentence.
 *
 * Nothing renders for a walking unit, and nothing renders for a snapshot that
 * predates the field (`posture` is additive and optional on the wire —
 * lib/schema). Walking is the default state of a robot, and a fleet of eight
 * rows each announcing that its occupant is upright is a fleet of eight labels
 * carrying no information. The tag exists for the exception.
 */

export interface PostureTagProps extends React.ComponentPropsWithoutRef<"span"> {
  /** `undefined` reads as walking; see the note above. */
  posture?: Posture;
}

/** The word, where a caller needs it in a string (a row's accessible name). */
export function postureLabel(posture: Posture | undefined): string | null {
  return posture === "sitting" ? "Safe sit" : null;
}

export function PostureTag({ className, posture, ...props }: PostureTagProps) {
  const label = postureLabel(posture);
  if (label === null) return null;

  return (
    <span
      data-slot="posture-tag"
      data-posture={posture}
      className={cn(
        "inline-flex items-center rounded-pill border border-line px-2 py-0.5",
        "text-label whitespace-nowrap text-ink-soft uppercase",
        className,
      )}
      {...props}
    >
      {label}
    </span>
  );
}

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
