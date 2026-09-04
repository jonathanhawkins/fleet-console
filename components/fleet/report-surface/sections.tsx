"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { isoTime, SectionLabel } from "@/components/console";
import { clockTime, formatDuration } from "../alert-lifecycle";

export function ReportSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    // `break-inside-avoid` so a section is not split across two sheets when
    // there is room to move it whole — the chronologies are allowed to break,
    // because they are lists and a list that must fit on one page is a list
    // with a length limit.
    <section className="flex flex-col gap-3 print:break-inside-avoid">
      <SectionLabel as="h2" rule>
        {label}
      </SectionLabel>
      <div>{children}</div>
    </section>
  );
}

/**
 * The gap where a journal is silent — a dash to read and a phrase to hear.
 *
 * Both documents print these, and by the third copy the pattern had already
 * drifted: the fleet report's affected-units table rendered the dash on its own,
 * so a screen reader heard two "Not recorded"s across the row and then an empty
 * cell. It is four lines of markup and it is exactly the kind of thing this
 * module exists to hold in one place — a house style repeated by hand is a
 * house style waiting to drift.
 *
 * The dash is `aria-hidden` because an em-dash is punctuation to a reader and
 * noise to a listener; the sentence beside it is what the listener gets.
 */
export function NotRecorded() {
  return (
    <>
      <span aria-hidden>—</span>
      <span className="sr-only">Not recorded</span>
    </>
  );
}

export interface ReportMoment {
  /** Read back off `[data-moment]`; stable, unlike the label. */
  key: string;
  label: string;
  /** Undefined means no journal recorded it — printed as a dash, never guessed. */
  ts?: number;
}

/**
 * The clock a report runs on: every moment it can honestly date, in the order
 * the incident is told rather than the order the fields are stored in.
 *
 * ## It is drawn as a rail, not as a band of columns
 *
 * Six labelled times side by side are a *sequence*, and set as six equal
 * columns they read as six unrelated fields — the eye has nothing to travel
 * along and no way to tell the order was meant. So each cell rules its own top
 * edge and drops a tick under the label: the cells butt (the column gutter is
 * padding inside them, never a grid gap), the rules meet, and what an operator
 * sees is one ruled line with the incident's beats stood on it.
 *
 * Three across, at most. Six columns of 11px wide-tracked capitals cannot hold
 * "Acknowledged" or "Rollback ordered" on one line at this measure, and a rail
 * whose labels wrap at different heights is a rail with a kink in it. Three
 * rows the sequence 3 + 3, which is also how both documents' beats actually
 * group — the alert's life, then the response's.
 *
 * The rules and ticks are borders rather than filled boxes because this
 * document prints, and a browser drops background colour on paper by default.
 *
 * A moment no journal recorded gets no tick: the rail runs on past a beat that
 * did not happen, which is the honest picture and costs no extra ink.
 */
export function ReportMoments({ moments }: { moments: readonly ReportMoment[] }) {
  return (
    <dl className="grid grid-cols-2 gap-y-6 sm:grid-cols-3">
      {moments.map(({ key, label, ts }) => (
        <div
          key={key}
          data-moment={key}
          data-recorded={ts === undefined ? undefined : ""}
          className="flex min-w-0 flex-col"
        >
          {/* Two label lines' worth, always, bottom-aligned. Below the widest
              breakpoint the longest caption takes two lines and its neighbour
              takes one; without a floor under both, their rules — and so the
              rail itself — sit at two different heights. */}
          <dt className="flex min-h-[31px] items-end pr-6 pb-2">
            <SectionLabel as="span">{label}</SectionLabel>
          </dt>
          <dd className="relative border-t border-line pt-2 pr-6 tnum text-small text-ink-soft">
            {ts === undefined ? (
              <NotRecorded />
            ) : (
              <>
                <span
                  data-tick
                  aria-hidden
                  className="absolute top-0 left-0 h-2 border-l border-line-strong"
                />
                <time dateTime={isoTime(ts)} className="text-ink">
                  {clockTime(ts)}
                </time>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One derived span, printed as a figure.
 *
 * The acronym is a hint rather than the label: an operator who knows MTTA finds
 * it, and one who does not reads a plain English phrase instead of a code.
 *
 * `value` covers the figures that are not durations — a fleet report counts
 * units as well as measuring seconds — and it takes the same treatment, so a
 * band of four figures stays one band rather than two kinds of number.
 */
export function ReportFigure({
  label,
  hint,
  ms,
  value,
}: {
  label: string;
  hint?: string;
  ms?: number;
  value?: string;
}) {
  const printed = value ?? (ms === undefined ? undefined : formatDuration(ms));
  return (
    <div data-figure={label} className="flex flex-col gap-0.5">
      {/* Two label lines' worth, always, bottom-aligned — the row of moments'
          own floor, and here for the same reason it is there. A band of four
          figures wraps to two columns on a phone, where "Time to order
          rollback" takes two lines and its neighbour takes one; without the
          floor the two numbers beside each other sit on different baselines,
          which reads as a layout that has come apart rather than as a pair of
          figures. Caught at 390 px on the fleet report; the unit report's own
          band was one long label away from the same fault. */}
      <span className="flex min-h-[31px] items-end">
        <SectionLabel as="span">{label}</SectionLabel>
      </span>
      <span
        className={cn(
          "tnum text-heading",
          printed === undefined ? "text-ink-muted" : "text-ink",
        )}
      >
        {printed ?? "—"}
      </span>
      {/* The hint's line is held whether or not this figure has one. A band is
          four figures read across, and hinting two of them left the row with a
          ragged underside — the hinted pair looked footnoted and the bare pair
          looked unfinished. Reserving the line costs one label's height and
          gives the band a flat bottom edge; it is the same argument as the
          floor under the caption above, at the other end of the figure. */}
      <span
        className="min-h-[15px] text-label tracking-normal text-ink-soft"
        aria-hidden={hint ? undefined : true}
      >
        {hint}
      </span>
    </div>
  );
}
