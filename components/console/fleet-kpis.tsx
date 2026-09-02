"use client";

import {
  selectConnection,
  selectKpiAlerts,
  selectKpiAvgBattery,
  selectKpiNominal,
  selectTrendingUnits,
  selectUnitIds,
  useFleetStore,
} from "@/lib/stores";
import { type ConnectionStatus as TransportStatus } from "@/lib/transport/types";
import { ConnectionStatus, type ConnectionState } from "./connection-status";
import { StatGroup } from "./stat-group";

/**
 * The fleet header: four numbers and the state of the link.
 *
 * Every value here is a primitive the store already derives (`kpiNominal`,
 * `kpiAlerts`, `kpiAvgBattery`), so this component re-renders when a *number*
 * changes and not when telemetry arrives. Average battery is an integer in the
 * store, which means a fleet draining at a tenth of a percent a second moves
 * this component roughly once a minute rather than ten times a second. The
 * trend count is the same deal by a different route: `selectTrendingUnits`
 * re-fits only the unit a batch actually moved, and only once a second, then
 * keeps its array identity while trending truth is unchanged
 * (lib/stores/trendWatch.ts), so the length read from it is as stable as the
 * integers beside it — and as cheap.
 */
export function FleetKpis() {
  const fleetSize = useFleetStore(selectUnitIds).length;
  const nominal = useFleetStore(selectKpiNominal);
  const alerts = useFleetStore(selectKpiAlerts);
  const battery = useFleetStore(selectKpiAvgBattery);
  const trending = useFleetStore(selectTrendingUnits).length;

  // Until the fleet has reported in there is no honest number to print, and
  // "0 alerts" would be a claim about a fleet we have not heard from.
  const pending = fleetSize === 0;

  return (
    <>
      <StatGroup
        label="Units nominal"
        pending={pending}
        value={nominal}
        unit={`of ${fleetSize}`}
      />
      {/* "Units alerting", not "Active alerts". `kpiAlerts` counts
          troubled *units* — N-07 raising an amber and then a red is one robot
          in trouble, so this reads 1 while the feed below reads two events. As
          "Active alerts" that was a number labelled as the thing it is not, and
          a first-time reader read the two regions as contradicting each other.
          Sharing the first word with "Units nominal" is what makes the currency
          legible without a sentence of explanation: two labels, one noun, and
          the numbers beneath them are now comparable at a glance. No
          denominator — "1 of 8" would invite adding it to "6 of 8" and imply a
          partition the two KPIs do not make (status and alert-presence are
          different questions). */}
      <StatGroup
        label="Units alerting"
        pending={pending}
        value={alerts}
        tone={alerts > 0 ? "alert" : "ink"}
      />
      <StatGroup label="Avg battery" pending={pending} value={battery} unit="%" />
      {/* The predictive one, and the only KPI in the band that is a *forecast*
          rather than a count of what is already true. Its whole job is
          to be the quietest number here.

          No denominator, for the reason "Units alerting" has none: the watch
          partitions nothing — it is a subset of the nominal units, and "1 of 8"
          would invite reading it against the other two figures as if the three
          added up. And one deliberate step below alerting at every value: zero
          recedes to --ink-soft where alerting's zero holds full --ink, and the
          nonzero state takes --warn-ink bare where alerting takes --alert-ink.
          Trending sits UNDER amber; a band where it looked like amber would be
          a band that raised an alarm about a robot that is working fine. */}
      <StatGroup
        label="Trending"
        pending={pending}
        value={trending}
        tone={trending > 0 ? "warn" : "soft"}
      />
    </>
  );
}

/**
 * Five transport states, four things an operator needs to be told.
 *
 * `reconnecting` maps to `lost` rather than to `connecting`, which is the one
 * judgement call in this table. The distinction between "connecting" and
 * "reconnecting" is about the socket's history; what the operator needs to
 * know is whether the numbers on this page are still arriving. During a
 * reconnect they are not, so the page says so.
 */
export const CONNECTION_VIEW: Record<TransportStatus, ConnectionState> = {
  idle: "idle",
  connecting: "connecting",
  open: "live",
  reconnecting: "lost",
  closed: "lost",
};

export function LiveConnectionStatus() {
  const connection = useFleetStore(selectConnection);
  return <ConnectionStatus state={CONNECTION_VIEW[connection]} />;
}
