"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { ConsoleButton, ConsoleCard } from "@/components/console";
import {
  BackToFleet,
  ComponentView,
  DescentOverlay,
  DiagnosticGate,
  IncidentBanner,
  IncidentReport,
  JointGrid,
  StatusTimeline,
  TelemetryCursorMeta,
  UnitIdentity,
  useHasIncidentHistory,
  useMarkUnitVisited,
} from "@/components/fleet";
import {
  selectHasUnitAuditLog,
  selectUnit,
  selectUnitIds,
  useAuditStore,
  useFleetStore,
} from "@/lib/stores";

/**
 * The unit drill-in, client-rendered end to end.
 *
 * Nothing on this page is fetched: the route carries an id, and every fact
 * about that id — its house, its status, sixty seconds of telemetry per joint
 * — is already in the stores that the root layout's transport has been filling
 * since the console opened. Server-rendering any of it would mean rendering a
 * unit's condition as of a moment that has already passed by the time it
 * reaches the browser.
 *
 * Two shapes, and the difference between them is the one that matters: a fleet
 * that has not reported in yet is not the same thing as an id that does not
 * exist, and a console that conflated them would tell an operator their robot
 * is gone every time the socket takes a moment.
 *
 * ## Waiting is the page, not a screen instead of it
 *
 * The unknown-id case is its own short page, below. The *waiting* case is not:
 * it is this page, with every region in its own honest empty state — the
 * identity says "Waiting for the fleet" and prints em-dashes, the timeline says
 * when it will start, and the eighteen instruments stand at their settled size
 * with "No reading yet" in them. That is what the prerendered HTML contains,
 * so the first snapshot *fills boxes that already exist* instead of replacing a
 * short centred sentence with a two-metre page.
 *
 * The difference is a measurement. This route prerenders as the waiting state
 * and swaps on the worker's first snapshot; when that swap changed the page's
 * height, the footer — the one settled element the initial viewport contained —
 * was pushed off screen, and Lighthouse recorded that single move as CLS 0.06.
 * Nothing else on the page shifted then and nothing shifts now; the fix was
 * never a min-height on a box, it was rendering the box.
 */
export function UnitDetail({ unitId }: { unitId: string }) {
  const fleetSize = useFleetStore(selectUnitIds).length;
  const unit = useFleetStore(selectUnit(unitId));

  // The receipt the fleet page's first-visit mark clears on: arriving here is
  // the visit, whichever of the four routes in the operator took (the feed row,
  // the rail card, the map pin, a pasted URL). Above the unknown-id branch
  // because hooks are unconditional, and correct there anyway — an id the fleet
  // does not recognise is still a unit page this operator has now seen.
  useMarkUnitVisited(unitId);

  // The fleet has reported and this id was not in it. Terminal, and short on
  // purpose: there are no instruments coming, so reserving room for them would
  // be the page holding space for a robot that does not exist.
  if (!unit && fleetSize > 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <BackToFleet />
        {/* The id is knowable from the URL alone, so the page still has a
            subject even when the fleet does not recognise it. */}
        <h1 className="tnum text-display text-ink">{unitId}</h1>
        <div className="flex flex-1 flex-col items-center justify-center gap-7 py-16 text-center">
          <p className="max-w-[34ch] text-body text-balance text-ink-soft">
            No unit with this id. The fleet may have changed since this link was made.
          </p>
          <ConsoleButton variant="secondary" asChild>
            <Link href="/">Back to fleet</Link>
          </ConsoleButton>
        </div>
      </div>
    );
  }

  return (
    <>
      <UnitIdentity unitId={unitId} />

      {/* Renders only while this unit needs something. It is the loudest object
          in operator space and it is allowed to be, because it is the only one
          and it holds the only primary action in the product. */}
      <IncidentBanner unitId={unitId} />

      {/* The scan, on the page that motivated it. Mounts with the session and
          leaves with it; the descent below is the same session, opted into. */}
      <DiagnosticGate unitId={unitId} />

      {/* What the descent left behind. Renders nothing until a scan has
          reached a verdict and the operator has come back up with it. */}
      <UnitIncidentLog unitId={unitId} />

      {/* The append-only record of this unit's session — raises, escalations,
          acks, scans, commands, resolutions — collapsed until asked for. It
          sits under the incident history because it is the evidence behind it,
          and there is no fleet-wide equivalent on purpose (audit-log.tsx). */}
      <UnitSessionLog unitId={unitId} />

      <ConsoleCard label="Status timeline" labelAs="h2">
        <StatusTimeline unitId={unitId} />
      </ConsoleCard>

      <ConsoleCard
        label="Joint telemetry"
        labelAs="h2"
        padding="none"
        // The card's meta line describes the window at rest and the cursor's
        // instant while the operator is scrubbing the grid. One slot, because
        // there is one instant under the cursor no matter which of the eighteen
        // strips it is over — and because a tooltip chasing the pointer across
        // a panel of instruments is exactly the dashboard clutter this page is
        // built against.
        action={<TelemetryCursorMeta unitId={unitId} />}
        className="overflow-hidden"
      >
        <JointGrid unitId={unitId} />
      </ConsoleCard>

      {/* The quiet one, and the last one on purpose: a picture of the robot
          rather than a reading off it. Everything three.js touches is behind a
          next/dynamic boundary inside this component and is fetched on scroll
          approach, so the page's initial JS does not know 3D exists. */}
      <ComponentView unitId={unitId} />

      {/* Renders nothing until the sim's `scan_start` arrives, then takes the
          viewport. It portals to the body rather than living in this column,
          because the page it covers includes the header and footer this route
          does not own — and because the operator page underneath has to be
          left completely alone (see the [data-descent] block in globals.css). */}
      <DescentOverlay unitId={unitId} />

      {/* Renders nothing until an operator opens an incident id, and is mounted
          all session anyway: the incident store archives a verdict and drops
          the traces behind it, so the report's evidence has to be kept as the
          scan ends rather than looked for afterwards (incident-report.ts). The
          document itself is a next/dynamic boundary inside this gate. */}
      <IncidentReport unitId={unitId} />
    </>
  );
}

/**
 * The incident log, card and all, or nothing.
 *
 * Split out so the empty case costs the page a null rather than an empty
 * bordered box with a heading over it — a section that exists only to say it
 * has no content is a section that should not have rendered.
 */
/**
 * Both of these are already conditional at runtime — the log renders nothing
 * without an incident, and the session list opens closed. But a runtime `if`
 * is not an import boundary: the modules shipped in this route's initial JS on
 * all eight units regardless, 12 KB gz of chronology rendering for a card most
 * visits never open. `useHasIncidentHistory` stays a normal import; it is a
 * store selector, and the page has to be able to ask the question cheaply
 * before deciding whether to fetch the answer.
 */
const IncidentHistory = dynamic(
  () => import("@/components/fleet/incident-history").then((m) => m.IncidentHistory),
  {
    ssr: false,
    // Its card is already on screen by the time this resolves — only the body
    // arrives late, so the body is what has to hold its place. One record's
    // worth of rhythm: a verdict line, its gap, and the row of references
    // under it, which is what a unit that has been diagnosed once shows.
    loading: () => <div className="min-h-[3.5rem]" />,
  },
);

const SessionLog = dynamic(
  () => import("@/components/fleet/audit-log").then((m) => m.SessionLog),
  {
    ssr: false,
    // The closed card is the card's own header row and nothing else, so the
    // fallback is that row. Safe to reserve because the gate below only
    // renders this once the log has entries — an empty one would be space
    // held for something that is never going to arrive.
    loading: () => <ConsoleCard label="Session log" labelAs="h2" padding="none" />,
  },
);

/**
 * The session log, or nothing — decided out here rather than inside the chunk.
 *
 * The module answers this question too, but only after it has been fetched,
 * which is the wrong order: a unit nobody has touched would pay for the whole
 * chronology renderer to be told it has nothing to render. Same bargain as the
 * incident log below it (incident-ref.ts).
 */
function UnitSessionLog({ unitId }: { unitId: string }) {
  const has = useAuditStore(selectHasUnitAuditLog(unitId));
  if (!has) return null;
  return <SessionLog unitId={unitId} />;
}

function UnitIncidentLog({ unitId }: { unitId: string }) {
  const has = useHasIncidentHistory(unitId);
  if (!has) return null;
  return (
    <ConsoleCard label="Incident history" labelAs="h2">
      <IncidentHistory unitId={unitId} />
    </ConsoleCard>
  );
}
