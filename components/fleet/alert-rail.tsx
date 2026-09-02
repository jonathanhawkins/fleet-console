"use client";

import * as React from "react";
import { selectAlerts, useFleetStore, type FleetState } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { deriveAlertViews, isOpen, type AlertView } from "./alert-lifecycle";
import { AlertRow } from "./alert-row";
import { UnitAuditLog } from "./audit-log";
import { selectCohortAlerts } from "./cohort-membership";
import { ConsoleButton, RegionNote, useNow } from "@/components/console";
import { useFirstVisitNudge } from "./first-visit-nudge";

/**
 * The alert feed: newest first, straight off the store, which already dedupes
 * by id and caps the list.
 *
 * The clock is read once, here, and handed down as a number per row — one
 * interval for the whole feed rather than one per row, and no row owning a
 * timer it would have to tear down. At three alerts that is a rounding error;
 * at the hundred the store will hold, it is the difference between a feed and
 * a hundred setIntervals. Every ticking duration on every row is a subtraction
 * against that one instant, so two rows can never disagree about what "now"
 * means (relative-time.ts).
 *
 * Lifecycle — who owns an alert, what escalated what, what closed it — is
 * derived in one pure pass (alert-lifecycle.ts) rather than per row, because
 * escalation is a fact about *pairs* of rows and no row can see it alone.
 *
 * Entrance: the row owns it (see AlertRow). React keys rows by alert id and
 * the store prepends, so an arriving alert is the only element that mounts and
 * therefore the only one that animates. No "is this new?" bookkeeping here —
 * which matters, because that bookkeeping is exactly the kind of render-time
 * mutation that a Strict Mode double render silently breaks.
 */

/**
 * The whole lifecycle record. A documented store field (lib/stores/README.md),
 * identity-stable between acks — the feed re-renders when someone takes or
 * closes an alert and at no other time.
 */
const selectAlertMetaAll = (s: FleetState) => s.alertMeta;

function useAlertViews(): AlertView[] {
  const alerts = useFleetStore(selectAlerts);
  const meta = useFleetStore(selectAlertMetaAll);
  return React.useMemo(() => deriveAlertViews(alerts, meta), [alerts, meta]);
}

/* ---------------------------------------------------------------------------
   The working view

   Default Open, and the feed keeps resolved alerts rather than deleting them:
   the audit trail is the point of this phase, and a console that quietly drops
   a row once someone deals with it cannot answer "what happened on your watch"
   an hour later. So resolution changes what a row *looks* like, and the filter
   changes what the operator is currently working from — two different
   questions, neither of which is served by forgetting.

   Module-level rather than React state because the count and the toggle live
   in the card's header (a sibling of this component, composed by the page)
   while the list lives here. The same pattern the cursor and the descent
   occlusion use: one variable, a subscription, no provider threaded through a
   server component.
--------------------------------------------------------------------------- */

export type AlertFilter = "open" | "all";

let alertFilter: AlertFilter = "open";
const filterListeners = new Set<() => void>();

function subscribeFilter(listener: () => void): () => void {
  filterListeners.add(listener);
  return () => {
    filterListeners.delete(listener);
  };
}

export function setAlertFilter(next: AlertFilter): void {
  if (next === alertFilter) return;
  alertFilter = next;
  for (const listener of filterListeners) listener();
}

export function useAlertFilter(): AlertFilter {
  return React.useSyncExternalStore(
    subscribeFilter,
    () => alertFilter,
    () => "open" as const,
  );
}

/** "1 unit" / "3 units" — the noun agrees with the number. */
function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function AlertRail() {
  const views = useAlertViews();
  const filter = useAlertFilter();
  /**
   * Cohort membership for the whole feed, looked up once and keyed by ALERT id.
   * Identity-stable while cohort truth holds (cohort-membership.ts), so the
   * feed re-renders when a group forms or dissolves and at no other time.
   */
  const cohortAlerts = useFleetStore(selectCohortAlerts);
  /**
   * At most one row wears the "start here" mark: the newest live alert about a
   * unit this session has not opened (first-visit-nudge.ts holds the whole
   * rule, including why a fleet incident outranks it). Computed over every
   * view rather than the visible slice on purpose — live implies open, and open
   * is in both filters' visible sets, so the marked row is always on screen.
   */
  const nudgeId = useFirstVisitNudge(views);
  const now = useNow();
  /**
   * One row open at a time. A feed with four expanded chronologies in it is a
   * feed you have to scroll to read, and the panel answers a question about one
   * alert — opening the next is the operator moving on, not adding a second
   * thing to compare.
   */
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const open = views.filter(isOpen);
  const visible = filter === "all" ? views : open;
  const resolved = views.length - open.length;

  const acknowledge = React.useCallback((alertId: string) => {
    // Straight to the store, not through a local pending flag: the ack IS the
    // state, and it is in the audit log before this callback returns.
    useFleetStore.getState().ackAlert(alertId);
  }, []);

  const toggle = React.useCallback((alertId: string) => {
    setExpanded((current) => (current === alertId ? null : alertId));
  }, []);

  if (views.length === 0) {
    return <RegionNote>Alerts appear here as they are raised.</RegionNote>;
  }

  if (visible.length === 0) {
    return (
      <RegionNote>
        No open alerts. {countLabel(resolved, "alert")} resolved this session.
      </RegionNote>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <ul>
        {visible.map((view) => (
          <li key={view.alert.id}>
            <AlertRow
              view={view}
              now={now}
              onAcknowledge={view.lifecycle === "open" ? acknowledge : undefined}
              expanded={expanded === view.alert.id}
              onToggle={toggle}
              cohortFw={cohortAlerts.get(view.alert.id)}
              nudge={view.alert.id === nudgeId}
              detail={
                <UnitAuditLog
                  unitId={view.alert.unitId}
                  dense
                  empty={
                    <p className="text-label tracking-normal text-ink-soft">
                      Nothing else recorded for this unit yet.
                    </p>
                  }
                />
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The feed header's trailing slot. Silent when the fleet is healthy — a
 * standing "0 active" is a number that exists only to be zero.
 *
 * It says both numbers, and that is the whole point. It used to read
 * "2 active" while the KPI band four inches above read "Active alerts 1", and
 * a first-time reader took the page as contradicting itself. Both numbers were
 * correct and neither said what it was counting: the feed counts *events* (an
 * amber followed by a red on N-07 is two rows below this header), the KPI
 * counts *units* (one troubled robot). Naming the currency in the label is the
 * fix — and printing both here means the two regions now explain each other
 * rather than argue: "2 events · 1 unit" is the sentence that makes "Units
 * alerting 1" obviously the same fact.
 *
 * It counts the rows actually on screen, filter and all, because it is the
 * label on a list: a header describing a set the operator cannot see would be
 * the same class of confusion in a new place.
 */
export function FleetAlertCount() {
  const views = useAlertViews();
  const filter = useAlertFilter();
  const visible = filter === "all" ? views : views.filter(isOpen);
  if (visible.length === 0) return null;
  const units = new Set(visible.map((v) => v.alert.unitId)).size;
  return (
    <span className="text-label text-ink-soft uppercase">
      {countLabel(visible.length, "event")} · {countLabel(units, "unit")}
    </span>
  );
}

const FILTERS: { value: AlertFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "all", label: "All" },
];

/**
 * Two words, and the quieter of them is the one you are not looking at.
 *
 * Toggle buttons rather than a select or a segmented control with a sliding
 * indicator: there are two states, both fit on the line, and `aria-pressed`
 * says exactly what a pressed filter is. It appears only once there is
 * something to filter — a control offering to hide nothing is chrome.
 */
export function AlertFilterToggle() {
  const views = useAlertViews();
  const filter = useAlertFilter();
  if (views.length === 0) return null;

  return (
    <div role="group" aria-label="Alert view" className="flex items-center gap-0.5">
      {FILTERS.map(({ value, label }) => {
        const active = filter === value;
        return (
          <ConsoleButton
            key={value}
            variant="ghost"
            size="sm"
            aria-pressed={active}
            className={cn("px-2", active ? "text-ink" : "text-ink-soft")}
            onClick={() => setAlertFilter(value)}
          >
            {label}
          </ConsoleButton>
        );
      })}
    </div>
  );
}

/** The card header's action slot: what is on screen, and what is being shown. */
export function AlertFeedControls() {
  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <FleetAlertCount />
      <AlertFilterToggle />
    </div>
  );
}
