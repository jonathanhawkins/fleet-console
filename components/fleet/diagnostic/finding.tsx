"use client";

import { SectionLabel, jointLabel } from "@/components/console";
import { componentHeadline } from "@/lib/diagnostics/part-label";
import { type VerdictReport } from "@/lib/schema";
import { type DiagChannel } from "@/lib/stores";
import { confirmedSignal } from "../incident-report-surface/channel-table";

/**
 * What the scan concluded, in the console's own voice.
 *
 * Three registers, in the order a reader needs them. The **headline** names the
 * part, because "left knee actuator A-07" is the answer to the question the
 * operator came with. The **measured sentence** is derived from the channels
 * rather than written down — `confirmedSignal` is the same function the filed
 * report uses, so the screen and the paper cannot disagree about what was
 * measured. The **quoted summary** is the machine's own string, set in mono and
 * marked as a quotation, because it is the one sentence here this console did
 * not write.
 *
 * That last distinction is worth the mono. Everything else on this card is the
 * console interpreting; the quote is the robot talking. Blurring the two would
 * let an operator attribute our phrasing to the machine.
 */

export interface FindingProps {
  report: VerdictReport;
  channels: readonly DiagChannel[];
}

export function Finding({ report, channels }: FindingProps) {
  const part = componentHeadline(report.component);
  const clean = report.anomaly === "none";

  return (
    <div className="mt-5 flex flex-col gap-3 border-t border-line pt-5">
      <SectionLabel as="p">Finding</SectionLabel>

      <h3 className="text-body font-medium text-ink">
        {clean
          ? "No fault found"
          : `${jointLabel(report.joint)} · ${part} — ${report.anomaly} anomaly`}
      </h3>

      <p className="max-w-[62ch] text-small text-ink-soft">
        {confirmedSignal(report, channels)}
      </p>

      <blockquote className="border-l-2 border-line-strong pl-3 font-mono text-small text-ink-soft">
        {report.summary}
      </blockquote>
    </div>
  );
}
