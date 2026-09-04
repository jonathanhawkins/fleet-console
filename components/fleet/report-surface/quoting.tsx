"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/console";

/**
 * A machine sentence, reproduced, under a line saying whose words they are.
 *
 * Both documents do this and it is the house rule they share most explicitly:
 * operator space *translates* the machine's voice everywhere else, and a report
 * *cites* — so the wire's own sentence appears verbatim, ruled off, with its
 * attribution beneath (the long note at the head of
 * incident-report-surface/surface.tsx makes the argument). It was written out
 * three times, identically, across two documents; a house style repeated by
 * hand is a house style waiting to drift, and this module exists to stop
 * exactly that.
 *
 * ## The machine keeps its typeface
 *
 * Everything else on this page is Geist, because everything else on this page
 * is the console talking. A quotation is not, and the cheapest true way to say
 * so is the one a document already has: set it in the other voice's face. The
 * mono is the machine's own (`--font-mono`, the same family the descent runs
 * in), on the page's warm white, in the page's ink — a transcript in daylight
 * rather than a screenshot of a terminal. No ground, no box, no phosphor: that
 * would be machine space leaking into a document that is not in it.
 *
 * The attribution goes the other way, into the document's own label register,
 * so the two lines cannot be confused for each other: small caps say "this is
 * the console telling you where that sentence came from".
 */
export function ReportQuote({
  caption,
  className,
  children,
}: {
  /** Who recorded it — never a paraphrase of what it says. */
  caption: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <figure className={cn("border-l-2 border-line pl-4", className)}>
      <div className="font-mono leading-[1.55] text-ink">{children}</div>
      <SectionLabel as="figcaption" className="mt-2.5">
        {caption}
      </SectionLabel>
    </figure>
  );
}

/**
 * Tabular evidence, set to a measure chosen for what is in it.
 *
 * A report has two kinds of table and they do not want the same width. A
 * *comparison* is two or three columns of very short values whose whole job is
 * to be read across — the canary's builds against their counts, the scan's
 * channels against their gains — and stretching one to the document measure put
 * a third of a page between a row's name and its own number, which is the one
 * thing a comparison must not do. A *ledger* is a row per subject with a real
 * span of columns (unit, firmware, raised, cleared, open for) and it earns the
 * full measure.
 *
 * Both keep a floor and a scroller under them: below the floor the columns stop
 * crushing and the table scrolls inside its own box rather than pushing the
 * document sideways. Paper has no scroller, so the clip comes off for print —
 * a sheet that silently cut a column off at its edge would be the one failure
 * a printed table cannot recover from.
 */
const TABLE_MEASURE = {
  compare: "min-w-[20rem] max-w-[32rem]",
  ledger: "min-w-[34rem]",
} as const;

export function ReportTable({
  measure,
  className,
  children,
}: {
  measure: keyof typeof TABLE_MEASURE;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("overflow-x-auto print:overflow-visible", className)}>
      <table className={cn("w-full border-collapse text-small", TABLE_MEASURE[measure])}>
        {children}
      </table>
    </div>
  );
}

/**
 * A table's column heading — the small-caps label, aligned with its column.
 *
 * `align` rather than a className at every call site: a heading over a numeric
 * column has to end where the numbers end, and getting that wrong is invisible
 * until a column of figures sits under a caption that points somewhere else.
 */
export function ReportTableHead({
  align = "left",
  className,
  children,
}: {
  align?: "left" | "right";
  /** The column gutter (`pr-4` on every column but the last). */
  className?: string;
  children: React.ReactNode;
}) {
  const right = align === "right";
  return (
    <th
      scope="col"
      className={cn("pb-2 font-normal", right ? "text-right" : "text-left", className)}
    >
      <SectionLabel as="span" className={right ? "justify-end" : undefined}>
        {children}
      </SectionLabel>
    </th>
  );
}
