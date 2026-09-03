"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { clockTime, formatDuration } from "./alert-lifecycle";
import {
  ConsoleButton,
  isoTime,
  SectionLabel,
  StatusChip,
  usePrefersReducedMotion,
} from "@/components/console";

/**
 * What a report *is*, apart from what any one report says.
 *
 * There are two of them now — the unit's write-up
 * (incident-report-surface.tsx) and the fleet's (cohort-report-surface.tsx) —
 * and the thing an operator recognises when the second one opens is not its
 * content, it is its shape: full width, one column of reading, a letterhead
 * with a reference on it, sections ruled and labelled the same way, and a
 * generated-at line at the bottom. That shape is a house style, and a house
 * style that lives in two files is a house style with a drift in it.
 *
 * So the chrome is extracted whole rather than approximated: the modal surface
 * and its focus discipline, the letterhead, the section rule, the row of
 * moments, the derived figure and the colophon. Everything a *particular*
 * report knows — which journals it joins, what it is allowed to conclude — stays
 * in that report's own file. This one holds nothing about incidents at all.
 *
 * ## It is not in the console barrel
 *
 * Both documents are `next/dynamic` boundaries behind a click (the PRD's 200 KB
 * budget is the reason, stated in each of their gates), and this module is
 * theirs: it imports framer-motion and a page of layout, and re-exporting it
 * from `index.ts` would invite an app-level import that put all of it back into
 * a route's initial payload.
 */

/* -------------------------------------------------------------------------
   the surface
   ------------------------------------------------------------------------- */

export interface ReportShellProps {
  /** Ids the letterhead's own `h1`; the surface is labelled by it. */
  titleId: string;
  onClose(): void;
  /** Distinguishes the two documents in the DOM and in tests. */
  scope: "unit" | "fleet";
  children: React.ReactNode;
}

/**
 * The document, as a modal surface over a locked page.
 *
 * `data-slot="incident-report"` is the print stylesheet's own hook (the
 * `[data-report="open"]` block in globals.css hides every sibling of it), so
 * both reports carry it — a fleet incident report is an incident report, and a
 * second selector for the second document would be one more thing to keep in
 * step with a rule nobody reads until a page prints wrong.
 */
export function ReportShell({ titleId, onClose, scope, children }: ReportShellProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  /* Escape and Close mean the same thing here — there is nothing to lose by
     leaving, the record is on file either way. */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Focus goes to the document and stays inside it, and returns to whatever
   * opened it — the incident id in the history, the linkage on a part card, or
   * the fleet incident's own reference. The same discipline as the descent
   * stage: a keyboard operator must not be able to tab into a page they cannot
   * see.
   */
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    root.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === root)
      ) {
        e.preventDefault();
        last.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, []);

  return (
    <motion.div
      ref={rootRef}
      data-slot="incident-report"
      data-scope={scope}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      // A document arriving, so: opacity only, no travel. The page it covers is
      // not going anywhere and a report that slid in would be claiming to be a
      // panel. One micro beat (PRD §5), collapsed to nothing under reduced
      // motion — where an instant swap is the correct reading of "no motion".
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduced ? 0 : 0.14, ease: "linear" }}
      className={cn(
        "fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-bg",
        "outline-none focus-visible:outline-none",
      )}
    >
      {/*
        A document measure, not a dashboard one.

        This started at 64rem — the width a console page is comfortable at — and
        it is the wrong unit of measure for the one surface in the product that
        is meant to leave the building. At 1024 px almost nothing here fills the
        line: a three-column comparison puts 350 px of white between a build and
        its own count, the rollback's per-unit offsets float half a page from the
        unit they belong to, and the differential runs past 110 characters, which
        is a paragraph an eye loses its place in.

        52rem is close to the measure this document already has on paper (A4 less
        the 16 mm margins is ~42rem), so the screen version is now recognisably
        the same object as the printed one instead of a stretched relative of it.
      */}
      <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12">
        {children}
      </div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------
   letterhead
   ------------------------------------------------------------------------- */

export interface ReportLetterheadProps {
  titleId: string;
  /** "Incident report" · "Fleet incident report". */
  title: string;
  /** The reference an operator could read down a phone. */
  reference: string;
  /** Who or what the document is about, one line. */
  subject: React.ReactNode;
  resolved: boolean;
  /**
   * The two words for the chip. A unit incident resolves; a fleet one is
   * *restored*, and printing "Resolved" over four rolled-back robots would be
   * the document reaching for the nearest word rather than the true one.
   */
  statusCopy?: { open: string; resolved: string };
  /** The highest rung anything on this incident reached, or null. */
  tier: string | null;
  onClose(): void;
}

export function ReportLetterhead({
  titleId,
  title,
  reference,
  subject,
  resolved,
  statusCopy = { open: "Open", resolved: "Resolved" },
  tier,
  onClose,
}: ReportLetterheadProps) {
  return (
    // `mb-4` on top of the shell's own gap: the rule under a masthead has to
    // belong to the masthead. At the shell's uniform spacing it sat almost
    // exactly halfway between the subject line above it and the first section
    // label below — a hairline owned by neither, reading as a second section
    // divider stacked under the first. More air below than above settles it,
    // which is the arrangement the colophon at the other end already has.
    <header className="mb-4 flex flex-col gap-4 border-b border-line pb-6">
      <div className="flex items-start justify-between gap-6">
        {/* The wordmark, set as type rather than as the ProductMark component:
            that one is a link to the fleet page, and a letterhead that
            navigates out of the document it heads is a trapdoor. */}
        <span className="text-small tracking-label uppercase">
          <span className="font-medium text-ink">Fleet</span>{" "}
          <span className="text-ink-soft">Console</span>
        </span>
        {/* Hidden on paper: a printed page with a Close button on it is a
            screenshot, not a document.

            An icon, not a labelled capsule. This is a letterhead — the eye
            should land on the title and the reference, and a filled pill in
            the top corner competes with them for the only thing the masthead
            is for. There is exactly one control on this surface, Escape does
            the same job, and the words move to the accessible name, which is
            where they are load-bearing rather than decorative. `data-icon-only`
            buys the second axis of the 44px touch target (app/styles/base.css);
            a glyph has no label to be wide with. */}
        <ConsoleButton
          variant="ghost"
          size="sm"
          data-icon-only
          aria-label="Close incident report"
          onClick={onClose}
          className="w-8 shrink-0 px-0 print:hidden"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
          </svg>
        </ConsoleButton>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="flex flex-col gap-1">
          <h1 id={titleId} className="text-title text-ink">
            {title}
          </h1>
          <p className="tnum text-small text-ink-soft">{reference}</p>
          <p className="text-small text-ink">{subject}</p>
        </div>

        <div className="flex flex-col items-start gap-2 sm:items-end">
          <StatusChip status={resolved ? "nominal" : "warn"} tone="quiet">
            {resolved ? statusCopy.resolved : statusCopy.open}
          </StatusChip>
          {tier ? (
            <p className="text-small text-ink-soft">
              Escalated to: <span className="text-ink">{tier}</span>
            </p>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------
   sections, moments and figures
   ------------------------------------------------------------------------- */

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
 * cell. It is four lines of markup and it is exactly the kind of thing
 * this file exists to hold in one place — a house style repeated by hand is a
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
          <dd className="tnum relative border-t border-line pt-2 pr-6 text-small text-ink-soft">
            {ts === undefined ? (
              <NotRecorded />
            ) : (
              <>
                <span
                  aria-hidden
                  className="absolute top-0 left-0 h-1.5 border-l border-line"
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

/* -------------------------------------------------------------------------
   quotation and tabulation
   ------------------------------------------------------------------------- */

/**
 * A machine sentence, reproduced, under a line saying whose words they are.
 *
 * Both documents do this and it is the house rule they share most explicitly:
 * operator space *translates* the machine's voice everywhere else, and a report
 * *cites* — so the wire's own sentence appears verbatim, ruled off, with its
 * attribution beneath (the long note at the head of incident-report-surface.tsx
 * makes the argument). It was written out three times, identically, in two
 * files; a house style repeated by hand is a house style waiting to drift, and
 * this file exists to stop exactly that.
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

/* -------------------------------------------------------------------------
   colophon
   ------------------------------------------------------------------------- */

/**
 * What this is and when it was made — the line a printed copy is filed under,
 * and the PRD's standing disclosure (§6) on the one surface in the product that
 * leaves the building.
 */
export function ReportFooter({ generatedAt }: { generatedAt: number }) {
  return (
    <footer className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-line pt-5 text-label tracking-normal text-ink-soft">
      <span>Simulated data · generated by Fleet Console</span>
      <time dateTime={isoTime(generatedAt)} className="tnum">
        Generated {clockTime(generatedAt)}
      </time>
    </footer>
  );
}

/**
 * Stamped once, at open. A generated-at line driven by the shared ticker would
 * advance while the reader is on the page, which is the one thing a document's
 * own timestamp must not do.
 */
export function useGeneratedAt(): number {
  const [generatedAt] = React.useState(() => Date.now());
  return generatedAt;
}
