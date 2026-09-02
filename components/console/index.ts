/**
 * @/components/console — the Fleet Console component library.
 *
 * Pure primitives and hooks: props in, markup out, no store subscriptions.
 * shadcn/Radix primitives live in components/ui and are internal — they are
 * wrapped here, themed by the token layer, and never imported by app code.
 * This folder may not import `lib/stores` or `components/fleet`; both fences
 * are lint rules (eslint.config.mjs). The store-wired regions built out of
 * these primitives live in components/fleet.
 *
 * Every component in here renders correctly in both spaces without a space
 * prop. If a component needs to know which world it is in, the token layer is
 * missing a slot — fix that first.
 *
 * This barrel names only what leaves the folder — what app/, components/fleet
 * and components/machine actually import. Everything else is a plain module
 * import between siblings, so the barrel cannot inflate the library's surface
 * or carry a module into a route's initial JS that nobody asked for.
 */

/* -- primitives ----------------------------------------------------------- */
export { ConsoleButton } from "./console-button";
export type { ConsoleButtonProps } from "./console-button";

export { ConsoleCard } from "./console-card";

export { SectionLabel } from "./section-label";
export type { SectionLabelProps } from "./section-label";

export { StatusChip } from "./status-chip";
export type { StatusChipStatus } from "./status-chip";

export { StatGroup } from "./stat-group";

export { BatteryMeter } from "./battery-meter";

export { Disclosure } from "./disclosure";

export { RegionNote } from "./region-note";

export { PostureTag } from "./posture-tag";
export type { PostureTagProps } from "./posture-tag";

export { UnitCard, UNIT_CARD_HEIGHT, UNIT_CARD_TRENDING_HEIGHT } from "./unit-card";
export type { UnitCardProps } from "./unit-card";

/* -- operator shell ------------------------------------------------------- */
export { ConnectionStatus } from "./connection-status";
export type { ConnectionState } from "./connection-status";

export { ConsoleFooter } from "./console-footer";
export { ConsoleHeader } from "./console-header";

/* -- vocabulary ------------------------------------------------------------
   The wire says `nominal | amber | red`; the tokens say `nominal | warn |
   alert`. One table, so a unit cannot be amber in one region and warn in
   another. joint-spec is what the console knows about a leg before any
   telemetry arrives: the six joints, their operator names, their envelopes. */
export {
  alertSeverityChip,
  alertSeverityCopy,
  needsAttention,
  unitStatusChip,
  unitStatusCopy,
} from "./unit-status";

export {
  envelope,
  JOINT_GRID_ORDER,
  JOINTS,
  jointLabel,
  METRIC_SPEC,
  METRICS,
  stripScales,
} from "./joint-spec";
export type { Envelope, Joint, MetricSpec, StripScales } from "./joint-spec";

export { formatRecency, isoTime, useNow } from "./relative-time";

/* -- the descent's contract -------------------------------------------------
   The motion timeline and the occlusion signal are shared by the gate
   (components/fleet/descent-overlay.tsx) and the stage (components/machine),
   so they live here, beneath both. */
export {
  DESCENT_ATTR,
  DESCENT_DIM_VAR,
  EASE_WIPE,
  descentTimeline,
  secs,
} from "./descent-motion";
export type { DescentTimeline } from "./descent-motion";

export {
  isDescentOccluded,
  setDescentOccluded,
  subscribeDescentOcclusion,
} from "./descent-occlusion";

export { REPORT_ATTR, usePageLock } from "./report-page-lock";

/* -- hooks and canvas plumbing -------------------------------------------- */
export { useMediaQuery, usePrefersReducedMotion } from "./use-reduced-motion";

export { frameSubscriberCount, registerFrame } from "./frame-loop";
