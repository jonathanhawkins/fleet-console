import { type Alert, type UnitSummary } from "@/lib/schema";
import {
  FLEET_AUDIT_SCOPE,
  type AlertMeta,
  type AuditEntry,
  type CohortIncident,
} from "@/lib/stores";
import { haltReceiptFacts } from "./cohort-copy";

/**
 * What a fleet incident report is made of — the join, with no JSX in it.
 *
 * The sibling of incident-report.ts, one level up: that module answers "what
 * happened to this robot" by joining three journals; this one answers "what
 * happened to this build" by joining the same three plus the cohort the fleet
 * store derived. Pure, clock-free, store-free — every function here takes the
 * slices it reads, so the document can be tested as arithmetic and the surface
 * can be code-split away from the card that opens it.
 *
 * ## The subject is the incident at its widest, and it has to be passed in
 *
 * The cohort derivation tracks *current* truth: a unit leaves the group the
 * moment a rollback restates its firmware, and by the last unit the group has
 * dropped below threshold and been forgotten (lib/stores/cohortStore.ts). A
 * report built from the live derivation would therefore describe a smaller and
 * smaller incident as the operator fixed it, and would have nothing at all to
 * say once they were done. So the report is handed the same peak subject the
 * card holds (`useCohortSubject`), and everything below reads *that* membership
 * against the journals.
 *
 * ## It invents nothing
 *
 * The unit report's rule, unchanged and harder to keep here, because the fleet
 * incident's most important fact is a thing that did NOT happen. An update that
 * was prevented leaves no alert, no unit_update and no command to point at —
 * only the halt's own receipt. So `preventedUpdates` reads that receipt and
 * nothing else, and where there is no receipt the document says plainly that
 * nothing was prevented rather than reasoning its way to a save.
 */

/* -------------------------------------------------------------------------
   the affected units
   ------------------------------------------------------------------------- */

/** One member's whole lifecycle, from the build it took to the moment it cleared. */
export interface CohortUnitRow {
  unitId: string;
  /** The suspect build — what every member was running when it raised. */
  fwBefore: string;
  /** What it is running now; undefined for a unit the fleet no longer reports. */
  fwAfter?: string;
  /** Detection: the member alert's own ts. */
  raised?: number;
  /** Closure: the member alert's resolution, which is the wire's alert_clear. */
  cleared?: number;
  /** raised → cleared, only where both are on file. */
  openFor?: number;
  /** Off the suspect build. The firmware is the fact; the alert merely follows it. */
  restored: boolean;
}

/**
 * Every member, measured against the journals rather than against the card.
 *
 * `fwBefore` is the cohort's own firmware and not a per-unit reading, because
 * that is what membership *means*: the group is `(signature, fw)`, so a unit in
 * it was on that build when it raised. The unit's current firmware is read live
 * — a rollback moves it — which is what makes the before/after column a record
 * of the remediation rather than a restatement of the incident.
 */
export function cohortUnits(
  cohort: CohortIncident,
  alerts: readonly Alert[],
  meta: Readonly<Record<string, AlertMeta>>,
  units: Readonly<Record<string, UnitSummary>>,
): CohortUnitRow[] {
  const byId = new Map(alerts.map((a) => [a.id, a]));
  return cohort.unitIds.map((unitId, i) => {
    const alert = byId.get(cohort.alertIds[i] ?? "");
    const raised = alert?.ts;
    const cleared = alert === undefined ? undefined : meta[alert.id]?.resolvedAt;
    const fwAfter = units[unitId]?.fw;
    return {
      unitId,
      fwBefore: cohort.fw,
      fwAfter,
      raised,
      cleared,
      openFor:
        raised === undefined || cleared === undefined || cleared < raised
          ? undefined
          : cleared - raised,
      restored: fwAfter !== undefined && fwAfter !== cohort.fw,
    };
  });
}

/* -------------------------------------------------------------------------
   the times, and the spans between them
   ------------------------------------------------------------------------- */

/** The moments a fleet incident can honestly be dated by. */
export interface CohortTimes {
  /** The threshold crossing, frozen by the store at detection. */
  detected: number;
  /** The halt's receipt landing — the blast radius stopping growing. */
  halted?: number;
  /** The staged rollback being accepted. */
  rollbackOrdered?: number;
  /** The first member's alert clearing. */
  firstRestored?: number;
  /** The last member's alert clearing. */
  lastRestored?: number;
  /** The fleet declaring the staged rollback finished. */
  completed?: number;
}

const min = (values: number[]): number | undefined =>
  values.length === 0 ? undefined : Math.min(...values);
const max = (values: number[]): number | undefined =>
  values.length === 0 ? undefined : Math.max(...values);

/**
 * The entries this incident is entitled to read, and the only place either
 * filter lives.
 *
 * Two of them, and both are load-bearing. **Fleet-scoped**, because a unit's own
 * log is a different incident's record and the fleet report has no business
 * telling a knee's story. **At or after detection**, because the session log
 * survives RESET_SIM (auditStore.ts) — the storyline is re-runnable, and
 * without the floor the second run's report would count the first run's halt as
 * its own save. Every derivation below consumes this rather than the raw store,
 * so the window is one decision in one place instead of five agreeing ones.
 */
export function cohortLog(
  audit: readonly AuditEntry[],
  detectedAt: number,
): AuditEntry[] {
  return audit.filter(
    (e) => e.unitId === FLEET_AUDIT_SCOPE && e.ts >= detectedAt,
  );
}

const firstOfKind = (
  log: readonly AuditEntry[],
  kind: AuditEntry["kind"],
): AuditEntry | undefined =>
  // The store keeps entries newest first, so the oldest of a kind is the last
  // one that matches — and the oldest is the one that belongs to this instance.
  [...log].reverse().find((e) => e.kind === kind);

export function cohortTimes(
  cohort: CohortIncident,
  rows: readonly CohortUnitRow[],
  log: readonly AuditEntry[],
): CohortTimes {
  const cleared = rows
    .map((r) => r.cleared)
    .filter((t): t is number => t !== undefined);

  return {
    detected: cohort.detectedAt,
    halted: firstOfKind(log, "rollout-halted")?.ts,
    rollbackOrdered: firstOfKind(log, "rollback-started")?.ts,
    firstRestored: min(cleared),
    lastRestored: max(cleared),
    completed: firstOfKind(log, "rollback-complete")?.ts,
  };
}

/**
 * The figures a fleet incident is measured on.
 *
 * Deliberately not MTTA and MTTR. Those name a *unit's* incident and an
 * operator would read them as one; the questions here are how long the fleet
 * went on taking damage (detection → halt), how long until the remediation was
 * ordered, and how long until the last robot was back — which is the fleet's
 * own time-to-resolve and is named that.
 */
export interface CohortSpans {
  /** Detection → the halt: the window the blast radius could still grow in. */
  toContain?: number;
  /** Detection → the rollback being ordered. */
  toOrder?: number;
  /** Detection → the last member clearing. */
  toRestore?: number;
  /** Order → complete: what the staged walk actually cost. */
  rollbackRan?: number;
}

const between = (from: number | undefined, to: number | undefined): number | undefined =>
  from === undefined || to === undefined || to < from ? undefined : to - from;

export function cohortSpans(times: CohortTimes): CohortSpans {
  return {
    toContain: between(times.detected, times.halted),
    toOrder: between(times.detected, times.rollbackOrdered),
    toRestore: between(times.detected, times.lastRestored ?? times.completed),
    rollbackRan: between(times.rollbackOrdered, times.completed ?? times.lastRestored),
  };
}

/* -------------------------------------------------------------------------
   the staged rollback, as it played
   ------------------------------------------------------------------------- */

/** One unit's turn in the serial walk. */
export interface RollbackStep {
  unitId: string;
  /** When this unit's alert cleared — the wire's own word that it is back. */
  at: number;
  /** From the order, so the reader can see the queue draining. */
  sinceOrder?: number;
  /** From the unit before it: the cadence, which is the thing "one at a time" means. */
  sincePrevious?: number;
  fwAfter?: string;
}

/**
 * The rollback as an operation over time, rather than as a table of units.
 *
 * The affected-units table above it says what happened to each robot; this says
 * what the *remediation* looked like — four restorations, four seconds apart,
 * in roster order. That cadence is the fact the card's progress list makes
 * visible while it runs and which nothing keeps afterwards, and it is the
 * difference between "we rolled back four units" and "we rolled back four units
 * one at a time, and it took sixteen seconds".
 *
 * Ordered by when each unit actually cleared, not by the roster: a walk that is
 * asserted to be serial should be *shown* to have been serial, and the day the
 * engine restores two at once this list says so instead of hiding it.
 */
export function rollbackChronology(
  rows: readonly CohortUnitRow[],
  orderedAt: number | undefined,
): RollbackStep[] {
  const steps = rows
    .filter((r): r is CohortUnitRow & { cleared: number } => r.cleared !== undefined)
    .map((r) => ({ unitId: r.unitId, at: r.cleared, fwAfter: r.fwAfter }))
    .sort((a, b) => a.at - b.at || (a.unitId < b.unitId ? -1 : 1));

  return steps.map((step, i) => {
    const previous = steps[i - 1];
    return {
      ...step,
      sinceOrder: between(orderedAt, step.at),
      sincePrevious: previous === undefined ? undefined : step.at - previous.at,
    };
  });
}

/* -------------------------------------------------------------------------
   the save
   ------------------------------------------------------------------------- */

/** A unit that did not take the suspect build, and what it stayed on. */
export interface PreventedUpdate {
  unitId: string;
  /** The build it remains on — read off the receipt, not off a baseline constant. */
  fw: string;
  /** When the halt landed. */
  at: number;
  /**
   * The receipt itself, verbatim. Carried rather than rebuilt from the two
   * fields beside it: the report *quotes* this line under a caption naming who
   * recorded it, and a quotation the console reassembled from its own parse is
   * not a quotation.
   */
  note: string;
}

/**
 * The updates that never happened.
 *
 * This is the one figure in the product with no journal behind it, because the
 * event is a non-event: a robot that did not install a build raises no alert,
 * runs no command and files no unit_update saying so. What exists is the halt's
 * receipt — `ROLLOUT HALTED — N-05 REMAINS ON 2.3.7`, the engine's own line,
 * kept verbatim in the session log by the command store — and this reads it and
 * nothing else. No inference from `fwPending` having gone away, no counting of
 * units that "should" have been next: those would be the console asserting a
 * save on its own authority, on the one page where it would most like to.
 *
 * The report calls the result "prevented", never "saved", and prints the count
 * beside the count of units that had to be rolled back. One robot spared and
 * four restored is a fact with a shape; "the operator saved the fleet" is a
 * claim, and this document does not make claims.
 */
export function preventedUpdates(log: readonly AuditEntry[]): PreventedUpdate[] {
  const seen = new Set<string>();
  const out: PreventedUpdate[] = [];
  // Oldest first, so the first halt of the incident leads.
  for (const entry of [...log].reverse()) {
    if (entry.kind !== "rollout-halted") continue;
    const facts = haltReceiptFacts(entry.summary);
    if (facts === null || seen.has(facts.unitId)) continue;
    seen.add(facts.unitId);
    out.push({ ...facts, at: entry.ts, note: entry.summary });
  }
  return out;
}

/**
 * A halt the fleet declined, and why.
 *
 * The other ending of the storyline: an operator who reached for HALT after the
 * queued install had already landed gets `NO ROLLOUT ACTIVE`, and the report
 * has to be able to say that as plainly as it says a save. The reason is
 * carried verbatim — a refusal is the fleet's own words (cohort-copy.ts) — and
 * it is sliced back out of the summary the command store wrote rather than read
 * from the live command state, which the operator is free to clear.
 */
export interface HaltRefusal {
  reason: string;
  at: number;
}

const FAILED_MARKER = "failed: ";

export function haltRefusal(log: readonly AuditEntry[]): HaltRefusal | null {
  const entry = firstOfKind(
    log.filter((e) => e.ref?.startsWith("HALT_ROLLOUT") ?? false),
    "command-failed",
  );
  if (entry === undefined) return null;
  const at = entry.summary.indexOf(FAILED_MARKER);
  const reason =
    at === -1 ? "" : entry.summary.slice(at + FAILED_MARKER.length).trim();
  return { reason, at: entry.ts };
}

/* -------------------------------------------------------------------------
   the actions
   ------------------------------------------------------------------------- */

/** One fleet-scale intervention, folded to a row: what was done, and what came of it. */
export interface CohortAction {
  /** "Halt rollout" · "Roll back cohort" — the words the ladder is matched on. */
  label: string;
  outcome: string;
  at: number;
  refused: boolean;
}

/**
 * The two fleet commands, read out of the log rather than out of the command
 * store.
 *
 * The store's copy is dismissable — the card's Clear button is how an operator
 * puts a finished lifecycle away — and a report that lost a row because someone
 * tidied the card would be an archive with a delete key on it. The log is
 * append-only and was written by the store at the moment it admitted the fact,
 * so the two cannot disagree; only one of them survives being read twice.
 */
export function cohortActions(log: readonly AuditEntry[], fw: string): CohortAction[] {
  const out: CohortAction[] = [];
  for (const entry of [...log].reverse()) {
    switch (entry.kind) {
      case "rollout-halted": {
        const facts = haltReceiptFacts(entry.summary);
        out.push({
          label: "Halt rollout",
          outcome:
            facts === null
              ? "complete"
              : `complete — ${facts.unitId} remains on ${facts.fw}`,
          at: entry.ts,
          refused: false,
        });
        break;
      }
      case "rollback-complete":
        out.push({
          label: "Roll back cohort",
          outcome: `complete — every unit off ${fw}`,
          at: entry.ts,
          refused: false,
        });
        break;
      case "command-failed":
        out.push({
          label: entry.ref?.startsWith("HALT_ROLLOUT") ? "Halt rollout" : "Roll back cohort",
          outcome: `refused — ${entry.summary.slice(entry.summary.indexOf(FAILED_MARKER) + FAILED_MARKER.length).trim()}`,
          at: entry.ts,
          refused: true,
        });
        break;
      default:
        break;
    }
  }
  // A rollback that was ordered and has not finished is still an action taken,
  // and leaving it out until the last unit lands would make the report read as
  // if nobody had done anything for the sixteen seconds it takes.
  const started = firstOfKind(log, "rollback-started");
  if (started !== undefined && !out.some((a) => a.label === "Roll back cohort")) {
    out.push({
      label: "Roll back cohort",
      outcome: "ordered — staged restoration running",
      at: started.ts,
      refused: false,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}
