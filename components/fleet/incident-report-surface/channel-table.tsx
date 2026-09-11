"use client";

import { residualReading } from "@/lib/diagnostics/recalibrate-copy";
import {
  channelTone,
  gainRatio,
  rmsDelta,
  type ChannelTone,
} from "@/lib/diagnostics/waveform-math";
import { type VerdictReport } from "@/lib/schema";
import { type DiagChannel } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { jointLabel, SectionLabel } from "@/components/console";
import { ReportTable, ReportTableHead } from "../report-surface";

const TONE_CLASS: Record<ChannelTone, string> = {
  nominal: "text-ink",
  warn: "text-warn-ink",
  alert: "text-alert-ink",
};

/**
 * Every channel the scan returned, measured exactly as the verdict card
 * measured them.
 *
 * `rmsDelta` and `gainRatio` are imported from the machine's own module rather
 * than reimplemented in operator tones, which is the whole point: the report
 * and the card must not be able to disagree about a number, and the thresholds
 * behind the colouring are the ones the simulator's test suite is written
 * against (waveform-math.ts).
 *
 * ## Where the colour goes, and where it does not
 *
 * The subject row is the one an eye has to find, and it is found by weight and
 * by a label in the document's own small-caps register — not by a red word.
 * Clay is spent once on this page, on the *readings*, because the reading is
 * what is out of envelope; a red tag beside a joint's name says "this row
 * errored", which is a different and untrue claim. A caption closes the table,
 * so a figure set to a comparison's measure reads as a deliberate object at
 * that measure rather than as a full-width table that failed to fill.
 */
export function ChannelTable({
  channels,
  subject,
}: {
  channels: readonly DiagChannel[];
  subject: string;
}) {
  if (channels.length === 0) {
    return (
      <p className="mt-4 text-small text-ink-soft">
        Channel measurements are not on file for this incident.
      </p>
    );
  }

  return (
    <ReportTable measure="compare" className="mt-5">
      <caption className="caption-bottom pt-3 text-left text-label tracking-normal text-ink-soft">
        {countWord(channels.length).replace(/^./, (c) => c.toUpperCase())} channels
        captured by the scan, each against its own calibration reference.
      </caption>
      <thead>
        <tr className="border-y border-line text-left">
          <ReportTableHead className="pr-4">Joint</ReportTableHead>
          <ReportTableHead align="right" className="pr-4">
            RMS Δ
          </ReportTableHead>
          <ReportTableHead align="right">Gain vs reference</ReportTableHead>
        </tr>
      </thead>
      <tbody>
        {channels.map((channel) => {
          const delta = rmsDelta(channel.wave, channel.ref);
          const gain = gainRatio(channel.wave, channel.ref);
          const tone = channelTone(delta);
          const flagged = channel.joint === subject;
          return (
            <tr
              key={channel.joint}
              data-channel={channel.joint}
              data-subject={flagged ? "" : undefined}
              className="border-b border-line"
            >
              <th
                scope="row"
                className={cn(
                  "py-2 pr-4 text-left font-normal text-ink",
                  flagged && "font-medium",
                )}
              >
                {jointLabel(channel.joint)}
                {flagged ? (
                  <SectionLabel as="span" className="ml-2.5">
                    Subject
                  </SectionLabel>
                ) : null}
              </th>
              <td className={cn("py-2 pr-4 text-right tnum", TONE_CLASS[tone])}>
                {delta.toFixed(3)}
              </td>
              <td className={cn("py-2 text-right tnum", TONE_CLASS[tone])}>
                {gain.toFixed(2)}×
              </td>
            </tr>
          );
        })}
      </tbody>
    </ReportTable>
  );
}

/** "five" — counts read as words in a sentence, digits in a table. */
const COUNT_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? `${n}`;
}

/**
 * The one sentence that states what was actually measured.
 *
 * Derived from the channels rather than written down, so it cannot drift from
 * the table directly above it: the reading is the subject channel's, and the
 * count is every other channel that came in under the healthy threshold.
 *
 * The reading is taken in the units the fault is in (`residualReading`), and
 * that is not decoration. An offset states as an amplitude ratio would read
 * "gain 1.14× reference envelope" — a true number, in the wrong measure,
 * describing a channel whose amplitude is not what is wrong with it. The
 * sentence names its own measure so the reader knows which one they were given.
 */
export function confirmedSignal(
  report: VerdictReport,
  channels: readonly DiagChannel[] | undefined,
): string {
  const list = channels ?? [];
  const subject = list.find((c) => c.joint === report.joint);
  const within = list.filter(
    (c) => c.joint !== report.joint && channelTone(rmsDelta(c.wave, c.ref)) === "nominal",
  ).length;
  if (!subject) {
    return `${report.anomaly.charAt(0).toUpperCase()}${report.anomaly.slice(1)} anomaly on ${jointLabel(report.joint).toLowerCase()}; channel measurements are not on file.`;
  }
  const joints = `${countWord(within)} joint${within === 1 ? "" : "s"} within tolerance`;
  const reading = residualReading(report.anomaly, subject.wave, subject.ref);
  return report.anomaly === "offset"
    ? `Trace displaced ${reading.operator}, envelope intact, ${joints}.`
    : `Gain ${reading.operator} envelope, ${joints}.`;
}
