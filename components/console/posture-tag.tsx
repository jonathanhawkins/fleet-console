import * as React from "react";
import { type Posture } from "@/lib/schema";
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
