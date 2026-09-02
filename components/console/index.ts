/**
 * @/components/console — the Fleet Console component library.
 *
 * This barrel is the app's only door into the UI layer. shadcn/Radix primitives
 * live in components/ui and are internal: they are wrapped here, themed by the
 * token layer, and never imported by app code (enforced in eslint.config.mjs).
 *
 * Every component in here renders correctly in both spaces without a space prop.
 * If a component needs to know which world it is in, the token layer is missing
 * a slot — fix that first.
 */
/* -- primitives ----------------------------------------------------------- */
export { ConsoleButton, consoleButtonVariants } from "./console-button";
export type { ConsoleButtonProps } from "./console-button";

export { ConsoleCard, consoleCardVariants } from "./console-card";
export type { ConsoleCardProps } from "./console-card";

export { SectionLabel, sectionLabelVariants } from "./section-label";
export type { SectionLabelProps } from "./section-label";

export { StatusChip, statusChipVariants } from "./status-chip";
export type { StatusChipProps, StatusChipStatus } from "./status-chip";

export { StatGroup, statGroupValueVariants } from "./stat-group";
export type { StatGroupProps } from "./stat-group";

export { BatteryMeter, BATTERY_LOW_PCT } from "./battery-meter";
export type { BatteryMeterProps } from "./battery-meter";

/* -- operator shell ------------------------------------------------------- */
export { ConnectionStatus, CONNECTION_STATES } from "./connection-status";
export type { ConnectionState, ConnectionStatusProps } from "./connection-status";

export { ConsoleFooter } from "./console-footer";
export type { ConsoleFooterProps } from "./console-footer";

export { ConsoleHeader } from "./console-header";
export type { ConsoleHeaderProps } from "./console-header";

export { ProductMark } from "./product-mark";
export type { ProductMarkProps } from "./product-mark";

export { RegionNote } from "./region-note";
export type { RegionNoteProps } from "./region-note";

/* -- fleet regions (store-wired) ------------------------------------------
   The components above are pure: props in, markup out, no store, usable in any
   composition. The ones below are wired — they subscribe to lib/stores and are
   the fleet page's three regions plus its header numbers. They live in the
   library rather than beside the route because the PRD names them as library
   deliverables (UnitCard, AlertRail…), and because /unit/[id] reuses the same
   status vocabulary next phase. */
export {
  AlertFeedControls,
  AlertFilterToggle,
  AlertRail,
  FleetAlertCount,
  setAlertFilter,
  useAlertFilter,
} from "./alert-rail";
export type { AlertFilter } from "./alert-rail";
export { AlertRow } from "./alert-row";
export type { AlertRowProps } from "./alert-row";

/* The alert's own lifecycle: ack, ownership, escalation pairing, resolution.
   Pure derivations over the store's `alerts` + `alertMeta`, so the feed renders
   a view and decides nothing. */
export {
  clockTime,
  deriveAlertViews,
  durationSince,
  formatDuration,
  isLive,
  isOpen,
  resolutionVia,
} from "./alert-lifecycle";
export type { AlertLifecycle, AlertView } from "./alert-lifecycle";

/* The first-visit bias: which alert row wears the "start here" mark,
   and the session-scoped set of units the operator has opened that clears it.
   `useMarkUnitVisited` is the half /unit/[id] owns — the visit is a fact about
   the route, so the route is what records it. */
export {
  hasVisitedUnit,
  markUnitVisited,
  resetVisitedUnits,
  selectNudgeAlertId,
  useFirstVisitNudge,
  useMarkUnitVisited,
  useVisitedUnits,
} from "./first-visit-nudge";

export { AUDIT_TAG, auditLine } from "./audit-line";
export type { AuditTag } from "./audit-line";

export { AuditChronology, SessionLog, UnitAuditLog, useHasAuditLog } from "./audit-log";
export type { AuditChronologyProps, UnitAuditLogProps } from "./audit-log";

export { Disclosure } from "./disclosure";
export type { DisclosureProps } from "./disclosure";

export { FleetKpis, LiveConnectionStatus, CONNECTION_VIEW } from "./fleet-kpis";
export { FleetMap } from "./fleet-map";
export { FleetRail, FleetUnitCount } from "./fleet-rail";
export { TelemetryProvider } from "./telemetry-provider";

export { UnitCard, UNIT_CARD_HEIGHT, UNIT_CARD_TRENDING_HEIGHT } from "./unit-card";
export type { UnitCardProps } from "./unit-card";

/* The thermal trend watch's operator-space copy. The store decides
   whether a joint is climbing (lib/stores/trendWatch.ts); this is the vocabulary
   the console says it in — quietly, one step below amber. */
export { trendDetail, trendSpeech, useTrendingUnit } from "./trend-watch";

export { PostureTag, UnitPostureTag, postureLabel, useUnitPosture } from "./posture-tag";
export type { PostureTagProps, UnitPostureTagProps } from "./posture-tag";

export {
  UNIT_STATUS_CHIP,
  UNIT_STATUS_COPY,
  alertSeverityChip,
  alertSeverityCopy,
  needsAttention,
  unitStatusChip,
  unitStatusCopy,
} from "./unit-status";

export { formatRecency, isoTime, useNow } from "./relative-time";

/* -- unit drill-in (store-wired) ------------------------------------------
   The unit page's regions. Same rule as the fleet regions above: they live in
   the library because the PRD names them as deliverables and because Phase 3's
   machine-space boards reuse the same joint vocabulary and the same rAF loop. */
export { IncidentBanner, incidentHeadline, verdictLine } from "./incident-banner";
export type { IncidentBannerProps } from "./incident-banner";

/* The diagnostic action itself, shared by every surface that offers it — the
   banner's pill, the banner's re-run, the identity header's quiet outline —
   together with the one derivation that decides which of them is on screen. */
export {
  RUN_BLOCKED_REASON,
  RunDiagnosticButton,
  useDiagnosticBusy,
  useUnitDiagnostic,
  ViewDiagnosticButton,
} from "./run-diagnostic";
export type {
  RunDiagnosticButtonProps,
  UnitDiagnostic,
  UnitDiagnosticState,
  ViewDiagnosticButtonProps,
} from "./run-diagnostic";

export { IncidentHistory, incidentRef, useHasIncidentHistory } from "./incident-history";
export type { IncidentHistoryProps } from "./incident-history";

/* The report's gate and its pure module only. The document itself is a
   next/dynamic boundary inside incident-report.tsx and is deliberately NOT
   re-exported here, for the reason stated in that file: both routes sit within
   11 KB gz of the PRD's budget, and a page nobody has opened yet must not spend
   it. */
export { IncidentReport } from "./incident-report-overlay";
export type { IncidentReportProps } from "./incident-report-overlay";
export {
  closeIncidentReport,
  escalatedTier,
  incidentAlerts,
  incidentSpans,
  incidentTimes,
  openIncidentReport,
  recoveryTier,
  RECOVERY_TIERS,
  subscribeIncidentReport,
} from "./incident-report";
export type { IncidentSpans, IncidentTimes, RecoveryTier } from "./incident-report";

export { SimReset } from "./sim-reset";
export type { SimResetProps } from "./sim-reset";

export { JointGrid, TelemetryCursorMeta } from "./joint-grid";
export type { JointGridProps } from "./joint-grid";

export { StatusTimeline } from "./status-timeline";
export type { StatusTimelineProps } from "./status-timeline";

export { BackToFleet, UnitIdentity } from "./unit-identity";
export type { UnitIdentityProps } from "./unit-identity";

export {
  breachedRecently,
  TELEMETRY_STRIP_EXPANDED_HEIGHT,
  TELEMETRY_STRIP_HEIGHT,
  TelemetryStrip,
  stripTone,
} from "./telemetry-strip";
export type { StripTone, TelemetryStripProps } from "./telemetry-strip";

/* The instrument's supporting math, exported because /system renders the strip
   in isolation and because the descent's waveforms will read the same
   envelope. `telemetry-hover` is the shared cursor: one module variable, read
   by every strip's frame callback, written by the grid's pointer handler. */
export { breachRuns, sampleAt, timeAxis, valueAxis } from "./telemetry-bands";
export type { AxisLabel, TimeLabel } from "./telemetry-bands";

export {
  clearCursor,
  currentCursor,
  cursorOffsetFor,
  offsetFromLocalX,
  setCursor,
  subscribeCursor,
} from "./telemetry-hover";
export type { Cursor } from "./telemetry-hover";

export {
  commandLabel,
  deriveSessionEvents,
  groupAuditEntries,
  offsetLabel,
  packEvents,
} from "./session-events";
export type {
  AuditGroup,
  PlacedEvent,
  SessionEvent,
  SessionEventKind,
} from "./session-events";

/* -- the descent (Phase 3) -------------------------------------------------
   The gate and the motion contract only. The machine-space tree behind them is
   a next/dynamic boundary inside descent-overlay.tsx and is deliberately NOT
   re-exported here: this barrel is in the unit page's initial JS, and anything
   it names travels with it. */
export { DescentOverlay, preloadMachineSpace } from "./descent-overlay";
export type { DescentOverlayProps } from "./descent-overlay";

export {
  DESCENT_ATTR,
  DESCENT_DIM_VAR,
  EASE_WIPE,
  descentDurationMs,
  descentTimeline,
  secs,
} from "./descent-motion";
export type { DescentTimeline } from "./descent-motion";

export {
  isDescentOccluded,
  setDescentOccluded,
  subscribeDescentOcclusion,
} from "./descent-occlusion";

export { useMediaQuery, usePrefersReducedMotion } from "./use-reduced-motion";

/* -- the component view (Phase 4) -----------------------------------------
   Same rule as the descent above, and for the same reason: the gate and its
   pure spec are named here, the R3F scene is a next/dynamic boundary inside
   component-view.tsx and is deliberately NOT re-exported. three.js loads on
   this section or it does not load at all (PRD §7). */
export { ComponentView, useComponentHighlight } from "./component-view";
export type { ComponentViewProps } from "./component-view";

export { ComponentElevation } from "./component-elevation";
export type { ComponentElevationProps } from "./component-elevation";

export { PartDetail } from "./part-detail";
export type { PartDetailProps } from "./part-detail";

/* The cross-highlight. One module singleton holding the selected
   part, plus the correspondences that make a selection mean something in three
   places at once: part -> its joints, joint -> its opposite number. Same shape
   and same reasoning as `telemetry-hover` above — the viewer subscribes, the
   grid writes attributes, and nothing renders at pointer or frame rate.
   `selectPartForAlert` is the door for the alert feed; see the note in the
   module for the one import and one handler that adopts it. */
export {
  clearSelectedPart,
  currentPartSelection,
  jointEmphasis,
  JOINTS_FOR_PART,
  jointsForPart,
  mirrorJoint,
  resetPartSelection,
  selectPartForAlert,
  selectedPartFor,
  setSelectedPart,
  subscribeSelection,
} from "./part-selection";
export type { JointEmphasis, PartSelection } from "./part-selection";

export {
  CHASSIS_MODEL_URL,
  COMPONENT_FOR_JOINT,
  COMPONENT_IDS,
  COMPONENT_LABELS,
  COMPONENT_ORDER,
  componentForJoint,
  componentHighlight,
  componentLabel,
  componentNamedIn,
  componentStatus,
  cycleSelection,
  emissiveIntensity,
  highlightNeedsFrames,
  selectionKey,
  SERVICE_DISCLAIMER,
  SERVICE_RECORDS,
  serviceDateLabel,
  serviceDueInDays,
  serviceRecord,
} from "./component-spec";
export type {
  ComponentHighlight,
  ComponentId,
  HighlightMode,
  HighlightSources,
  ServiceRecord,
} from "./component-spec";

/* -- canvas plumbing (Phase 3 draws on this too) --------------------------- */
export { frameSubscriberCount, registerFrame, useFrame } from "./frame-loop";
export type { FrameCallback } from "./frame-loop";

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

/* -- outbound commands ----------------------------------------------------- */
export {
  commandRecalibrate,
  commandSafeSit,
  runDiagnostic,
  sendCommand,
  setCommandTransport,
} from "./telemetry-command";

export {
  getUnitStatusHistory,
  resetStatusHistory,
  startStatusRecorder,
  statusHistoryVersion,
  subscribeStatusHistory,
} from "./status-history";
export type { StatusMark, StatusSpan, UnitStatusHistory } from "./status-history";

/* -- the fleet incident (Phase 11) -----------------------------------------
   The cohort card and the two derivations behind it. `cohort-copy` is pure and
   is where every string the card can say lives (the operator-space sibling of
   components/machine/safe-sit-copy.ts); `cohort-membership` is the "is this row
   in the group" lookup the rail, the map and the feed all ask per row. */
/* The gate only. The card itself is a `next/dynamic` boundary inside
   cohort-card.tsx and is deliberately NOT re-exported here, for the reason
   stated in that file and in the descent/report notes above: this barrel is in
   every route's initial JS, and anything it names travels with it. */
export { CohortCard, preloadCohortCard } from "./cohort-card";
export {
  canaryLine,
  cohortHeadline,
  haltImpact,
  haltReceipt,
  listUnits,
  refusalNote,
  restoredCount,
  rollbackEstimate,
  rollbackImpact,
  rollbackLine,
  rollbackRoster,
  rollbackRows,
  ROLLBACK_PER_UNIT_MS,
  ROLLBACK_PHASE_COPY,
} from "./cohort-copy";
export type { ImpactLine, RollbackUnitPhase, RollbackUnitRow } from "./cohort-copy";

export {
  resetCohortMembership,
  selectCohortAlerts,
  selectCohortMembers,
  useCohortMember,
} from "./cohort-membership";

export { haltRollout, rollbackCohort } from "./telemetry-command";
