import { create } from "zustand";

/**
 * Audit store: the append-only session log — the single source the UI renders
 * when it answers "what happened on this operator's watch?".
 *
 * Entries are appended by the other stores at the moment they ADMIT the
 * underlying fact (fleet store: alerts raised / escalations / acks /
 * resolutions; incident store: scan start / verdict; command store: command
 * accepted / complete / failed — progress beats are deliberately not logged,
 * they are narration, not record). Nothing else writes here; the UI only
 * reads.
 *
 * Session-scoped means console-session-scoped: the log survives RESET_SIM and
 * transport reconnects — a sim reset does not un-happen the incident the
 * operator just worked — and clears only with a page load (fresh stores) or
 * an explicit `reset()` in tests.
 *
 * **Replay-safe by (kind, ref).** Reconnects replay wire facts (the ws server
 * re-sends the run's alerts; command_events of an in-flight sit are re-sent
 * after a snapshot cleared the command store's seq gates). An entry that
 * carries a `ref` is therefore admitted once per (kind, ref): the second
 * "alert-raised al-001" is the same fact restated and is dropped by identity.
 * Entries without a ref are trusted to be admitted exactly once by their
 * producing store (the incident store's reducer already dedupes replayed diag
 * events).
 */

export type AuditKind =
  | "alert-raised"
  | "alert-acked"
  | "escalation"
  | "resolution"
  | "diag-start"
  | "diag-verdict"
  // the cheapest rung was tried, and what it was worth.
  | "diag-recalibrated"
  | "command-accepted"
  | "command-complete"
  | "command-failed"
  // Fleet-scoped: the rollout-cohort record.
  | "rollout-halted"
  | "rollback-started"
  | "rollback-complete"
  | "cohort-detected";

/**
 * `unitId` for entries whose subject is the fleet, not a unit (* `rollout-halted`, `rollback-started`, `rollback-complete`,
 * `cohort-detected`). They appear in the session log (`selectAuditLog`) and,
 * by construction, on no unit's page (`selectUnitAuditLog` filters by real
 * ids) — a fleet incident is the fleet page's business.
 */
export const FLEET_AUDIT_SCOPE = "fleet";

/**
 * Who did it.
 *
 * The audit trail's whole value is attribution — a log that records what
 * happened but not who caused it answers the easy half of every question asked
 * of it afterwards. This console has one operator and no sign-in, so the
 * honest model is not a user id: it is the *kind* of actor, which is a
 * distinction the trail was flattening. "N-03 recovered itself" and "the
 * operator halted the rollout" were the same shape of row, and they are not
 * the same kind of event.
 *
 * - `operator` — a person pressed something. One unnamed operator, because
 *   there is no authentication to name a second one; the label is the seam
 *   where a real deployment puts an identity.
 * - `unit` — the robot said so. Alerts it raised, faults it cleared by itself.
 * - `system` — neither: a scheduled install landing, a rollout program's own
 *   beat. Nobody decided it at the moment it happened.
 */
export type AuditActor =
  | { kind: "operator"; label: string }
  | { kind: "unit"; unitId: string }
  | { kind: "system" };

/** The one operator this demo has. A deployment replaces this with a session. */
export const OPERATOR: AuditActor = { kind: "operator", label: "Operator" };

/** The robot itself: what it reported, or resolved, without being asked. */
export const byUnit = (unitId: string): AuditActor => ({ kind: "unit", unitId });

/** No hand on it — a scheduled beat, a program running to its own clock. */
export const SYSTEM: AuditActor = { kind: "system" };

export interface AuditEntry {
  /** Session-unique, assigned on append ("audit-1", "audit-2", …). */
  id: string;
  /** Epoch ms — the wire message's ts where one exists, Date.now() for operator actions. */
  ts: number;
  kind: AuditKind;
  /** A unit id — or FLEET_AUDIT_SCOPE for fleet-scoped kinds. */
  unitId: string;
  /** One printable line; machine-voice strings appear verbatim. */
  summary: string;
  /** Linkage: alert id, incident id ("inc-N-07-…"), or "COMMAND_SAFE_SIT#<seq>". */
  ref?: string;
  /**
   * Who caused it — see {@link AuditActor}.
   *
   * Optional in the type and never absent in practice: `append()` fills it for
   * any producer that did not, so every stored row is attributed. It stays
   * optional so a caller building an entry does not have to answer a question
   * it has no better answer to than the default — the guarantee is held by a
   * test over the store rather than by the shape of the input.
   */
  actor?: AuditActor;
}

export interface AuditState {
  /** Newest first (feed order, like alerts and incident history). Append-only. */
  entries: AuditEntry[];
  /**
   * Called by the other stores; the UI never appends. Deduped by (kind, ref).
   *
   * `actor` is optional here and required on the stored entry: a caller that
   * has something to say about who acted says it, and one that does not gets
   * the default below rather than a field the reader has to treat as maybe-
   * missing. Every row in the trail has an actor; not every producer has to
   * think about it.
   */
  append(entry: Omit<AuditEntry, "id">): void;
  reset(): void;
}

export const useAuditStore = create<AuditState>()((set) => ({
  entries: [],

  append: (entry) =>
    set((s) => {
      if (
        entry.ref !== undefined &&
        s.entries.some((e) => e.kind === entry.kind && e.ref === entry.ref)
      ) {
        return s; // replayed fact: same identity, no new entry, no re-render
      }
      // Append-only, so length is monotonic and length+1 is a fresh id.
      //
      // The default actor is the unit the entry is about: an entry nobody
      // attributed came off the wire, and the wire is the robot talking. A
      // fleet-scoped row has no unit to credit, so it falls to the system —
      // which is exactly what a rollout beat is.
      const actor: AuditActor =
        entry.actor ??
        (entry.unitId === FLEET_AUDIT_SCOPE ? SYSTEM : byUnit(entry.unitId));
      const withId: AuditEntry = {
        id: `audit-${s.entries.length + 1}`,
        ...entry,
        actor,
      };
      return { entries: [withId, ...s.entries] };
    }),

  reset: () => set({ entries: [] }),
}));

// ---------------------------------------------------------------------------
// narrow selectors

/** The whole session log, newest first. Identity-stable per append — safe bare. */
export const selectAuditLog = (s: AuditState): AuditEntry[] => s.entries;

/**
 * One unit's log, newest first. Returns a fresh array — wrap with `useShallow`
 * (zustand/react/shallow) when subscribing from React.
 */
export const selectUnitAuditLog =
  (unitId: string) =>
  (s: AuditState): AuditEntry[] =>
    s.entries.filter((e) => e.unitId === unitId);

/**
 * Has this unit done anything worth logging? A boolean, so it is safe to
 * subscribe bare — and cheap enough to ask before deciding whether to fetch
 * the module that renders the answer.
 */
export const selectHasUnitAuditLog =
  (unitId: string) =>
  (s: AuditState): boolean =>
    s.entries.some((e) => e.unitId === unitId);
