"use client";

import { selectCohorts, useFleetStore, type CohortIncident, type FleetState } from "@/lib/stores";

/**
 * "Is this row part of the fleet incident?" — asked by four surfaces that have
 * no other reason to know about cohorts, and answered once.
 *
 * The rail, the map, the alert feed and the unit page all need the same fact in
 * slightly different keys, and each one asks it per row. `selectCohorts` is
 * already memoized on the fleet store's `units`/`alerts`/`alertMeta` identities
 * (lib/stores/cohortStore.ts) and keeps its array identity while cohort truth is
 * unchanged — so a second memo hung off that identity gives every consumer a
 * lookup table whose own identity is just as stable. A rail row can subscribe to
 * it bare, get back a string or `undefined`, and re-render only when its own
 * membership actually moves.
 *
 * Two keys, because two surfaces are counting different things. The rail and the
 * map are about **units**: this robot is one of the four. The feed is about
 * **alerts**: this ROW is one of the four, and the same unit's unrelated alert
 * (N-07's knee, three rows down) must not be swept into the group. Keying the
 * feed by unit would have quietly tagged it.
 */

let memoCohorts: readonly CohortIncident[] | null = null;
let memoUnits: ReadonlyMap<string, string> = new Map();
let memoAlerts: ReadonlyMap<string, string> = new Map();

function build(cohorts: readonly CohortIncident[]): void {
  if (cohorts === memoCohorts) return;
  memoCohorts = cohorts;
  if (cohorts.length === 0) {
    // One shared empty map rather than a fresh one: the quiet fleet is the
    // common case, and a new identity per commit there would re-render every
    // rail row on every alert in the product.
    if (memoUnits.size > 0) memoUnits = new Map();
    if (memoAlerts.size > 0) memoAlerts = new Map();
    return;
  }
  const units = new Map<string, string>();
  const alerts = new Map<string, string>();
  for (const cohort of cohorts) {
    cohort.unitIds.forEach((unitId, i) => {
      units.set(unitId, cohort.fw);
      const alertId = cohort.alertIds[i];
      if (alertId !== undefined) alerts.set(alertId, cohort.fw);
    });
  }
  memoUnits = units;
  memoAlerts = alerts;
}

/** unitId → the suspect firmware it is alerting on. Identity-stable; bare-safe. */
export const selectCohortMembers = (s: FleetState): ReadonlyMap<string, string> => {
  build(selectCohorts(s));
  return memoUnits;
};

/** alertId → the suspect firmware the row belongs to. Identity-stable; bare-safe. */
export const selectCohortAlerts = (s: FleetState): ReadonlyMap<string, string> => {
  build(selectCohorts(s));
  return memoAlerts;
};

/**
 * One unit's membership, as a primitive — the shape a virtualized rail row
 * wants, because `Object.is` on a string is what keeps 500 rows from
 * re-rendering when the fifth one joins the group.
 */
export function useCohortMember(unitId: string): string | undefined {
  return useFleetStore((s) => selectCohortMembers(s).get(unitId));
}

/** Tests and teardown only — the memo is module state, like the derivation's. */
export function resetCohortMembership(): void {
  memoCohorts = null;
  memoUnits = new Map();
  memoAlerts = new Map();
}
