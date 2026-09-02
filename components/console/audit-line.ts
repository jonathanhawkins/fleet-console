import { type AuditEntry, type AuditKind } from "@/lib/stores";
import { haltReceipt } from "./cohort-copy";
import { commandLabel } from "./session-events";
import { type SectionLabelProps } from "./section-label";

/**
 * ## Reading, not rewriting
 *
 * One more job landed here with Phase 10: collapsing the rows that say the same
 * thing about the same moment. The store is right to hold both — two alerts
 * were resolved, and each one's closure is a fact with its own ref — and the
 * *reader* is right to see one line, because "resolved, resolved" at 19:42:47
 * reads as a stutter rather than as two alerts. That reconciliation belongs at
 * render level and nowhere else: nothing is dropped from the record, and the
 * count is printed so the collapsed line still tells the whole truth.
 */

/**
 * The session log, said in operator English.
 *
 * The audit store is the record; this is the reading of it. Most entries
 * already arrive in the right voice — `Acknowledged by Operator`, `Diagnostic
 * scan started`, `Resolved — diagnostic incident logged` — and those are
 * printed verbatim, because a log that paraphrases its own source is a log you
 * cannot cite. Three kinds are not, and each is rewritten for a specific
 * reason rather than as a matter of taste:
 *
 * - `escalation` is stored as "Escalated amber → red", which is the *wire's*
 * vocabulary. Operator space has never shown an operator the words amber and
 * red; it says Attention and Alert (unit-status.ts), and a log that
 * introduced two new severity words on its most important line would make
 * the reader stop and map them.
 * - `diag-verdict` carries the machine's own summary — "LIVE TRACE 1.4-1.8x
 * REFERENCE ENVELOPE" — which is exactly right in machine space and reads as
 * a different product shouting on a warm-white page (the same judgement
 * incident-banner.tsx makes about `report.summary`). The finding itself is
 * printed in the operator's voice one card above, in the incident history;
 * here the fact is that a verdict landed, and the ref links the two.
 * - the command kinds carry `SAFE SIT accepted`, uppercase because the command
 * name is the machine's. `commandLabel` turns the ref back into a word.
 * - `rollout-halted` carries the engine's receipt note verbatim — `ROLLOUT
 * HALTED — N-05 REMAINS ON 2.3.7` — because the store is right to record the
 * machine's own words for the one thing this whole storyline turns on: a unit
 * that did NOT get the bad build. A whole sentence in caps is louder than
 * anything else in this log, though, so it is *read* here in sentence case by
 * the same helper the fleet incident card uses (`haltReceipt`), which keeps
 * the two surfaces quoting one shape and leaves the record itself untouched.
 * A receipt that helper does not recognise passes through verbatim.
 *
 * Nothing in this file imports a component module. It is pulled into the fleet
 * page through the alert feed, and reaching into incident-banner.tsx for its
 * `incidentHeadline` — the obvious DRY move for the prefix trim below — would
 * drag the unit page's banner, its reveal spring and the descent's preload
 * hook into a bundle that has no use for any of them.
 */

export interface AuditTag {
  /** Sentence case in source; SectionLabel uppercases it. */
  label: string;
  tone: SectionLabelProps["tone"];
}

/**
 * A kind, named and toned.
 *
 * Two colours in the whole log, and they are the two directions a situation
 * can move: `escalation` and a refused command are things getting worse,
 * `resolution` is a thing getting better. Everything else is muted, because a
 * log where every line is coloured is a log with no emphasis in it — and
 * because the tags name *kinds*, not severities: an `alert-raised` entry does
 * not carry the severity that would let it choose honestly between amber and
 * clay, and guessing would put a warn tag on a red raise.
 */
export const AUDIT_TAG: Record<AuditKind, AuditTag> = {
  "alert-raised": { label: "Raised", tone: "muted" },
  escalation: { label: "Escalated", tone: "alert" },
  "alert-acked": { label: "Acknowledged", tone: "muted" },
  resolution: { label: "Resolved", tone: "nominal" },
  "diag-start": { label: "Diagnostic", tone: "muted" },
  "diag-verdict": { label: "Verdict", tone: "muted" },
  // Muted, not nominal: a partial correction is not a thing getting better
  // enough to spend the log's one green on, and the tag names the kind rather
  // than the outcome — the summary carries which of the two it was.
  "diag-recalibrated": { label: "Recalibrated", tone: "muted" },
  "command-accepted": { label: "Command", tone: "muted" },
  "command-complete": { label: "Command", tone: "muted" },
  "command-failed": { label: "Refused", tone: "alert" },
  // Phase 11 fleet-scoped kinds, toned by the same two directions: a detected
  // cohort is the situation widening (the fleet-level escalation); the halt
  // and the finished rollback are it contracting; a rollback merely starting
  // has not moved it yet.
  "cohort-detected": { label: "Cohort", tone: "alert" },
  "rollout-halted": { label: "Halted", tone: "nominal" },
  "rollback-started": { label: "Rollback", tone: "muted" },
  "rollback-complete": { label: "Rollback", tone: "nominal" },
};

/**
 * The wire prefixes every alert with the house name, because the fleet feed
 * mixes eight houses in one list. Every surface that renders this log is
 * scoped to one unit, so the prefix is the console telling the operator where
 * they already are.
 */
function trimUnit(summary: string, unitName: string | undefined): string {
  if (!unitName) return summary;
  const prefix = `${unitName}: `;
  if (!summary.startsWith(prefix)) return summary;
  const body = summary.slice(prefix.length);
  return body.charAt(0).toUpperCase() + body.slice(1);
}

export function auditLine(entry: AuditEntry, unitName?: string, count = 1): string {
  if (count > 1 && entry.kind === "resolution")
    return countedResolution(entry.summary, count);
  switch (entry.kind) {
    case "alert-raised":
      return trimUnit(entry.summary, unitName);
    case "escalation":
      return "Escalated to alert";
    case "diag-verdict":
      return "Diagnostic verdict recorded";
    case "command-accepted":
      return `${commandLabel(entry.ref)} accepted`;
    case "command-complete":
      return `${commandLabel(entry.ref)} complete`;
    case "command-failed":
      return refusalLine(commandLabel(entry.ref), entry.summary);
    case "rollout-halted":
      return haltReceipt(entry.summary) ?? entry.summary;
    default:
      return entry.summary;
  }
}

/**
 * "Halt rollout refused — NO ROLLOUT ACTIVE".
 *
 * The reason is the only content a refusal has, and it is the one class of
 * machine voice this console carries verbatim everywhere it appears (see the
 * note at the top of cohort-copy.ts): a refusal is the fleet declining what the
 * operator just asked for, and the exact words are the citation. The command
 * name in front of it becomes a word, like every other command line here — the
 * store writes `SAFE SIT failed: ALREADY SITTING`, and "failed" is the wrong
 * verb for a machine that decided not to start.
 *
 * A summary without a reason still reads: the line degrades to the bare
 * "refused" it printed before this existed.
 */
function refusalLine(label: string, summary: string): string {
  const at = summary.indexOf("failed: ");
  const reason = at === -1 ? "" : summary.slice(at + "failed: ".length).trim();
  return reason === "" ? `${label} refused` : `${label} refused — ${reason}`;
}

/**
 * The plural line.
 *
 * The grouping itself lives in session-events.ts, with the rest of "how many
 * things happened" — the timeline collapses the same cluster into one tick, and
 * a log and a timeline that disagreed about what counts as one moment would be
 * two readings of one record. This file keeps what it has always kept: how the
 * row is *said*.
 */

/**
 * "Resolved — diagnostic incident logged" × 2 → "Resolved 2 alerts —
 * diagnostic incident logged".
 *
 * The count goes after the verb and the rest of the store's sentence is carried
 * through untouched, so the collapsed line stays quotable against the record and
 * a resolution reason this file has never heard of still reads correctly.
 */
function countedResolution(summary: string, count: number): string {
  const verb = "Resolved";
  if (!summary.startsWith(verb)) return `${summary} · ${count} alerts`;
  return `${verb} ${count} alerts${summary.slice(verb.length)}`;
}
