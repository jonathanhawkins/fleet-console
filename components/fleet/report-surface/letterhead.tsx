"use client";

import { ConsoleButton, StatusChip } from "@/components/console";

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
  /**
   * The day the times below belong to, and the zone they were read in.
   *
   * Every stamp in this document is a wall clock — `10:33:53` — which is the
   * right unit for a chronology and no use at all on its own: a service report
   * whose times belong to no particular day cannot be filed, compared, or
   * argued with. The date is stated once, here, and the whole document hangs
   * off it.
   */
  dateline: string;
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
  dateline,
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
          <p className="text-small text-ink-soft">{dateline}</p>
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
