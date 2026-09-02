"use client";

import * as React from "react";
import { isLive, type AlertView } from "./alert-lifecycle";
import { useHasCohortIncident } from "./cohort-card";

/**
 * The first-visit bias.
 *
 * A first-time viewer opens this console cold, watches the fleet raise its
 * alert, and then clicks a robot with nothing wrong with it. Everything the
 * page needed to say was already on screen — the rail chip flipped, the map pin
 * flipped, the feed grew a row — and none of it said *this one*. Eight healthy
 * units and one troubled one were being drawn with the same emphasis, and the
 * eye landed where it landed.
 *
 * ## What this is allowed to be
 *
 * Emphasis, not interruption. There is no navigation, no dialog, no toast, no
 * banner, and nothing that moves: the fleet page's calm IS the product (PRD §5),
 * and a console that grabbed the wheel the first time a robot got warm would be
 * a worse console that happened to demo better. What the nudge does is mark one
 * row — the one the operator has not dealt with yet — and then get out of the
 * way permanently the moment they have. Operator agency stands: every route to
 * every unit stays exactly where it was.
 *
 * ## Who qualifies
 *
 * The newest alert that is (1) still the live question and (2) about a unit this
 * session has never opened. Both halves matter and both are deliberately strict:
 *
 * - **Live**, not merely open — {@link isLive}, which excludes an alert somebody
 * has acknowledged and an amber a later red has taken over. Marking an acked
 * row would be the console telling an operator to go and look at the thing
 * they just claimed; marking a superseded amber would point at the row the
 * feed is simultaneously receding. Recession and this mark are the same
 * predicate read in opposite directions, so they can never both be true.
 * - **Unvisited**, which is why this file owns a set rather than a boolean. A
 * nudge that survived the visit would be a badge the operator cannot clear;
 * one that cleared on *any* visit would go quiet for an alert they have never
 * seen. It is per unit, and the visit is the receipt.
 *
 * Exactly one row is ever marked, and it is always on screen: live implies open,
 * open is in every filter's visible set (alert-rail.tsx), so no filter can hide
 * the row the mark is pointing at.
 *
 * ## The visited set is in memory, and that is the honest lifetime
 *
 * `sessionStorage` would outlive a reload, and a reload is exactly when this
 * console starts over: the sim restarts, the stores are empty, the audit log is
 * gone, the storyline replays from zero. A visited-set that survived that would
 * be the one fact in the product that remembers a fleet the rest of the app has
 * forgotten — and it would go quiet precisely for the person the nudge exists
 * for, the viewer who reloads to watch the incident again. So the set lives
 * and dies with the page, like everything else here.
 *
 * Module state with listeners rather than a store slice, for the reason
 * `setAlertFilter` and the descent's occlusion signal are: the writer is a route
 * (/unit/[id], on mount) and the reader is a component three files away on a
 * different route, with no common ancestor to hold it and nothing about it that
 * belongs in a store modelling what the *fleet* said. Copy-on-write, so the set
 * is identity-stable between visits and the feed re-renders when the operator
 * goes somewhere new and at no other time.
 */

/** The empty set, shared: the server snapshot and the reset both need one. */
const NONE: ReadonlySet<string> = new Set<string>();

let visited: ReadonlySet<string> = NONE;

const listeners = new Set<() => void>();

/**
 * Record that the operator has opened this unit's page. Idempotent — a second
 * visit notifies nobody, so the route may call it on every mount.
 */
export function markUnitVisited(unitId: string): void {
  if (visited.has(unitId)) return;
  const next = new Set(visited);
  next.add(unitId);
  visited = next;
  for (const listener of listeners) listener();
}

/** The bare fact, for a caller that is not a component. */
export function hasVisitedUnit(unitId: string): boolean {
  return visited.has(unitId);
}

/**
 * Forget every visit. Module state outlives a test's render, so a suite that
 * did not reset this would have its first case silence its second.
 */
export function resetVisitedUnits(): void {
  if (visited === NONE) return;
  visited = NONE;
  for (const listener of listeners) listener();
}

function subscribeVisited(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The set, identity-stable between visits (`useSyncExternalStore`-shaped). */
export function useVisitedUnits(): ReadonlySet<string> {
  return React.useSyncExternalStore(
    subscribeVisited,
    () => visited,
    () => NONE,
  );
}

/**
 * The route's end of the deal: arriving at a unit's page is the visit.
 *
 * On the page rather than on the feed row's click, because there are four ways
 * into a unit — the feed row, the rail card, the map marker, a pasted URL — and
 * only one of them is a click this feed can see. What clears the mark is having
 * *been there*, which is the thing the operator actually did.
 */
export function useMarkUnitVisited(unitId: string): void {
  React.useEffect(() => {
    markUnitVisited(unitId);
  }, [unitId]);
}

/**
 * Which row to mark, or null. Pure, and the whole of the judgement — the feed
 * renders a boolean and decides nothing (alert-lifecycle.ts's discipline).
 *
 * `views` arrives newest first, so the first qualifying row is the newest
 * qualifying row. An older alert on an unvisited unit is still a fair target
 * once the newer one is dealt with: the mark walks down the feed as the operator
 * works, rather than switching off at the top.
 */
export function selectNudgeAlertId(
  views: readonly AlertView[],
  visitedUnits: ReadonlySet<string>,
): string | null {
  for (const view of views) {
    if (!isLive(view)) continue;
    if (visitedUnits.has(view.alert.unitId)) continue;
    return view.alert.id;
  }
  return null;
}

/**
 * The rule, assembled: the newest live alert on an unvisited unit, unless the
 * page is already carrying a fleet incident.
 *
 * The cohort card outranks this absolutely and is not merely quieter alongside
 * it (useHasCohortIncident). When four robots fail on one build, the page's
 * subject stops being "which robot" — and a mark on one of those four rows
 * would be the console pointing at a symptom while the card above it names the
 * cause. The nudge comes back if the incident clears with alerts still standing.
 */
export function useFirstVisitNudge(views: readonly AlertView[]): string | null {
  const visitedUnits = useVisitedUnits();
  const suppressed = useHasCohortIncident();
  return React.useMemo(
    () => (suppressed ? null : selectNudgeAlertId(views, visitedUnits)),
    [views, visitedUnits, suppressed],
  );
}
