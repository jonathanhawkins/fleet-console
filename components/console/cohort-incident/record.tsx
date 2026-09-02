"use client";

import * as React from "react";
import { type CohortResolution } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { clockTime, formatDuration } from "../alert-lifecycle";
import { cohortRecordLine } from "../cohort-copy";
import { isoTime } from "../relative-time";
import { SectionLabel } from "../section-label";
import { CohortReportGate, ReportReference } from "./report-gate";

export interface CohortRecordProps {
  record: CohortResolution;
  /**
   * The record arrived under a press in this session, so the keyboard was in
   * the card that just unmounted. A prop rather than focus-on-mount: this also
   * mounts on a plain page load, which must not grab the keyboard.
   */
  claimFocus: boolean;
}

/**
 * What a closed incident leaves on the page: one quiet line holding the
 * reference. It is the only thing that still knows the incident's subject
 * once the derivation has forgotten the group, so the reference is the door
 * to the report.
 */
export function CohortRecord({ record, claimFocus }: CohortRecordProps) {
  const [reportOpen, setReportOpen] = React.useState(false);
  const referenceRef = React.useRef<HTMLButtonElement>(null);
  const claimed = React.useRef(false);
  const { cohort } = record;

  React.useEffect(() => {
    if (!claimFocus || claimed.current) return;
    claimed.current = true;
    // preventScroll: the card above is still collapsing.
    referenceRef.current?.focus({ preventScroll: true });
  }, [claimFocus]);

  const openFor =
    record.closedAt === undefined
      ? null
      : formatDuration(record.closedAt - cohort.detectedAt);

  return (
    <section
      data-slot="cohort-record"
      data-fw={cohort.fw}
      aria-label="Closed fleet incident"
      className={cn(
        "flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2",
        "rounded-xl border border-line bg-surface px-5 py-3.5 sm:px-6",
      )}
    >
      {/* Announced: the operator pressed a control and its region left the page. */}
      <p aria-live="polite" className="text-small text-ink">
        {cohortRecordLine(cohort.unitIds.length, cohort.fw)}
      </p>
      {/* Every figure is labelled. Closed (the fleet's, from the journals) and
          Filed (the operator's press) are two moments; the span is measured to
          the closure, and the pair appears only where a journal dated one. */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <ReportReference
          ref={referenceRef}
          cohort={cohort}
          onOpen={() => setReportOpen(true)}
        />
        {openFor === null || record.closedAt === undefined ? null : (
          <>
            <span className="flex items-baseline gap-2">
              <SectionLabel as="span">Open for</SectionLabel>
              <span className="tnum text-label tracking-normal text-ink-soft">
                {openFor}
              </span>
            </span>
            <span className="flex items-baseline gap-2">
              <SectionLabel as="span">Closed</SectionLabel>
              <time
                dateTime={isoTime(record.closedAt)}
                className="tnum text-label tracking-normal text-ink-soft"
              >
                {clockTime(record.closedAt)}
              </time>
            </span>
          </>
        )}
        <span className="flex items-baseline gap-2">
          <SectionLabel as="span">Filed</SectionLabel>
          <time
            dateTime={isoTime(record.at)}
            className="tnum text-label tracking-normal text-ink-soft"
          >
            {clockTime(record.at)}
          </time>
        </span>
      </div>

      <CohortReportGate
        cohort={cohort}
        archive={record.archive}
        open={reportOpen}
        onClose={() => setReportOpen(false)}
      />
    </section>
  );
}
