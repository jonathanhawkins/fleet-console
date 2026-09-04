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
}

export interface AuditState {
  /** Newest first (feed order, like alerts and incident history). Append-only. */
  entries: AuditEntry[];
  /** Called by the other stores; the UI never appends. Deduped by (kind, ref). */
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
      const withId: AuditEntry = { id: `audit-${s.entries.length + 1}`, ...entry };
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
