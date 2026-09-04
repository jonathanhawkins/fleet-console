"use client";

import * as React from "react";
import { type UnitStatus, type UnitSummary } from "@/lib/schema";
import { selectUnitIds, useFleetStore, type FleetState } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { ConsoleButton, needsAttention } from "@/components/console";

/**
 * The rail header's row: search, order, and what's on screen — split out of
 * fleet-rail.tsx once the pair of them together crossed the file-size
 * guideline (CLAUDE.md). Same relationship alert-lifecycle.ts has to
 * alert-rail.tsx: this file is the state and the pure rules, fleet-rail.tsx
 * is the list that steers by them.
 *
 * Filter and order are module state, not React state — the same
 * `useSyncExternalStore` pattern `alert-rail.tsx` uses for its Open/All
 * switch — because the count and the controls live in the card's header (a
 * sibling of the list, composed by the page) while the list they steer lives
 * one file over. Neither resets on a fleet snapshot: both are the operator's
 * standing preference for how to look at the rail, not sim state, exactly
 * like the alert feed's filter surviving a reconnect.
 */

let railFilter = "";
const railFilterListeners = new Set<() => void>();

function subscribeRailFilter(listener: () => void): () => void {
  railFilterListeners.add(listener);
  return () => {
    railFilterListeners.delete(listener);
  };
}

export function setRailFilter(next: string): void {
  if (next === railFilter) return;
  railFilter = next;
  for (const listener of railFilterListeners) listener();
}

export function useRailFilter(): string {
  return React.useSyncExternalStore(
    subscribeRailFilter,
    () => railFilter,
    () => "",
  );
}

export type RailOrder = "roster" | "attention";

let railOrder: RailOrder = "roster";
const railOrderListeners = new Set<() => void>();

function subscribeRailOrder(listener: () => void): () => void {
  railOrderListeners.add(listener);
  return () => {
    railOrderListeners.delete(listener);
  };
}

export function setRailOrder(next: RailOrder): void {
  if (next === railOrder) return;
  railOrder = next;
  for (const listener of railOrderListeners) listener();
}

export function useRailOrder(): RailOrder {
  return React.useSyncExternalStore(
    subscribeRailOrder,
    () => railOrder,
    () => "roster" as const,
  );
}

/**
 * The whole roster by id — read here, and by fleet-rail.tsx, ONLY to
 * filter/order the list (a list-level concern), never for row content. Not
 * exported: alert-rail.tsx keeps its own equally-narrow `selectAlertMetaAll`
 * local for the same reason, and fleet-rail.tsx imports this one by name
 * rather than each file declaring its own.
 */
export const selectUnits = (s: FleetState) => s.units;

/**
 * Case-insensitive substring match against id or home name. `query` arrives
 * already lower-cased — one `.toLowerCase()` per keystroke shared across up
 * to 500 units, rather than paying it once per unit.
 */
export function matchesFilter(
  unit: Pick<UnitSummary, "id" | "name">,
  query: string,
): boolean {
  return unit.id.toLowerCase().includes(query) || unit.name.toLowerCase().includes(query);
}

/**
 * Attention-first order's rank: alert before attention before trending before
 * nominal. `needsAttention` (console) draws the one line that matters first —
 * does this unit need the operator at all — and red versus amber splits what
 * is left of "yes".
 */
export function attentionRank(status: UnitStatus, trending: boolean): number {
  if (needsAttention(status)) return status === "red" ? 0 : 1;
  return trending ? 2 : 3;
}

/**
 * The rail header's trailing slot. Its own component, and its own
 * subscriptions, so that counting or searching the fleet cannot re-render the
 * fleet.
 *
 * Silent when the fleet has not reported in — same rule `FleetAlertCount`
 * uses. Unfiltered, it says the fleet's size ("500 units"); a live filter
 * switches it to what-of-what ("3 of 500"), because at that point the plain
 * count would be answering a question nobody asked.
 */
export function FleetUnitCount() {
  const unitIds = useFleetStore(selectUnitIds);
  const units = useFleetStore(selectUnits);
  const filterQuery = useRailFilter();
  if (unitIds.length === 0) return null;

  const query = filterQuery.trim().toLowerCase();
  if (!query) {
    return (
      // Hidden on a phone, where it is the one thing in this header a reader
      // can get by counting the list directly underneath it. The filtered
      // count below always shows: "3 of 8" is not derivable from the screen.
      <span className="hidden text-label text-ink-soft uppercase sm:inline">
        {unitIds.length} {unitIds.length === 1 ? "unit" : "units"}
      </span>
    );
  }

  const shown = unitIds.filter((id) => {
    const unit = units[id];
    return unit !== undefined && matchesFilter(unit, query);
  }).length;
  return (
    <span className="tnum text-label text-ink-soft uppercase">
      {shown} of {unitIds.length}
    </span>
  );
}

/**
 * The filter field. A native `<input>`, not a console primitive — the library
 * has no text field yet, and one one-off box does not earn a new primitive.
 *
 * `type="search"` for the implicit `searchbox` role and the platform's own
 * affordances (a mobile keyboard's search/go key); Escape is still handled
 * explicitly below rather than left to the browser, because jsdom (and some
 * browsers) do not clear a search input on Escape on their own, and the rail
 * needs that behavior to be certain, not incidental.
 *
 * Controlled by the module state above, so a keystroke here, the count in
 * this same header, and the list in fleet-rail.tsx agree in one commit.
 */
export function FleetRailFilterField() {
  const unitIds = useFleetStore(selectUnitIds);
  const query = useRailFilter();
  if (unitIds.length === 0) return null;

  return (
    <input
      type="search"
      value={query}
      onChange={(event) => setRailFilter(event.target.value)}
      onKeyDown={(event) => {
        // Clears rather than blurs: the operator is mid-search, not done with
        // the field, and a search that keeps eating keystrokes after Escape
        // would be a worse trap than one that does nothing extra.
        if (event.key !== "Escape") return;
        event.preventDefault();
        setRailFilter("");
      }}
      placeholder="Search units"
      aria-label="Search units"
      className={cn(
        "h-8 max-w-32 min-w-0 flex-1 rounded-pill border border-line bg-bg px-3.5",
        // A placeholder is text: --ink-soft, not the 3.31:1 --muted.
        "text-small text-ink placeholder:text-ink-soft sm:max-w-44",
      )}
    />
  );
}

const RAIL_ORDERS: ReadonlyArray<{ value: RailOrder; label: string }> = [
  { value: "roster", label: "Roster" },
  { value: "attention", label: "Attention first" },
];

/**
 * Two states, and the calm one is the default.
 *
 * The alert feed's Open/All switch, redrawn for the rail: toggle buttons
 * rather than a select, `aria-pressed` says exactly what is active, and it
 * appears only once there is a fleet to order — a control offering to
 * reorder nothing is chrome.
 */
export function FleetRailOrderToggle() {
  const unitIds = useFleetStore(selectUnitIds);
  const order = useRailOrder();
  if (unitIds.length === 0) return null;

  return (
    <div role="group" aria-label="Unit order" className="flex items-center gap-0.5">
      {RAIL_ORDERS.map(({ value, label }) => {
        const active = order === value;
        return (
          <ConsoleButton
            key={value}
            variant="ghost"
            size="sm"
            aria-pressed={active}
            className={cn("px-2", active ? "text-ink" : "text-ink-soft")}
            onClick={() => setRailOrder(value)}
          >
            {label}
          </ConsoleButton>
        );
      })}
    </div>
  );
}

/** The card header's action slot: search, order, and what's on screen. */
export function FleetRailControls() {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 sm:gap-x-3">
      <FleetRailFilterField />
      <FleetRailOrderToggle />
      <FleetUnitCount />
    </div>
  );
}
