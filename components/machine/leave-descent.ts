"use client";

import { useIncidentStore } from "@/lib/stores";

/**
 * What "close" means, in one place, because it means two different things.
 *
 * The control in the session header, the Escape key and the minimized
 * verdict's strip all ask the same question — the operator wants out of
 * machine space — and the honest answer depends on whether the scan has
 * finished:
 *
 *   verdict   ascend *with* the conclusion. This is RETURN, exactly: the
 *             incident is archived and the unit page comes back holding it.
 *             A close that skipped the logging would throw away the only
 *             thing the descent produced, and it would do it through the
 *             control an operator reaches for without reading.
 *
 *   scanning  ascend *without* ending anything. The sim is executing the
 *             sequence; stopping it is not on offer (see the note in
 *             descent-overlay.tsx) and pretending to would be the console
 *             lying about a machine. So the session stays open in the store
 *             and keeps accumulating, the unit page shows its in-progress
 *             state with a way back in, and nothing is archived — because a
 *             diagnostic that never reached a verdict is not an incident.
 *
 * Deliberately not a hook: nothing renders because of this, it is read at the
 * moment of the press, and a stale phase captured in a closure is exactly the
 * bug that would archive a session that had not concluded.
 */
export function closeDescent(): void {
  const incident = useIncidentStore.getState();
  if (incident.phase === "verdict") incident.completeAscent();
  else incident.leaveSession();
}
