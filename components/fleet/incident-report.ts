"use client";

import { type Alert } from "@/lib/schema";
import { type AlertMeta, type AuditEntry, type IncidentRecord } from "@/lib/stores";

/**
 * What a full incident report is made of, and where the pieces come from.
 *
 * The stores hold the *facts* — an incident record carrying its archived
 * evidence, an append-only log, an alert lifecycle — and each of them is
 * scoped to the question its own surface asks. A report asks a wider question
 * than any single store answers ("what happened, in what order, how long did
 * each part take, and what did anyone do about it"), so this module is the
 * join: pure functions over the three journals, plus the one piece of state
 * the report needs that no store keeps — which document is open.
 *
 * Everything here is deliberately free of JSX so the surface can be code-split
 * (incident-report-surface/) while the part the *unit page* needs — the
 * open signal — stays small enough to sit in its initial JS.
 */

/* -------------------------------------------------------------------------
   the open signal
   ------------------------------------------------------------------------- */

/**
 * Which incident's report is open, as a module fact rather than page state.
 *
 * Two callers, in two subtrees that never meet: the incident history's id, and
 * the part detail's linkage — the latter three components deep inside the
 * component view, which would otherwise mean threading a callback through a
 * 3D scene to open a document. The same problem the part card already solved
 * for scrolling to a record (`revealIncident`), and the same shape as the
 * console's other module-level signals (status-history.ts, telemetry-hover.ts):
 * a value, a setter and a subscribe, read through `useSyncExternalStore`.
 *
 * Deliberately *not* extended to the fleet report, which holds its
 * open state in the card that owns it. The machinery here exists for the two
 * openers above; the fleet write-up has exactly one, in the same component as
 * its gate — and sharing this signal with it would give the fleet route's async
 * chunk an edge into a module the unit route holds initially, which Turbopack
 * answers by splitting the shared payload: 0.8 KB gz on BOTH routes, measured,
 * against 2 KB of headroom. The note is in cohort-incident.tsx.
 *
 * Not in a store because it is not a fact about the fleet. It is which document
 * this browser has open, it must not survive a reload, and putting it in
 * `lib/stores` would make every consumer of those stores re-render when an
 * operator opened a report.
 */
let openId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openIncidentReport(id: string): void {
  if (openId === id) return;
  openId = id;
  emit();
}

export function closeIncidentReport(): void {
  if (openId === null) return;
  openId = null;
  emit();
}

export function subscribeIncidentReport(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The open report's id, or null. Server snapshot is null: nothing is open. */
export const incidentReportSnapshot = (): string | null => openId;

/** Tests and teardown only. */
export function resetIncidentReport(): void {
  openId = null;
  emit();
}

/* -------------------------------------------------------------------------
   the times, and the spans between them
   ------------------------------------------------------------------------- */

/**
 * The alerts this incident actually closed.
 *
 * The linkage is the resolution's own ref: `useResolveOnIncident` closes every
 * standing alert on the unit with `{ via: "incident", ref: incidentId }`, so an
 * alert points at the incident that carried it. That is the only linkage in the
 * system and it is exact — no time-window guessing, and a later alert on the
 * same unit is not retroactively swept into an older report.
 *
 * The fallback covers the two cases where nothing was closed: a clean pass
 * resolves nothing on purpose, and a report can be read while its alert is
 * still standing. Then the subject is this unit's alerts that were already
 * raised when the verdict landed — which is what the incident was *about*, even
 * though it did not close them.
 *
 * ## The second linkage
 *
 * There is now one way for an incident to end without ever writing that ref: a
 * recalibration that CLEARS the fault. The sim resolves the alert itself, on
 * the wire, the moment the re-measure comes back inside the envelope — so the
 * resolution is authored by `alert_clear` (`via: "recalibration"`) and carries
 * no incident id, and the console's own `useResolveOnIncident` finds it already
 * resolved and idempotently leaves it alone. Read by the ref alone, the one
 * incident in the product that genuinely closed itself would file with no
 * resolution time and no MTTR, under a letterhead saying it was never resolved.
 *
 * The second linkage is exact rather than a time window: this record holds a
 * cleared calibration, and the alert names a recalibration as its author, on
 * the same unit, inside the incident's own subject set. There is at most one
 * cleared calibration per unit per run — the sim latches the fault away and
 * refuses a second attempt with CALIBRATION CURRENT — so the two facts identify
 * one event between them. It is only consulted when the ref finds nothing, so
 * an operator's own resolution still outranks it.
 */
export function incidentAlerts(
  record: IncidentRecord,
  alerts: readonly Alert[],
  meta: Readonly<Record<string, AlertMeta>>,
): { closed: Alert[]; subject: Alert[] } {
  const closed = alerts.filter((a) => meta[a.id]?.resolution?.ref === record.id);
  if (closed.length > 0) return { closed, subject: closed };
  const standing = alerts.filter(
    (a) => a.unitId === record.unitId && a.ts <= record.report.ts,
  );
  const byCalibration =
    record.calibration?.outcome === "cleared"
      ? standing.filter((a) => meta[a.id]?.resolution?.via === "recalibration")
      : [];
  return { closed: byCalibration, subject: standing };
}

/** The report's clock: every moment the console can honestly date. */
export interface IncidentTimes {
  /** Earliest detection among the alerts this incident is about. */
  raised?: number;
  /** When an amber on this unit became a red, if it did. */
  escalated?: number;
  /** First acknowledgement — the operator taking ownership. */
  acked?: number;
  /** When the scan that produced this verdict started. */
  diagnostic?: number;
  /** The verdict itself — the one moment every incident has. */
  verdict: number;
  /** Latest closure among the alerts this incident closed. */
  resolved?: number;
}

const min = (values: number[]): number | undefined =>
  values.length === 0 ? undefined : Math.min(...values);
const max = (values: number[]): number | undefined =>
  values.length === 0 ? undefined : Math.max(...values);

/**
 * Five moments, from three journals, and nothing invented.
 *
 * Every field is optional except the verdict, because every one of them can
 * genuinely be absent: an incident nobody acknowledged, an alert that skipped
 * the warning stage, a scan whose `diag-start` predates this console's session.
 * A report that filled those with a plausible-looking time would be the one
 * surface in the product that lies, and it is the surface an operator would
 * quote in a dispute.
 */
export function incidentTimes(
  record: IncidentRecord,
  alerts: readonly Alert[],
  meta: Readonly<Record<string, AlertMeta>>,
  audit: readonly AuditEntry[],
): IncidentTimes {
  const verdict = record.report.ts;
  const { closed, subject } = incidentAlerts(record, alerts, meta);

  const raised = min(subject.map((a) => a.ts));
  const acked = min(
    subject.map((a) => meta[a.id]?.ackedAt).filter((t): t is number => t !== undefined),
  );
  const resolved = max(
    closed.map((a) => meta[a.id]?.resolvedAt).filter((t): t is number => t !== undefined),
  );

  const unitLog = audit.filter((e) => e.unitId === record.unitId);
  // The escalation that belongs to *this* incident: the first one at or after
  // the raise and not after the verdict. A later escalation is a later problem.
  const escalated = min(
    unitLog
      .filter((e) => e.kind === "escalation" && e.ts <= verdict)
      .filter((e) => raised === undefined || e.ts >= raised)
      .map((e) => e.ts),
  );
  // The *last* scan start before the verdict, because an aborted scan earlier
  // in the session leaves its own entry and this verdict came from the last one.
  const diagnostic = max(
    unitLog.filter((e) => e.kind === "diag-start" && e.ts <= verdict).map((e) => e.ts),
  );

  return { raised, escalated, acked, diagnostic, verdict, resolved };
}

/**
 * The figures an ops team is measured on, derived and never stored.
 *
 * MTTA and MTTR are the industry's names and they are used here in the
 * industry's sense — time from detection to acknowledgement, and from detection
 * to closure — because an operator who knows the terms should find them meaning
 * what they expect. The other two are the halves that matter inside this
 * console: how long the unit waited for someone to look, and how long the
 * looking took.
 */
export interface IncidentSpans {
  /** Detection → acknowledgement. */
  mtta?: number;
  /** Detection → closure. */
  mttr?: number;
  /** Detection → the scan starting: the wait this console made visible. */
  toDiagnose?: number;
  /** Scan start → closure. */
  toResolve?: number;
}

const between = (from: number | undefined, to: number | undefined): number | undefined =>
  from === undefined || to === undefined || to < from ? undefined : to - from;

export function incidentSpans(times: IncidentTimes): IncidentSpans {
  return {
    mtta: between(times.raised, times.acked),
    mttr: between(times.raised, times.resolved),
    toDiagnose: between(times.raised, times.diagnostic),
    toResolve: between(times.diagnostic, times.resolved),
  };
}

/* -------------------------------------------------------------------------
   the recovery ladder
   ------------------------------------------------------------------------- */

/**
 * How far up the intervention ladder an action reaches, cheapest rung first.
 *
 * This is the vocabulary a fleet operator actually plans in: every rung costs
 * more than the one below it — in money, in a customer's day, and in how long
 * the robot is out of the house — so "what did this incident cost us" is really
 * "how high did we have to climb". Naming the rungs turns a list of actions
 * into that answer, and it is why the report's header says where the incident
 * ended up rather than leaving the reader to infer it from three buttons.
 *
 * Ordered, and the order is load-bearing: both `recoveryTier` and
 * `escalatedTier` take the maximum, so a new rung must be inserted at its true
 * position rather than appended.
 */
export const RECOVERY_TIERS = [
  "self-recovery",
  "remote operations",
  "customer-assisted",
  "field service",
  "depot",
] as const;

export type RecoveryTier = (typeof RECOVERY_TIERS)[number];

/**
 * The words each rung is recognised by. Unordered — see {@link recoveryTier},
 * which takes the highest match rather than the first.
 *
 * Matched on the action's words rather than by position in the report's
 * `recommendations` array, for the same reason `isExecutedRecommendation` is
 * (safe-sit-copy.ts): the array is wire data whose order is the sim's business,
 * and a table that decided "the second one is the expensive one" would start
 * mis-filing the day a fourth recommendation appears.
 *
 * An action this table has never heard of gets no tier rather than a guessed
 * one — an unknown intervention filed as "remote operations" would understate
 * an incident, which is the one direction this figure must never be wrong in.
 */
const TIER_BY_ACTION: ReadonlyArray<[RegExp, RecoveryTier]> = [
  /**
   * The interventions the console can drive over the link on its own.
   *
   * - *recalibrate*: an unloaded recalibration is run remotely, and it
   * is the differential's own cheapest-first step — "unloaded recalibration
   * before module replacement". Untiered, it was the one recommendation on
   * the knee incident's report with no rung against it.
   * - *halt rollout* / *roll back*: fleet-scale, and still nothing
   * but a command over the link. That is the fleet incident's whole argument
   * — four robots restored without a van leaving a depot — and it only reads
   * as an argument if the ladder says where it stopped.
   */
  [
    /safe\s*sit|disable\s+joint|reduce\s+(load|torque)|remote|recalibrat|halt\s+rollout|roll\s*back/i,
    "remote operations",
  ],
  [/dispatch|technician|field|on-?site/i, "field service"],
  [/schedule\s+service|service\s+visit/i, "field service"],
  [/depot|return\s+to\s+(base|depot)|replace\s+module/i, "depot"],
  [/customer|household|resident/i, "customer-assisted"],
  [/no\s+action|self[-\s]?recover|restart|reboot/i, "self-recovery"],
];

/**
 * Which rung an action sits on: the HIGHEST one its words reach.
 *
 * It used to be first-match-wins, with the ordering of the table doing the work
 * — the remote patterns sat last so that a phrase naming a technician, a
 * household or a depot as well as a remote verb still filed at its true rung.
 * That held the invariant by convention, and the entry documenting it said as
 * much: "position is the only thing enforcing that". It was already wrong at
 * the top of the table, where the bare word `remote` sat above field service
 * and depot: "Reduce torque, then dispatch a technician" and "Remote depot
 * diagnostics" both filed as remote operations, and that value is the one line
 * of the filed document saying how expensive the incident got.
 *
 * Taking the maximum makes the invariant structural: the table can be written
 * in any order, a new rung can be appended, and the figure can still only ever
 * overstate an incident — never understate one, which is the direction it must
 * never be wrong in.
 */
export function recoveryTier(action: string): RecoveryTier | null {
  let highest = -1;
  for (const [pattern, tier] of TIER_BY_ACTION) {
    if (pattern.test(action)) {
      highest = Math.max(highest, RECOVERY_TIERS.indexOf(tier));
    }
  }
  return highest < 0 ? null : (RECOVERY_TIERS[highest] ?? null);
}

/** The highest rung anything on this incident reached. */
export function escalatedTier(actions: readonly string[]): RecoveryTier | null {
  let highest = -1;
  for (const action of actions) {
    const tier = recoveryTier(action);
    if (tier === null) continue;
    highest = Math.max(highest, RECOVERY_TIERS.indexOf(tier));
  }
  return highest < 0 ? null : (RECOVERY_TIERS[highest] ?? null);
}
