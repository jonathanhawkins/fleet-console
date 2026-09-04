/**
 * @/components/fleet — this app's regions.
 *
 * Everything here subscribes to lib/stores and is built out of the primitives
 * in @/components/console: the fleet page's map, rail, feed and header
 * numbers; the unit page's identity, banner, instruments, timeline, history
 * and report; the descent's gate; the component view's gate; the fleet
 * incident's card. The dependency runs one way — console never imports from
 * here (eslint.config.mjs) — which is what keeps the library a library.
 *
 * This barrel names only what app/ imports. Everything else is a plain module
 * import between siblings, and components/machine reaches the few modules it
 * shares with this layer by path. The lazily-loaded trees — the machine-space
 * stage, the R3F scene, the report documents, the cohort card — are
 * `next/dynamic` boundaries inside their gates and are deliberately NOT named
 * here: this barrel is in every route's initial JS, and anything it names
 * travels with it.
 */

/* -- the fleet page ------------------------------------------------------- */
export { FleetKpis, LiveConnectionStatus } from "./fleet-kpis";
export { FleetMap } from "./fleet-map";
export { FleetRail } from "./fleet-rail";
export { FleetRailControls } from "./fleet-rail-controls";
export { AlertFeedControls, AlertRail } from "./alert-rail";
export { CohortCard } from "./cohort-card";

/* -- the unit page -------------------------------------------------------- */
export { BackToFleet, UnitIdentity } from "./unit-identity";
export { IncidentBanner } from "./incident-banner";
export { IncidentHistory, useHasIncidentHistory } from "./incident-history";
export { IncidentReport } from "./incident-report-overlay";
export { JointGrid, TelemetryCursorMeta } from "./joint-grid";
export { StatusTimeline } from "./status-timeline";
export { SessionLog } from "./audit-log";
export { DescentOverlay } from "./descent-overlay";
export { ComponentView } from "./component-view";
export { useMarkUnitVisited } from "./first-visit-nudge";

/* -- the shell's wiring --------------------------------------------------- */
export { TelemetryProvider } from "./telemetry-provider";
export { SimReset } from "./sim-reset";
export { StorylineJump } from "./storyline-jump";
