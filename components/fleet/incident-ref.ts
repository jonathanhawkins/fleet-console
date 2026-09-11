"use client";

import { useIncidentStore } from "@/lib/stores";

/**
 * The two cheap things every surface wants to know about an incident, kept
 * away from the surface that renders one.
 *
 * Both of these used to live in `incident-history.tsx`, beside the chronology
 * table, the spans arithmetic and the report-opening machinery. That put a
 * static import path into all of it from anywhere that only wanted a reference
 * string or a yes/no — the part card, and the unit page deciding whether to
 * render the card at all — which meant the unit route shipped the whole
 * chronology renderer in its initial JS for a card most visits never open.
 *
 * A hook and a `replace` have no business dragging that along, so they live
 * here and the heavy module is reachable only through the lazy import.
 */

/**
 * A reference an operator could read aloud.
 *
 * The store's record id is `inc-N-07-1787356771820` — correct as a key, and
 * thirteen digits of epoch noise on a warm-white page whose whole discipline is
 * that everything on it is legible. This derives a short reference from the
 * same two facts (which unit, which moment), so it is exactly as stable and
 * exactly as unique, and it fits in a sentence.
 */
export function incidentRef(unitId: string, ts: number): string {
  return `INC-${unitId.replace("-", "")}-${ts.toString(36).toUpperCase()}`;
}

/** Does this unit have anything to show? Lets the page skip the whole card. */
export function useHasIncidentHistory(unitId: string): boolean {
  return useIncidentStore((s) => s.history.some((r) => r.unitId === unitId));
}
