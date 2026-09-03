"use client";

import { acknowledgedTime } from "@/components/machine/safe-sit-copy";
import { type AuditEntry, type IncidentRecord } from "@/lib/stores";
import { SectionLabel } from "@/components/console";
import { clockTime } from "../alert-lifecycle";
import { recoveryTier } from "../incident-report";
import { ReportSection } from "../report-surface";
import { commandLabel } from "../session-events";

export interface ExecutedCommand {
  /** The ref of the beat that opened the row; unique per command sent. */
  ref: string;
  label: string;
  acceptedAt?: number;
  completedAt?: number;
  failedAt?: number;
}

/**
 * The commands that actually reached the robot, folded back into one row each.
 *
 * The log records a command three times — accepted, then complete or refused —
 * which is right for a log and wrong for a report: an operator reading a
 * write-up wants one line per thing they did, with what became of it.
 *
 * ## Folding by name, not by ref
 *
 * The audit ref is `<COMMAND>#<seq>` and the sim draws a *fresh* seq for every
 * beat it sends, deliberately: the command store treats seq as the ordering
 * authority, so an accept and its completion cannot share one. Folding on the
 * ref therefore folded nothing, and a single recalibration printed twice — once
 * accepted, once complete — which is the log the report exists to stop being.
 *
 * So an outcome joins the newest row of the same command that is still open.
 * Two safe sits in one incident stay two rows, because the second one's accept
 * closes nothing and opens a row of its own; an outcome with no open row to
 * join (a completion whose accept fell outside this incident's window) opens
 * its own rather than being dropped.
 */
export function executedCommands(entries: readonly AuditEntry[]): ExecutedCommand[] {
  const rows: ExecutedCommand[] = [];
  const open = new Map<string, ExecutedCommand>();
  // Oldest first, so a row is built in the order its beats happened.
  for (const entry of [...entries].reverse()) {
    if (!entry.kind.startsWith("command-") || entry.ref === undefined) continue;
    const label = commandLabel(entry.ref);
    if (entry.kind === "command-accepted") {
      const row: ExecutedCommand = { ref: entry.ref, label, acceptedAt: entry.ts };
      rows.push(row);
      open.set(label, row);
      continue;
    }
    const row = open.get(label) ?? { ref: entry.ref, label };
    if (!open.has(label)) rows.push(row);
    if (entry.kind === "command-complete") row.completedAt = entry.ts;
    if (entry.kind === "command-failed") row.failedAt = entry.ts;
    open.delete(label);
  }
  return rows;
}

function TierTag({ action }: { action: string }) {
  const tier = recoveryTier(action);
  if (!tier) return null;
  return (
    <SectionLabel as="span" className="shrink-0">
      {tier}
    </SectionLabel>
  );
}

export function ActionsBlock({
  record,
  executed,
}: {
  record: IncidentRecord;
  executed: readonly ExecutedCommand[];
}) {
  /**
   * An action the operator pressed AND the console sent is one action. It is
   * listed where it carries the most information — under the commands, with
   * the robot's answer beside it — and not repeated below under a heading whose
   * own footnote says no command was sent, which for that row was never true.
   */
  const sent = new Set(executed.map((c) => c.label));
  const recorded = record.acknowledged.filter((a) => !sent.has(a));
  const nothing = recorded.length === 0 && executed.length === 0;

  return (
    <ReportSection label="Actions">
      {nothing ? (
        // Said plainly rather than omitted, exactly as the history row does: "no
        // actions were taken" is itself a fact about an incident.
        <p className="text-small text-ink-soft">No actions were recorded or executed.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {executed.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SectionLabel as="h3" tone="ink">
                Executed on the unit
              </SectionLabel>
              <ul className="flex flex-col divide-y divide-line">
                {executed.map((command) => (
                  <li
                    key={command.ref}
                    data-command={command.ref}
                    className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="text-small text-ink">{command.label}</span>
                    <span className="tnum text-small text-ink-soft">
                      {commandOutcome(command)}
                    </span>
                    <span className="ml-auto">
                      <TierTag action={command.label} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {recorded.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SectionLabel as="h3" tone="ink">
                Recorded to the incident
              </SectionLabel>
              <ul className="flex flex-col divide-y divide-line">
                {recorded.map((action) => {
                  const at =
                    record.startedAt === undefined
                      ? undefined
                      : acknowledgedTime(record.unitId, record.startedAt, action);
                  return (
                    <li
                      key={action}
                      data-action={action}
                      className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
                    >
                      <span className="text-small text-ink">{action}</span>
                      <span className="tnum text-small text-ink-soft">
                        {/* No time on file is possible — an acknowledgement
                            restored without the press that made it — and the
                            honest answer is the word alone rather than a
                            plausible-looking clock reading nobody observed. */}
                        {at === undefined ? "recorded" : `recorded ${clockTime(at)}`}
                      </span>
                      <span className="ml-auto">
                        <TierTag action={action} />
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="text-label tracking-normal text-ink-soft">
                Recorded actions enter this incident; no command was sent to the unit.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </ReportSection>
  );
}

function commandOutcome(command: ExecutedCommand): string {
  if (command.failedAt !== undefined) return `refused ${clockTime(command.failedAt)}`;
  if (command.completedAt !== undefined)
    return `complete ${clockTime(command.completedAt)}`;
  if (command.acceptedAt !== undefined)
    return `accepted ${clockTime(command.acceptedAt)}`;
  return "no outcome recorded";
}
