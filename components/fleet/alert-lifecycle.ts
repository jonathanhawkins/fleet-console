import { type Alert } from "@/lib/schema";
import { type AlertMeta, type AlertResolution } from "@/lib/stores";

/**
 * What the feed knows about an alert beyond the sentence the wire sent.
 *
 * The store owns the two operator facts — `ackedAt`/`ackedBy` and
 * `resolvedAt`/`resolution` in `alertMeta` — and deliberately owns no third
 * one: escalation is not a field, it is a *shape* in the feed (a red landing on
 * a unit that already had an amber), and duration is a render-time subtraction
 * against the shared 1 s ticker. Both are derived here, in one pure pass, so
 * the row component renders a view and decides nothing.
 *
 * Everything in this file is pure and clock-injected. A feed that computed
 * `Date.now()` inside itself could not be tested at a chosen instant, and
 * would also disagree with the row above it by however long React took to get
 * there (see relative-time.ts: one clock, read once per pass).
 */

/**
 * Three states, and the ladder only goes one way.
 *
 * `acked` is "someone has this" — ownership, not closure — and it is
 * deliberately not reversible. The audit log is append-only and the ack is
 * already in it by the time the row re-renders; an un-ack would leave the log
 * saying an operator took the alert and the console saying nobody did. If the
 * wrong person acked, the record of who and when is the useful artefact, not a
 * clean-looking feed. There is no un-ack action anywhere in this UI on purpose.
 */
export type AlertLifecycle = "open" | "acked" | "resolved";

export interface AlertView {
  alert: Alert;
  meta: AlertMeta | undefined;
  lifecycle: AlertLifecycle;
  /** An amber that a later red on the same unit took over from. */
  escalated: boolean;
  /** For a red that escalated: the detection time of the amber it superseded. */
  escalatedFrom?: number;
}

/** Still the operator's problem: acked counts as open, only resolution closes. */
export function isOpen(view: AlertView): boolean {
  return view.lifecycle !== "resolved";
}

/**
 * Still the *live* question — narrower than {@link isOpen} by the two things
 * that settle a row without closing it: somebody has taken it, or a later alert
 * on the same unit has taken it over.
 *
 * One predicate for two opposite jobs, and that is the point. The feed already
 * recedes a row that is not the live question (alert-row.tsx: a settled ground,
 * a bare chip, the unit id giving up its weight), and the first-visit nudge
 * marks the row that IS (first-visit-nudge.ts). Emphasis and recession are the
 * same judgement pointed in opposite directions, so they read the same fact
 * rather than two definitions that can drift apart — the failure mode being a
 * feed that recedes a row and marks it in the same commit.
 */
export function isLive(view: AlertView): boolean {
  return view.lifecycle === "open" && !view.escalated;
}

/**
 * The feed, paired up.
 *
 * `alerts` arrives newest first (the store's order, which is also ts order), so
 * the escalation pass walks it backwards — an escalation is only legible in
 * arrival order, since it is one alert being taken over by a *later* one.
 *
 * The pairing is one-to-one and greedy from the newest unmatched amber: a red
 * escalates the most recent amber still standing on its unit, and that amber is
 * then spent. Two ambers followed by two reds on one unit therefore read as two
 * escalations rather than as four rows all claiming the same ancestry, and a
 * red that arrived on a quiet unit — a fault that skipped the warning stage —
 * correctly claims none.
 */
export function deriveAlertViews(
  alerts: readonly Alert[],
  meta: Readonly<Record<string, AlertMeta>>,
): AlertView[] {
  const superseded = new Set<string>();
  const cameFrom = new Map<string, number>();
  /** Per unit: ambers still waiting to be taken over, oldest first. */
  const standing = new Map<string, Alert[]>();

  for (let i = alerts.length - 1; i >= 0; i -= 1) {
    const alert = alerts[i];
    if (!alert) continue;
    if (alert.severity === "amber") {
      const queue = standing.get(alert.unitId);
      if (queue) queue.push(alert);
      else standing.set(alert.unitId, [alert]);
      continue;
    }
    const amber = standing.get(alert.unitId)?.pop();
    if (!amber) continue;
    superseded.add(amber.id);
    cameFrom.set(alert.id, amber.ts);
  }

  return alerts.map((alert) => {
    const entry = meta[alert.id];
    const lifecycle: AlertLifecycle =
      entry?.resolvedAt !== undefined
        ? "resolved"
        : entry?.ackedAt !== undefined
          ? "acked"
          : "open";
    return {
      alert,
      meta: entry,
      lifecycle,
      escalated: superseded.has(alert.id),
      escalatedFrom: cameFrom.get(alert.id),
    };
  });
}

/**
 * `14:32:07` — the operator's wall clock, 24 hour, seconds included.
 *
 * A record needs a time you can put in a sentence to a colleague, which "2m
 * ago" is not: it is true only at the instant it was read. The feed prints both
 * and they do different jobs — the relative label answers "is this still
 * happening", the clock answers "when exactly", and an incident report needs
 * the second one.
 */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * `4 September 2026` — the day the clock times belong to.
 *
 * `clockTime` deliberately prints no date: a feed row read at a glance wants
 * the time and nothing else. A document does not have that luxury. A service
 * report whose every stamp reads `10:33:53` records an incident that happened
 * on no particular day, which is worse than useless to the technician holding
 * it — so the report carries the date once, in its letterhead, and the times
 * underneath belong to it.
 */
export function calendarDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * `BST`, or `UTC+01:00` where the runtime has no short name for the zone.
 *
 * Printed beside the date for the same reason the date is printed at all: this
 * console shows one operator's wall clock, its units sit in named places, and a
 * time with no zone on a document that leaves the building is a time that
 * cannot be compared with anything.
 */
export function timeZoneLabel(ts: number): string {
  const short = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(new Date(ts))
    .find((part) => part.type === "timeZoneName")?.value;
  return short ?? "local time";
}

function pad(n: number): string {
  return `${n}`.padStart(2, "0");
}

/**
 * How long something has been going on: `42s` · `4m 07s` · `1h 04m`.
 *
 * Zero-padded below the leading unit so the string keeps its width as it
 * counts. Set in `tnum`, a duration that steps 9s → 10s without padding shunts
 * everything after it sideways once a second, which is the sort of thing an
 * operator notices without being able to say why the page feels restless.
 *
 * Hours drop the seconds. Past an hour the exact second is noise, and a row
 * still ticking at that point is telling a different story anyway.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/**
 * `now - since`, or null when there is nothing truthful to print.
 *
 * `now === 0` is the shared ticker's server snapshot (relative-time.ts): a
 * duration is not renderable before the client clock exists, and a row that
 * printed one would be asserting an elapsed time measured from a clock that
 * had not started.
 */
export function durationSince(since: number | undefined, now: number): string | null {
  if (since === undefined || !Number.isFinite(since) || now === 0) return null;
  return formatDuration(now - since);
}

/**
 * What closed it, in the operator's words rather than the store's enum.
 *
 * The row prints "Resolved · diagnostic · 14:32:45" — the middle term is this.
 * It is the whole reason `resolveAlert` takes a resolution instead of a
 * boolean: "resolved" alone invites the question this answers.
 */
export function resolutionVia(resolution: AlertResolution | undefined): string {
  switch (resolution?.via) {
    case "incident":
      return "diagnostic";
    case "safe-sit":
      return "safe sit";
    case "self-recovery":
      // The one resolution nobody in this room performed: the unit replanned
      // and cleared its own alert (the wire's `alert_clear`). The word
      // is the point — the row must credit the robot, not imply an operator.
      return "self-recovered";
    case "rollback":
      // Cleared by ROLLBACK_COHORT restoring the unit's firmware:
      // the fault left with the build, and the row should say so.
      return "rollback";
    case "recalibration":
      // Cleared by RECALIBRATE_JOINT re-zeroing the flagged channel.
      // Not "self-recovered" and not a bare "operator": a person pressed a
      // button, over the link, and the fault stopped existing — which is the
      // rung the incident report files it at.
      return "recalibrated";
    default:
      return "operator";
  }
}
