import { create } from "zustand";
import { FLEET_AUDIT_SCOPE, useAuditStore, type AuditEntry } from "./auditStore";
import { useCommandStore } from "./commandStore";
import { useFleetStore, type FleetState } from "./fleetStore";

/**
 * Cohort detection: the fleet-wide incident DERIVED from state the
 * fleet store already holds — never a second copy of the wire. A cohort is
 * >= COHORT_THRESHOLD units saying byte-identical words on the same firmware:
 * unresolved alerts grouped by (signature = alert.message, fw = the raising
 * unit's CURRENT firmware). The grouping is the epic's thesis made checkable —
 * one robot alerting is that robot's problem; three saying the same words on
 * the same build is the build's.
 *
 * This is a derivation module, not a store: there is no setState, no
 * subscription, no reducer. The UI subscribes through the fleet store —
 * `useFleetStore(selectCohorts)` — and the selector is memoized on the
 * identities of the three slices the derivation reads (`units`, `alerts`,
 * `alertMeta`). Telemetry commits mutate none of those identities (its
 * in-place discipline), so at 10 Hz x N units the selector costs three
 * reference compares; the real recompute runs only when an alert is raised or
 * resolved, a unit_update lands (firmware moves), or a snapshot restates the
 * world. The result keeps its identity when its content is unchanged, so
 * subscribers re-render only when cohort truth moves.
 *
 * Membership tracks CURRENT truth: an alert leaves when it resolves (operator
 * or wire), a unit leaves the (signature, fw) group the moment a rollback
 * restates its firmware. A cohort therefore counts down during a staged
 * rollback and dissolves below the threshold — the UI's incident card should
 * ride `selectFleetCommand("ROLLBACK_COHORT")` for the tail of the story
 * rather than expect the derivation to remember a fixed membership.
 *
 * Instance identity is latched: when a group first crosses the threshold, its
 * `id` and `detectedAt` freeze (detectedAt = the ts of the alert that crossed
 * — the threshold-th oldest member at that instant) and stay stable while the
 * group remains at or above threshold, however membership churns above it.
 * Dropping below threshold retires the instance; a later re-cross is a NEW
 * instance — which is what lets RESET_SIM's replayed storyline detect again.
 * `cohort-detected` is audited once per instance id, on the message path
 * (bindTransport calls `auditCohortDetections` after alert-shaped messages),
 * never from render.
 */

/** A cohort exists at >= this many same-(signature, fw) unresolved alerts. */
export const COHORT_THRESHOLD = 3;

/** One firmware's row in the canary comparison: how much of it is affected. */
export interface CohortCanary {
  fw: string;
  /** Units on this fw with an unresolved alert bearing the cohort's signature. */
  affected: number;
  /** Units on this fw, fleet-wide. */
  total: number;
}

/** The derived fleet incident the UI card renders. */
export interface CohortIncident {
  /** Latched instance id ("cohort-<fw>-<detectedAt>"), stable for the instance's lifetime. */
  id: string;
  /** The shared alert message — byte-identical across members by design. */
  signature: string;
  /** The firmware the members share (and the rollback target names). */
  fw: string;
  /** Member units, oldest raise first. */
  unitIds: string[];
  /** Member alerts, same order as unitIds. */
  alertIds: string[];
  /** ts of the alert that crossed the threshold; frozen at detection. */
  detectedAt: number;
  /**
   * The canary comparison, one row per firmware in the fleet, suspect
   * (highest version) first: affected/total per fw. The demo's shape —
   * 4/4 on 2.4.1 against 0/4 on 2.3.7 — is the rollback's justification;
   * N-07's knee alert never counts because its message is not the signature.
   */
  canary: CohortCanary[];
}

/** Descending semver-ish compare so the suspect (newest) firmware leads the canary table. */
function compareFwDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Latched instances by group key (fw + signature), while at/above threshold. */
const liveInstances = new Map<string, { id: string; detectedAt: number }>();
/** Instance ids already sent to the audit log this session. */
const auditedInstances = new Set<string>();

/** Memo over the three fleet-store slices the derivation reads. */
let memoUnits: FleetState["units"] | null = null;
let memoAlerts: FleetState["alerts"] | null = null;
let memoAlertMeta: FleetState["alertMeta"] | null = null;
let memoResult: CohortIncident[] = [];

function sameIncident(a: CohortIncident, b: CohortIncident): boolean {
  return (
    a.id === b.id &&
    a.signature === b.signature &&
    a.fw === b.fw &&
    a.detectedAt === b.detectedAt &&
    a.unitIds.length === b.unitIds.length &&
    a.unitIds.every((u, i) => u === b.unitIds[i]) &&
    a.alertIds.every((al, i) => al === b.alertIds[i]) &&
    a.canary.length === b.canary.length &&
    a.canary.every(
      (c, i) =>
        c.fw === b.canary[i]!.fw &&
        c.affected === b.canary[i]!.affected &&
        c.total === b.canary[i]!.total,
    )
  );
}

function recompute(s: FleetState): CohortIncident[] {
  // 1) Group unresolved alerts by (fw, signature). fw is the unit's CURRENT
  // firmware: a rolled-back unit leaves the group the moment its
  // unit_update lands, before its alert_clear even arrives.
  const groups = new Map<
    string,
    {
      fw: string;
      signature: string;
      members: Array<{ alertId: string; unitId: string; ts: number }>;
    }
  >();
  for (const alert of s.alerts) {
    if (s.alertMeta[alert.id]?.resolvedAt !== undefined) continue; // resolved: inactive
    const fw = s.units[alert.unitId]?.fw;
    if (fw === undefined) continue; // pre-firmware unit: nothing to group on
    const key = `${fw}\u0000${alert.message}`;
    let group = groups.get(key);
    if (!group) {
      group = { fw, signature: alert.message, members: [] };
      groups.set(key, group);
    }
    group.members.push({ alertId: alert.id, unitId: alert.unitId, ts: alert.ts });
  }

  // 2) Firmware totals across the roster (canary denominators).
  const totals = new Map<string, number>();
  for (const id of s.unitIds) {
    const fw = s.units[id]?.fw;
    if (fw === undefined) continue;
    totals.set(fw, (totals.get(fw) ?? 0) + 1);
  }

  // 3) Groups at/above threshold become incidents; the rest retire their latch.
  const incidents: CohortIncident[] = [];
  for (const [key, group] of groups) {
    // Oldest raise first; alert-id tiebreak keeps equal-ts order deterministic.
    group.members.sort((a, b) => a.ts - b.ts || (a.alertId < b.alertId ? -1 : 1));

    if (group.members.length < COHORT_THRESHOLD) {
      liveInstances.delete(key);
      continue;
    }

    let instance = liveInstances.get(key);
    if (!instance) {
      const detectedAt = group.members[COHORT_THRESHOLD - 1]!.ts;
      instance = { id: `cohort-${group.fw}-${detectedAt}`, detectedAt };
      liveInstances.set(key, instance);
    }

    // Canary rows: same-signature affected units per firmware, suspect first.
    const affectedByFw = new Map<string, Set<string>>();
    for (const [, g] of groups) {
      if (g.signature !== group.signature) continue;
      let set = affectedByFw.get(g.fw);
      if (!set) {
        set = new Set();
        affectedByFw.set(g.fw, set);
      }
      for (const m of g.members) set.add(m.unitId);
    }
    const canary: CohortCanary[] = [...totals.keys()].sort(compareFwDesc).map((fw) => ({
      fw,
      affected: affectedByFw.get(fw)?.size ?? 0,
      total: totals.get(fw) ?? 0,
    }));

    incidents.push({
      id: instance.id,
      signature: group.signature,
      fw: group.fw,
      unitIds: group.members.map((m) => m.unitId),
      alertIds: group.members.map((m) => m.alertId),
      detectedAt: instance.detectedAt,
      canary,
    });
  }

  // Retire latches whose group vanished entirely (all members resolved).
  for (const key of liveInstances.keys()) {
    if (!groups.has(key) || groups.get(key)!.members.length < COHORT_THRESHOLD) {
      liveInstances.delete(key);
    }
  }

  incidents.sort((a, b) => a.detectedAt - b.detectedAt || (a.id < b.id ? -1 : 1));
  return incidents;
}

/**
 * The derived fleet incidents, oldest detection first (empty array = no
 * cohort). Memoized: costs three reference compares on telemetry commits, and
 * keeps the previous array identity whenever content is unchanged — safe to
 * subscribe bare (`useFleetStore(selectCohorts)`), no useShallow needed.
 */
export const selectCohorts = (s: FleetState): CohortIncident[] => {
  if (memoUnits === s.units && memoAlerts === s.alerts && memoAlertMeta === s.alertMeta) {
    return memoResult;
  }
  memoUnits = s.units;
  memoAlerts = s.alerts;
  memoAlertMeta = s.alertMeta;

  const next = recompute(s);
  const unchanged =
    next.length === memoResult.length &&
    next.every((inc, i) => sameIncident(inc, memoResult[i]!));
  if (!unchanged) memoResult = next;
  return memoResult;
};

/**
 * Append a `cohort-detected` audit entry for every instance not yet audited
 * this session — once per instance id, ref'd by it (the audit store's
 * (kind, ref) dedupe is the second lock). Called by bindTransport after
 * alert-shaped messages — the message path, never render. Membership can only
 * ever CROSS the threshold on a wire message (UI actions only resolve), so
 * this hook sees every detection.
 */
export function auditCohortDetections(): void {
  const cohorts = selectCohorts(useFleetStore.getState());
  for (const cohort of cohorts) {
    if (auditedInstances.has(cohort.id)) continue;
    auditedInstances.add(cohort.id);
    useAuditStore.getState().append({
      ts: cohort.detectedAt,
      kind: "cohort-detected",
      unitId: FLEET_AUDIT_SCOPE,
      summary: `Cohort detected — ${cohort.unitIds.length} units on ${cohort.fw}: "${cohort.signature}"`,
      ref: cohort.id,
    });
  }
}

/**
 * Clear the memo, the instance latch, and the audited set. Tests call this in
 * beforeEach next to the stores' reset()s; the app never needs it (module
 * state dies with the page).
 */
export function resetCohortDerivation(): void {
  liveInstances.clear();
  auditedInstances.clear();
  memoUnits = null;
  memoAlerts = null;
  memoAlertMeta = null;
  memoResult = [];
}

/* ---------------------------------------------------------------------------
   The close-out
--------------------------------------------------------------------------- */

/**
 * A fleet incident the operator has closed.
 *
 * The derivation above cannot hold this. It tracks *current* truth by design —
 * a group that is no longer at threshold is not a cohort — so by the time an
 * incident is closeable the derivation has already forgotten it. The card holds
 * the incident at its widest while it is on screen (`useCohortSubject`), and
 * that memory dies with the card; what survives here is the same subject, kept
 * because the incident closing must not close the *record* of it. The report is
 * still a document about a thing that happened, and it needs its subject to
 * render.
 *
 * Session-scoped, exactly like the audit log it is written beside: a sim reset
 * does not un-happen the incident the operator just worked (auditStore.ts).
 */
/**
 * The journals as they stood when the incident was filed — the record's own
 * evidence, and the thing that makes it a record at all.
 *
 * The write-up behind a filed incident used to re-derive from the live stores,
 * which is fine for exactly as long as the session stands still. It does not:
 * RESET_SIM replays the storyline, and a snapshot empties the alert feed and
 * puts every unit back on the suspect build. The document then read its own
 * subject out of a world that no longer contained it — every raise and clear
 * came back "Not recorded", every member read "still on build", and the
 * differential inverted from "the cohort was rolled back and every alert
 * cleared with the build" to "roll the cohort back", underneath a chronology
 * still narrating the rollback that had happened. The audit log survives a
 * reset by design (auditStore.ts), so the second run's fleet entries would have
 * been counted as the first incident's as well.
 *
 * So a filed record carries its inputs rather than fetching them. Nothing is
 * copied: the fleet and audit stores are copy-on-write for every one of these
 * slices — telemetry mutates rings and battery readings in place and never a
 * `units` entry (fleetStore.ts) — so this is five references, and holding them
 * is what freezes them.
 */
export interface CohortArchive {
  alerts: FleetState["alerts"];
  alertMeta: FleetState["alertMeta"];
  units: FleetState["units"];
  audit: readonly AuditEntry[];
  /** The roster the canary comparison is counted across. */
  fleetSize: number;
}

export interface CohortResolution {
  /** The incident at its widest, as the card was holding it. */
  cohort: CohortIncident;
  /** When the operator filed it — an operator fact, so the console's clock. */
  at: number;
  /**
   * When the fleet closed it, where a journal recorded the moment: the last
   * member's alert clearing, or the staged rollback being declared complete.
   * Absent where neither is on file — the console does not date a closure it
   * cannot cite.
   */
  closedAt?: number;
  /** The evidence, frozen at the filing. See {@link CohortArchive}. */
  archive: CohortArchive;
}

export interface CohortRecordState {
  /**
   * The most recently closed fleet incident, or null. One at a time, because
   * the fleet page shows one incident at a time: a second cohort's closure
   * supersedes the first, and the audit log keeps both either way.
   */
  record: CohortResolution | null;
  /** The operator closing a settled incident. See `resolve` below. */
  resolve(cohort: CohortIncident, closedAt?: number): void;
  /**
   * Give the slot back. Called by the fleet page's gate when a NEW incident is
   * detected — one at a time, and the arriving card wants the place the record
   * is standing in — and by tests. Never by a snapshot: a sim reset does not
   * un-happen the incident the operator just worked, and the log would keep the
   * closure anyway (auditStore.ts). Surviving a reset is only honest because
   * the record carries its own evidence ({@link CohortArchive}); before it did,
   * the surviving line opened a document that had lost its subject.
   */
  reset(): void;
}

export const useCohortRecordStore = create<CohortRecordState>()((set) => ({
  record: null,

  /**
   * Close the incident — a RECORD action, not an EXECUTE one.
   *
   * Nothing goes on the wire. HALT_ROLLOUT and ROLLBACK_COHORT move robots and
   * are gated accordingly (a confirmation, an impact list, cancel-first focus);
   * this states that an operator is done reading a finished incident, and a
   * confirmation dialog in front of it would teach them to dismiss the ones
   * that matter. It is the fleet-scale twin of resolving an alert, and it
   * writes the same kind of entry.
   *
   * Three things happen together because they are one fact: the record is
   * filed, the session log is appended (the audit store is written by stores,
   * never by the UI — auditStore.ts), and the two finished fleet command
   * lifecycles are put away. The last one matters beyond tidiness: a completed
   * command left on file is what `useCohortSubject` reads to keep a dissolved
   * cohort's card on screen, so an incident that closed without clearing them
   * would come back as the next run's card carrying the last run's receipts.
   *
   * Filing is also the moment the evidence is taken, which is what makes this a
   * record rather than a bookmark into the live stores ({@link CohortArchive}).
   */
  resolve: (cohort, closedAt) => {
    const at = Date.now();
    useAuditStore.getState().append({
      ts: at,
      kind: "resolution",
      unitId: FLEET_AUDIT_SCOPE,
      // Deliberately not "restored": the operator is closing an incident, not
      // asserting that every robot came back. What was actually done is on the
      // rows above this one, in the fleet's own words.
      summary: `Fleet incident closed by operator — ${cohort.unitIds.length} units on ${cohort.fw}`,
      ref: cohort.id,
    });
    // Taken after the closure is logged, so the archived chronology ends where
    // the incident does rather than one line short of it.
    const fleet = useFleetStore.getState();
    const archive: CohortArchive = {
      alerts: fleet.alerts,
      alertMeta: fleet.alertMeta,
      units: fleet.units,
      audit: useAuditStore.getState().entries,
      fleetSize: fleet.unitIds.length,
    };
    set({
      record: { cohort, at, ...(closedAt === undefined ? {} : { closedAt }), archive },
    });
    const commands = useCommandStore.getState();
    commands.dismissFleetCommand("HALT_ROLLOUT");
    commands.dismissFleetCommand("ROLLBACK_COHORT");
  },

  reset: () => set({ record: null }),
}));

/** The closed incident, or null. Identity moves only on a resolve — safe bare. */
export const selectCohortRecord = (s: CohortRecordState): CohortResolution | null =>
  s.record;
