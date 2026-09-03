import Link from "next/link";
import { ConsoleCard, ConsoleHeader } from "@/components/console";
import {
  AlertFeedControls,
  AlertRail,
  CohortCard,
  FleetKpis,
  FleetMap,
  FleetRail,
  FleetRailControls,
  LiveConnectionStatus,
} from "@/components/fleet";

/**
 * The operator shell.
 *
 * A server component holding four client islands, one per thing that moves:
 * the KPI band, the map, the unit rail, the alert feed. Nothing on this page
 * lifts state — each island subscribes to its own narrow slice of the fleet
 * store, so a 10 Hz telemetry batch re-renders whichever islands display a
 * number that actually changed, and never the page.
 *
 * No black pill on this screen — with exactly one exception, and it is the
 * exception the rule was always going to grow (Phase 11). "Run diagnostic"
 * belongs to the unit that is failing, not to the fleet; when a firmware cohort
 * forms, the thing that is failing IS the fleet, and the pill goes on the card
 * that says so (cohort-card.tsx). It leaves with the incident.
 */
export default function FleetPage() {
  return (
    <>
      {/* Map network head start. React 19 hoists these into
          <head>, so the static export ships them in the prerendered HTML and
          the browser acts on them long before the maplibre chunk arrives:
          - preconnect: DNS + TCP + TLS to the tile origin overlap hydration
            instead of serializing after the style JSON parse.
          - preload: the style JSON rides the initial HTML parse instead of
            waiting for chunk -> hydrate -> map mount.
          Both carry crossOrigin="" (anonymous) because MapLibre fetches with
          Request defaults — mode "cors", credentials "same-origin" (verified
          in maplibre-gl/src/util/ajax.ts, no transformRequest in our map):
          an uncredentialed preconnect warms the exact connection pool those
          fetches use, and the preload only matches (no double fetch) when its
          mode matches. Fleet page only — /unit and /system never load a map. */}
      <link rel="preconnect" href="https://tiles.openfreemap.org" crossOrigin="" />
      <link rel="preload" as="fetch" href="/map/fleet-light.json" crossOrigin="" />

      <ConsoleHeader>
        <Link
          href="/system"
          className="rounded-sm text-label text-ink-soft uppercase transition-colors duration-[var(--dur-micro)] ease-console hover:text-ink"
        >
          Design system
        </Link>
        <LiveConnectionStatus />
      </ConsoleHeader>

      {/* Not pinned to the viewport. The rail's scrollport carries its own
          height now — its rows × MAX_VISIBLE_ROWS (fleet-rail.tsx) — so the
          virtualizer is bounded by the list, not by a 100dvh column, and the
          list ends on a row boundary instead of wherever the fold happened to
          fall (at 1440×900 that was halfway through N-08). The page grows as
          a document when the shell needs more than the viewport, which is what
          keeps a short window from clipping a region against the footer.
          Verified at SIM_UNITS=500: eight rows tall, the rest scrolls inside. */}
      <main
        id="main"
        className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6 px-5 py-6 sm:gap-8 sm:px-8 sm:py-8 md:gap-10 md:px-16 md:py-10 lg:px-24"
      >
        {/* The document owes a screen reader an h1; a sighted operator already
            has the mark and the KPI band, and a display heading here would be
            the loudest thing on a page whose whole point is that nothing is
            happening. */}
        <h1 className="sr-only">Fleet overview</h1>

        {/* A fixed grid on a phone rather than a wrapping row. Wrapped, the
            band answers "is everything okay" in two glances and a scroll —
            three numbers, then a fourth on its own line, which reads as an
            afterthought rather than as one of four. Two columns rather than
            the three this held before "Trending" joined it: four
            across a 375px screen is four one-line labels shrunk past reading,
            and 3+1 is the orphan the grid exists to avoid. A 2×2 block keeps
            every label on one line and every figure on one of two baselines,
            which is why the two-line min-height that used to reserve space for
            wrapping labels is gone with it. */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-6 sm:flex sm:flex-wrap sm:gap-x-16">
          <FleetKpis />
        </dl>

        {/* The fleet incident, when there is one (Phase 11).

            Above the three regions rather than inside the feed's column, and
            that placement is the argument: a cohort changes the subject of the
            whole page from "which robot" to "which build", which is a question
            none of the three regions can answer on its own. It takes their
            space while it exists and gives it back when it resolves — the same
            deal the unit page's incident banner makes with the instrument grid,
            one level up. Renders nothing at all on a healthy fleet. */}
        <CohortCard />

        {/* Content-sized on purpose (no `flex-1`): the rail column's height is
            its header plus whole rows, and at ≥64rem the rail spans both grid
            rows, so its height is the grid's — the map and the feed split what
            the rail measures (1fr : 0.4fr) and the three regions bottom out on
            the same line at 1024, 1280 and 1440 wide. Stretching the grid to
            the viewport would hand the rail card space its rows cannot fill. */}
        <div className="shell-grid">
          {/* map: MapLibre canvas, edge to edge. Lazy — maplibre-gl is the
              heaviest dependency in the product and never runs on the server. */}
          <ConsoleCard
            variant="plain"
            padding="none"
            label="Fleet map"
            labelAs="h2"
            // Full-bleed on a phone. The map is the one region here that is a
            // picture rather than a reading, and a picture inset 24px on each
            // side of a 375px screen is a stamp: it loses the street pattern
            // that tells an operator these are eight houses in one town. It
            // reclaims its corners and its gutters below `sm` and is a card
            // again from there up, where the page has width to spend.
            className="flex min-h-0 flex-col overflow-hidden [grid-area:map] max-sm:-mx-5 max-sm:rounded-none"
          >
            <FleetMap />
          </ConsoleCard>

          {/* rail: virtualized UnitCard list. Body scrolls, header stays put. */}
          <ConsoleCard
            variant="plain"
            padding="none"
            label="Units"
            labelAs="h2"
            action={<FleetRailControls />}
            className="flex min-h-0 flex-col overflow-hidden [grid-area:rail]"
          >
            <FleetRail />
          </ConsoleCard>

          {/* feed: newest first, and the only region on this page allowed to
              raise its voice — via StatusChip, not via chrome. The header slot
              carries what is on screen ("2 events · 1 unit") and the Open/All
              switch that decides it; resolved alerts stay in the feed, because
              the audit trail is the point (alert-rail.tsx). */}
          <ConsoleCard
            variant="plain"
            padding="none"
            label="Alerts"
            labelAs="h2"
            action={<AlertFeedControls />}
            className="flex min-h-0 flex-col overflow-hidden [grid-area:feed]"
          >
            <AlertRail />
          </ConsoleCard>
        </div>
      </main>
    </>
  );
}
