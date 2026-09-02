"use client";

import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import {
  selectUnit,
  selectUnitAuditLog,
  useAuditStore,
  useFleetStore,
  type AuditEntry,
} from "@/lib/stores";
import { cn } from "@/lib/utils";
import { clockTime } from "./alert-lifecycle";
import { AUDIT_TAG, auditLine } from "./audit-line";
import { ConsoleButton } from "./console-button";
import { ConsoleCard } from "./console-card";
import { Disclosure } from "./disclosure";
import { RegionNote } from "./region-note";
import { isoTime } from "./relative-time";
import { SectionLabel } from "./section-label";
import { groupAuditEntries, spanLabel } from "./session-events";

/**
 * What happened on this operator's watch, for one unit.
 *
 * The audit store is the single source (lib/stores/README.md) and the UI never
 * appends to it — every line here was written by the store that admitted the
 * underlying fact, which is what makes this a record rather than a second
 * narration of the same events that could drift from the first.
 *
 * ## It reads oldest first, unlike everything else in the console
 *
 * The alert feed, the incident history and the store's own `entries` are all
 * newest first, because a feed answers "what is happening" and the answer is at
 * the top. This answers a different question — "how did we get here" — and a
 * story told bottom-up is a story the reader has to reverse in their head.
 * Raised, escalated, acknowledged, scanned, resolved, read downward, is the
 * shape of the incident; the same six lines upward is a list of six facts.
 *
 * ## One moment, one line
 *
 * The store holds one resolution entry per alert, which is correct — each
 * closure has its own ref and its own subject. Printed straight, the scripted
 * incident's amber and red therefore closed on two consecutive rows carrying the
 * identical sentence at the identical second, which reads as the log stuttering
 * rather than as two alerts closing together. `groupAuditEntries` collapses them
 * here, at render, and the row prints the count ("Resolved 2 alerts — …") so
 * nothing is lost by the collapse; the record underneath is untouched.
 */

export interface AuditChronologyProps extends Omit<
  React.ComponentPropsWithoutRef<"ol">,
  "children"
> {
  /** Newest first, as the store keeps them — this component reverses. */
  entries: readonly AuditEntry[];
  /** Trims the wire's house-name prefix off raised-alert lines. */
  unitName?: string;
  /** The row-expansion density: same columns, tighter and one step quieter. */
  dense?: boolean;
}

export function AuditChronology({
  className,
  entries,
  unitName,
  dense = false,
  ...props
}: AuditChronologyProps) {
  // A fresh array either way (the store's slice selector already returns one),
  // so the reversal costs nothing that was not already being paid. Grouped in
  // the same pass: the rows are what gets read, and a row can stand for more
  // than one entry (see above).
  const rows = React.useMemo(() => groupAuditEntries([...entries].reverse()), [entries]);

  return (
    <ol
      data-slot="audit-chronology"
      className={cn("flex flex-col", dense && "gap-1", className)}
      {...props}
    >
      {rows.map(({ entry, count }, i) => {
        const tag = AUDIT_TAG[entry.kind];
        const previous = rows[i - 1]?.entry;
        // The pause between this row and the one above it, if there was one
        // worth drawing. Measured between the times the rows *print*, because
        // those are the two numbers the reader is subtracting.
        const gap = !dense && previous ? entry.ts - previous.ts : 0;
        const paused = gap > GAP_MARKER_MS;
        return (
          <React.Fragment key={entry.id}>
            {paused ? <ChronologyPause ms={gap} /> : null}
            <li
              data-kind={entry.kind}
              data-collapsed={count > 1 ? count : undefined}
              className={cn(
                "flex flex-wrap items-baseline gap-x-3 gap-y-0.5",
                dense ? "py-0.5" : "py-2.5 first:pt-0 last:pb-0",
                // The rule belongs to the row, not to the list, so a pause can
                // stand between two rows without a hairline pinned above and
                // below it — which would draw the pause as a band, which is to
                // say as another kind of entry.
                !dense && i > 0 && !paused && "border-t border-line",
              )}
            >
              {/* Tabular, and a fixed column: a chronology whose timestamps do
                not line up is a list of times rather than a clock running down
                the page. */}
              <time
                dateTime={isoTime(entry.ts)}
                className="w-16 shrink-0 tnum text-label tracking-normal text-ink-soft"
              >
                {clockTime(entry.ts)}
              </time>
              {/* Wide enough for ACKNOWLEDGED, which is the longest tag and at
                11px wide-tracked measures 112px — a narrower column let it run
                straight into the line beside it with no gap at all. Fixed in
                both densities rather than hugging, because a chronology whose
                second column moves per row is three ragged columns. */}
              <SectionLabel as="span" tone={tag.tone} className="w-32 shrink-0">
                {tag.label}
              </SectionLabel>
              <span
                className={cn(
                  "min-w-[13rem] flex-1",
                  dense
                    ? "text-label tracking-normal text-ink-soft"
                    : "text-small text-ink",
                )}
              >
                {auditLine(entry, unitName, count)}
              </span>
            </li>
          </React.Fragment>
        );
      })}
    </ol>
  );
}

/**
 * Longer than this and the log stops being a sequence and starts being two
 * sittings.
 *
 * Five minutes, because the scripted incident's own beats are seconds apart —
 * raise, escalate, acknowledge, scan, verdict — so anything at this scale is
 * genuinely the console standing idle rather than the story continuing. A
 * shorter threshold would mark the pauses *inside* the incident, which is the
 * one place the reader can already see the times running.
 */
const GAP_MARKER_MS = 5 * 60_000;

/**
 * Nothing happened here, for a while.
 *
 * The user's session log ran RAISED 18:07 → ESCALATED 18:08 → DIAGNOSTIC 19:41
 * with the ninety-three minutes between the third and fourth line carried
 * entirely by two timestamps three columns apart. This is that subtraction,
 * done for them.
 *
 * Deliberately not shaped like an entry: no time column, no tag, centred rather
 * than aligned to the three columns beside it, and in the smallest quiet voice
 * the scale has. It is also the one row with no rule above or below it — the
 * space *is* the content, and a hairline on either side would file the pause as
 * another thing that happened.
 */
function ChronologyPause({ ms }: { ms: number }) {
  return (
    <li data-slot="audit-pause" className="py-3 text-center">
      {/* Not a SectionLabel: uppercase wide tracking turns "2h 05m" into
          "2 H 05 M", and this is a time rather than a heading. It takes the
          register of the clock column it is standing between instead. */}
      <span className="tnum text-label tracking-normal text-ink-soft">
        · {spanLabel(ms)} later
      </span>
    </li>
  );
}

/**
 * The store-wired slice. `selectUnitAuditLog` builds a fresh array on every
 * call, so it is wrapped in `useShallow` — without it this re-renders on every
 * commit any store makes.
 */
export interface UnitAuditLogProps {
  unitId: string;
  dense?: boolean;
  /** Rendered instead of an empty list. */
  empty?: React.ReactNode;
}

export function UnitAuditLog({ unitId, dense, empty = null }: UnitAuditLogProps) {
  const entries = useAuditStore(useShallow(selectUnitAuditLog(unitId)));
  const unit = useFleetStore(selectUnit(unitId));

  if (entries.length === 0) return <>{empty}</>;
  return <AuditChronology entries={entries} unitName={unit?.name} dense={dense} />;
}

/** Does this unit have a session log worth a section? */
export function useHasAuditLog(unitId: string): boolean {
  return useAuditStore((s) => s.entries.some((e) => e.unitId === unitId));
}

/**
 * The unit page's session log: everything the console recorded about this
 * robot since the operator opened it, collapsed by default.
 *
 * Collapsed, because it is evidence rather than news. The page above it already
 * says what is wrong (the banner), what was found (the incident history) and
 * when things happened (the status timeline); this is the thing an operator
 * opens when they are writing up a call or arguing with a record, and a section
 * that stands open with twelve lines of history would push all three of those
 * below the fold to answer a question nobody asked yet. The count sits in the
 * header so the closed state still tells the truth about what is inside.
 *
 * There is deliberately no fleet-wide version of this. A global log is a
 * different product — one with search, filters and retention — and half of it
 * shipped as a scrolling wall of every unit's events would be the console
 * displaying a problem instead of helping manage one, which is the exact
 * criticism this phase is answering.
 */
export function SessionLog({ unitId }: { unitId: string }) {
  const [open, setOpen] = React.useState(false);
  // Rows, not entries. The header is a promise about what is behind the
  // disclosure, and a log that says "8 entries" and opens on seven lines has
  // broken it — the collapsed row states its own count, so counting rows here
  // hides nothing and matches what the reader can actually tally.
  const entries = useAuditStore(useShallow(selectUnitAuditLog(unitId)));
  const count = React.useMemo(
    () => groupAuditEntries([...entries].reverse()).length,
    [entries],
  );
  const bodyId = React.useId();

  if (count === 0) return null;

  return (
    <ConsoleCard
      label="Session log"
      labelAs="h2"
      padding="none"
      action={
        <div className="flex items-center gap-3">
          <span className="text-label text-ink-soft uppercase">
            {count} {count === 1 ? "entry" : "entries"}
          </span>
          <ConsoleButton
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : "Show"}
          </ConsoleButton>
        </div>
      }
    >
      <Disclosure id={bodyId} open={open}>
        <div className="px-5 py-4">
          <UnitAuditLog
            unitId={unitId}
            empty={<RegionNote>Nothing recorded for this unit yet.</RegionNote>}
          />
        </div>
      </Disclosure>
    </ConsoleCard>
  );
}
