"use client";

import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  getUnitBuffers,
  selectTrendingUnits,
  selectUnit,
  selectUnitIds,
  useFleetStore,
  useUnitBattery,
  type TrendingUnit,
} from "@/lib/stores";
import { useCohortMember } from "./cohort-membership";
import {
  attentionRank,
  matchesFilter,
  selectUnits,
  setRailFilter,
  useRailFilter,
  useRailOrder,
} from "./fleet-rail-controls";
import {
  formatRecency,
  RegionNote,
  UNIT_CARD_HEIGHT,
  UNIT_CARD_TRENDING_HEIGHT,
  UnitCard,
  useNow,
} from "@/components/console";
import { useUnitPosture } from "./unit-posture-tag";

/**
 * The unit rail: every home in the fleet, live, filtered and ordered at the
 * operator's choice (fleet-rail-controls.tsx owns the header that drives
 * both, and the pure rules behind them).
 *
 * Virtualized at eight rows, which looks like overkill and is the point. The
 * fleet in this demo is eight homes; the product it is pretending to be has
 * thousands, and the difference between the two should be a number in a
 * snapshot, not a rewrite. Everything here is written for the larger number:
 * fixed row height (no measurement pass), small overscan, and a roving
 * tabindex so the tab order stays one stop deep however long the list gets.
 *
 * Subscription discipline (lib/stores/README.md): a telemetry batch still
 * cannot re-render the list — batches never touch `units`, only the telemetry
 * channel, which each row reads for itself. Filtering and ordering DO need a
 * second, rarer subscription (`selectUnits`, whole map, from the controls
 * file) to read every unit's id/name/status for the list itself to sort by;
 * that commits only on snapshot/alert/unit_update — a handful of times an
 * hour, same cost class as the existing `trending` subscription just below
 * it, never a 10 Hz batch. What keeps THAT subscription from becoming
 * everyone's problem is `FleetRailRow` being memoized: when the shell
 * re-renders for a reason that left a given row's own props untouched, React
 * skips that row's call entirely, so the row's OWN subscription — not the
 * shell's — is still the only thing that can make it re-render. Each row
 * subscribes to its own unit's summary and battery, so a batch for N-03
 * re-renders exactly one row — the one for N-03 — filtered, sorted, or
 * neither.
 */

/** Small on purpose: rows are cheap and the scroll is short. */
const OVERSCAN = 4;

/**
 * The most rows the rail ever shows at once.
 *
 * The scrollport's height is derived from its rows (below), not handed down
 * by the grid — which is what makes every visible row a whole row: a list
 * sized by the space around it ends wherever that space ends, and at 1440×900
 * that was halfway through N-08. Eight is the demo fleet, and the height the
 * shell was designed around (the stacked layout's 75dvh cap is "8 rows uncut
 * at the 768px floor"); a fleet of 500 gets the same eight and scrolls the
 * rest, which is what keeps the scrollport bounded and the virtualizer honest.
 */
export const MAX_VISIBLE_ROWS = 8;

/**
 * The floor: a fleet still reporting in (or a lost connection) must not fold
 * the shell up, because the map and the feed take their height from the rail.
 * A filter that matches nothing sits on the same floor — see the empty-filter
 * branch below.
 */
export const MIN_VISIBLE_ROWS = 4;

/**
 * The rail scrollport's height, in px, from its rows.
 *
 * A fleet that fits shows all of it: the sum of its rows' own heights, so a
 * row that grows a line (trending) grows the rail by that line rather than
 * scrolling the last row's feet out of view. A fleet that does not fit shows
 * MAX_VISIBLE_ROWS of standard rows — a scrolling list, where a cut row at the
 * bottom is the affordance that says there is more, and a fixed figure that
 * no trend can nudge.
 */
export function railScrollportHeight(
  count: number,
  sizeOf: (index: number) => number,
): number {
  if (count > MAX_VISIBLE_ROWS) return UNIT_CARD_HEIGHT * MAX_VISIBLE_ROWS;
  let height = 0;
  for (let i = 0; i < count; i += 1) height += sizeOf(i);
  return Math.max(height, UNIT_CARD_HEIGHT * MIN_VISIBLE_ROWS);
}

export function FleetRail() {
  const unitIds = useFleetStore(selectUnitIds);
  const units = useFleetStore(selectUnits);
  /**
   * The rail's third subscription, and the exception that proves the rule
   * above: row *height* is the list's business, not a row's, so the one fact
   * that changes it has to be known here.
   *
   * It costs the discipline nothing. `selectTrendingUnits` keeps its array
   * identity while trending truth is unchanged — and re-fits only the unit
   * whose samples moved, at most once a second — so ten batches a
   * second produce zero renders here and near-zero work. This list re-renders
   * when a unit enters or leaves the watch, which in the product is a handful
   * of times an hour, and in the demo is twice.
   */
  const trending = useFleetStore(selectTrendingUnits);
  const filterQuery = useRailFilter();
  const order = useRailOrder();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  // Set by a key press, consumed by the effect below: the row to focus may not
  // be mounted yet when the key is handled, so the focus is a *request*.
  const focusPending = React.useRef(false);

  const trendingIds = React.useMemo(
    () => new Set(trending.map((t) => t.unitId)),
    [trending],
  );

  /**
   * The rows actually on screen: filtered by id/home name, then — only in
   * attention-first — reordered by severity (attentionRank, fleet-rail-
   * controls.tsx). `Array#sort` has been stable since ES2019, so units tied
   * on rank keep `filtered`'s roster order for free; that IS the tiebreak,
   * not a second sort key to maintain.
   *
   * Cheap at 500 units (measured: a full filter + sort is well under a
   * millisecond), so this runs on every keystroke with no debounce — there is
   * no 100 ms budget to protect here.
   */
  const visibleIds = React.useMemo(() => {
    const query = filterQuery.trim().toLowerCase();
    const filtered = query
      ? unitIds.filter((id) => {
          const unit = units[id];
          return unit !== undefined && matchesFilter(unit, query);
        })
      : unitIds;
    if (order !== "attention") return filtered;
    return [...filtered].sort((a, b) => {
      const ua = units[a];
      const ub = units[b];
      const ra = ua ? attentionRank(ua.status, trendingIds.has(a)) : 3;
      const rb = ub ? attentionRank(ub.status, trendingIds.has(b)) : 3;
      return ra - rb;
    });
  }, [unitIds, units, trendingIds, filterQuery, order]);

  // Still no measurement pass: two known heights chosen by index, not a
  // ResizeObserver reading the DOM.
  const estimateSize = (index: number): number => {
    const unitId = visibleIds[index];
    return unitId !== undefined && trendingIds.has(unitId)
      ? UNIT_CARD_TRENDING_HEIGHT
      : UNIT_CARD_HEIGHT;
  };

  const virtualizer = useVirtualizer({
    count: visibleIds.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: OVERSCAN,
  });

  // The virtualizer memoizes its measurements on count/keys/size-cache and not
  // on the identity of `estimateSize`, so anything that can change what index
  // N is (a row starting to trend, a filter or sort reshuffling the list)
  // needs the cache dropped or the list keeps laying rows out at stale
  // heights. `visibleIds` changes for every one of those reasons — trending
  // truth is one of its own dependencies — so keying the effect on it alone
  // covers filtering, ordering AND trending in one place. Never runs on a
  // telemetry batch: nothing here is in the batch's write path.
  React.useEffect(() => {
    virtualizer.measure();
  }, [visibleIds, virtualizer]);

  React.useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;

    // The virtualizer may need a frame (or two, if it also has to scroll) to
    // mount the target row. Retry across a few frames rather than assuming.
    let frame = 0;
    let attempts = 0;
    const tryFocus = () => {
      const row = scrollRef.current?.querySelector<HTMLElement>(
        `[data-index="${activeIndex}"] [data-slot="unit-card"]`,
      );
      if (row) {
        row.focus();
        return;
      }
      attempts += 1;
      if (attempts < 3) frame = requestAnimationFrame(tryFocus);
    };
    frame = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(frame);
  }, [activeIndex]);

  const moveTo = React.useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, visibleIds.length - 1));
      focusPending.current = true;
      virtualizer.scrollToIndex(clamped, { align: "auto" });
      setActiveIndex(clamped);
    },
    [visibleIds.length, virtualizer],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    // Enter and Space are the anchor's own business; only traversal is ours.
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveTo(activeIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveTo(activeIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        moveTo(0);
        break;
      case "End":
        event.preventDefault();
        moveTo(visibleIds.length - 1);
        break;
      default:
        break;
    }
  };

  if (unitIds.length === 0) {
    return (
      <div
        data-slot="fleet-rail-scrollport"
        // A fleet that has not reported yet reserves the height it is about to
        // need, not the floor: every fleet this console has ever shown fills
        // MAX_VISIBLE_ROWS (eight units, or five hundred), so anything shorter
        // buys a layout shift the moment the snapshot lands. The floor is for
        // the branch below, where the operator's own filter emptied the list
        // and the height they are looking at is the height they asked for.
        style={{ height: UNIT_CARD_HEIGHT * MAX_VISIBLE_ROWS }}
        className="flex min-h-0 flex-col"
      >
        <RegionNote className="flex-1">
          Units appear here as the fleet reports in.
        </RegionNote>
      </div>
    );
  }

  // A fleet that reported in, filtered down to nothing. Distinct copy from
  // the empty-fleet branch above (the reason is different) and the same
  // floor beneath it (railScrollportHeight(0, …)) so a filter that matches
  // nothing does not fold the shell up either.
  if (visibleIds.length === 0) {
    return (
      <div
        data-slot="fleet-rail-scrollport"
        style={{ height: railScrollportHeight(0, () => UNIT_CARD_HEIGHT) }}
        className="flex min-h-0 flex-col"
      >
        <RegionNote className="flex-1">
          {`No units match “${filterQuery.trim()}.” `}
          <button
            type="button"
            onClick={() => setRailFilter("")}
            className="text-ink underline decoration-line-strong underline-offset-2 hover:text-ink-hover"
          >
            Clear the search
          </button>
          {` to see all ${unitIds.length}.`}
        </RegionNote>
      </div>
    );
  }

  // A list shorter than the fleet is possible mid-snapshot, or the operator's
  // own filter; keep the roving stop inside the list rather than pointing at
  // a row that is gone or was filtered out.
  const active = Math.min(activeIndex, visibleIds.length - 1);

  return (
    // An explicit height rather than `flex-1`: the rows size the scrollport
    // (railScrollportHeight), and the card and the grid row size themselves
    // from it, so the rail ends on a row boundary. `min-h-0` keeps it able to
    // *shrink* — in a viewport too short for MAX_VISIBLE_ROWS the stacked
    // layout's 75dvh row still wins and the list scrolls inside it — while
    // nothing lets it grow past its rows into empty card.
    <div
      ref={scrollRef}
      data-slot="fleet-rail-scrollport"
      style={{ height: railScrollportHeight(visibleIds.length, estimateSize) }}
      className="min-h-0 overflow-x-hidden overflow-y-auto"
    >
      <ul
        onKeyDown={onKeyDown}
        style={{ height: virtualizer.getTotalSize() }}
        className="relative w-full"
      >
        {virtualizer.getVirtualItems().map((row) => {
          const unitId = visibleIds[row.index];
          if (unitId === undefined) return null;
          return (
            <li
              key={unitId}
              data-index={row.index}
              className="absolute top-0 left-0 w-full"
              style={{ height: row.size, transform: `translateY(${row.start}px)` }}
            >
              <FleetRailRow
                unitId={unitId}
                index={row.index}
                active={row.index === active}
                onFocusRow={setActiveIndex}
                // Passed down rather than subscribed to per row: this component
                // already had to read the watch to size the row, and a second
                // subscription in the child would re-derive the same fact from
                // the same stable array on every commit for every row on screen.
                trend={trending.find((t) => t.unitId === unitId) ?? null}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface FleetRailRowProps {
  unitId: string;
  index: number;
  active: boolean;
  onFocusRow: (index: number) => void;
  /** This unit's thermal trend watch entry, or null. See the note at the call. */
  trend: TrendingUnit | null;
}

/**
 * One row's subscription boundary — the reason this is a component at all,
 * and now also the reason it is memoized.
 *
 * Both selectors return values that are `Object.is`-stable while this unit is
 * unchanged, so ten telemetry batches a second for seven other homes produce
 * zero renders here. `useUnitBattery` is a per-unit channel subscription
 * quantised to 0.1 %, which is what keeps even this unit's own batches from
 * re-rendering the row ten times a second.
 *
 * `React.memo` is what keeps the SHELL's own subscriptions (`units`, for
 * filtering and ordering) from becoming every row's problem: when the shell
 * re-renders for a reason that left THIS row's props untouched — another
 * unit's alert, a filter keystroke that still matches this unit, a re-sort
 * that left this unit at the same index — React skips the call rather than
 * re-running it and discarding an identical result. A row whose own props DID
 * change (it moved index, it gained or lost the roving tabindex) still
 * re-renders normally.
 */
function FleetRailRowImpl({
  unitId,
  index,
  active,
  onFocusRow,
  trend,
}: FleetRailRowProps) {
  const unit = useFleetStore(selectUnit(unitId));
  const battery = useUnitBattery(unitId);
  const posture = useUnitPosture(unitId);
  /**
   * A string or undefined, never an object: the row's fourth subscription has
   * to be as `Object.is`-stable as the other three or a fleet of 500 would
   * re-render whole every time an alert moved (cohort-membership.ts).
   */
  const cohortFw = useCohortMember(unitId);
  const now = useNow();

  if (!unit) return null;

  // A non-reactive read of the telemetry ring, refreshed by the one-second
  // clock rather than by the 10 Hz batch that writes it: recency is a coarse
  // fact and does not deserve a render per sample.
  const lastContact = getUnitBuffers(unitId)?.ts.last();

  return (
    <UnitCard
      unitId={unit.id}
      name={unit.name}
      status={unit.status}
      battery={battery}
      recency={formatRecency(lastContact, now)}
      posture={posture}
      // The unit's own firmware, shown only while it is in the group — and
      // taken from the summary rather than from the cohort, so the row prints
      // what this robot is running even in the instant between a rollback
      // restating its build and the derivation letting it go.
      fw={cohortFw !== undefined ? (unit.fw ?? null) : null}
      cohort={cohortFw !== undefined}
      trend={trend}
      tabIndex={active ? 0 : -1}
      onFocus={() => {
        if (!active) onFocusRow(index);
      }}
    />
  );
}

const FleetRailRow = React.memo(FleetRailRowImpl);
