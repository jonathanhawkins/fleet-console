"use client";

import * as React from "react";
import { ProgressRule } from "@/components/console";
import { scanProgress, type ScanStage } from "@/lib/diagnostics/scan-progress";
import { type DiagSession } from "@/lib/stores";

/**
 * What the scan is doing, and how much of it has actually happened.
 *
 * The bar is counted, never timed. Twenty-six things arrive over the length of
 * a scan — twenty subsystem nodes and six measured channels — and the fill is
 * how many of them have. That is the difference between an instrument and a
 * loading animation: a link that drops stops this bar, because nothing is
 * arriving, which is the truth and is what the operator needs to see. A
 * duration-based bar would keep filling over a dead socket and reach 100% with
 * nothing measured.
 */

const STAGE_LINE: Record<ScanStage, string> = {
  starting: "Starting diagnostic",
  subsystems: "Walking subsystems",
  channels: "Measuring channels against reference",
  complete: "Scan complete",
};

export interface ProgressHeadProps {
  session: DiagSession | null;
  /** No events have arrived for a while and the link is not open. */
  stalled?: boolean;
}

export function ProgressHead({ session, stalled = false }: ProgressHeadProps) {
  const labelId = React.useId();
  const progress = scanProgress(session);
  const done = progress.stage === "complete";

  /**
   * Announced on coarse beats only.
   *
   * A live region that spoke every walked node would read twenty paths aloud
   * during a fifteen-second scan and bury the two sentences that matter. So
   * the region carries the stage, which changes three times, and the verdict
   * says itself when it arrives.
   */
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4">
        {/* The visible line *is* the live region. A separate sr-only copy would
            put the same sentence in the accessibility tree twice. */}
        <p id={labelId} aria-live="polite" className="text-small text-ink">
          {stalled && !done
            ? "Waiting for the unit to report"
            : STAGE_LINE[progress.stage]}
        </p>
        <p className="tnum text-small text-ink-soft">
          {done ? "26 of 26" : `${progress.completed} of ${progress.total}`}
        </p>
      </div>
      <ProgressRule
        value={progress.fraction}
        now={progress.completed}
        max={progress.total}
        labelledBy={labelId}
        stalled={stalled && !done}
      />
    </div>
  );
}
