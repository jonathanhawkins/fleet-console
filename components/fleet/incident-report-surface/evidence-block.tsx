"use client";

import { tracePoints } from "@/components/machine/evidence-trace";
import { channelTone, gainRatio, rmsDelta } from "@/components/machine/waveform-math";
import { type DiagChannel, type IncidentRecord } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { jointLabel, SectionLabel } from "@/components/console";
import { ReportQuote, ReportSection } from "../report-surface";

/**
 * The mirrored joint — a left knee's control is the right one.
 *
 * The same rule the verdict card applies (`pairJoint`), written out here rather
 * than imported: that module is machine space, it reaches back through the
 * console barrel for its own imports, and pulling it in to read four lines of
 * naming convention would drag the card, its confirmation dialog and its motion
 * into this chunk. It is joint *vocabulary*, not diagnosis — and if it is ever
 * wrong the report simply shows no control trace.
 */
function mirroredJoint(joint: string): string | null {
  if (joint.endsWith("_L")) return `${joint.slice(0, -2)}_R`;
  if (joint.endsWith("_R")) return `${joint.slice(0, -2)}_L`;
  return null;
}

/**
 * What the scan wrote, and what it wrote it about.
 *
 * The machine's own sentence heads this section rather than the verdict's,
 * and the move is editorial rather than cosmetic. The recorded summary opens by
 * naming the fault and closes with the reading — set under a headline that has
 * just named the same fault in English, its first half is an echo and its
 * second half is stranded. Set over the traces, both halves land: the first
 * says which channel the exhibit is, the second states the figure the picture
 * is of. Nothing is edited to achieve that; a quotation an operator might argue
 * with in a dispute is reproduced whole or not at all.
 */
export function EvidenceBlock({
  summary,
  channels,
  subject,
  calibration,
}: {
  /** The scan's recorded sentence, verbatim. */
  summary: string;
  channels: readonly DiagChannel[];
  subject: string;
  calibration: IncidentRecord["calibration"];
}) {
  const exhibit = channels.find((c) => c.joint === subject);
  const pair = mirroredJoint(subject);
  const control = pair ? channels.find((c) => c.joint === pair) : undefined;
  // A re-measure of some other joint is not evidence about this exhibit.
  const post = calibration?.joint === subject ? calibration.wave : undefined;

  return (
    <ReportSection label="Evidence">
      <ReportQuote caption="Recorded by the diagnostic scan">
        <blockquote className="text-small">{summary}</blockquote>
      </ReportQuote>

      {exhibit ? (
        <>
          {/* Still two figures with a recalibration on file, not three: the
              before/after belongs INSIDE the subject frame, because the claim
              being made is that this channel came down, and a third box beside
              it would make that a comparison the reader has to perform. */}
          <div className="mt-5 flex flex-col gap-4 sm:flex-row">
            <ReportTrace channel={exhibit} role="Subject" subject post={post} />
            {control ? <ReportTrace channel={control} role="Control" /> : null}
          </div>
          <p className="mt-3 text-label tracking-normal text-ink-soft">
            Live trace against the joint&rsquo;s calibration reference, 120 samples.
            {post ? " Subject shows the trace before and after recalibration." : ""}
          </p>
        </>
      ) : null}
    </ReportSection>
  );
}

const VIEW = { w: 240, h: 64 };

/**
 * One channel, frozen — the machine card's exhibit, redrawn in daylight.
 *
 * The geometry is `tracePoints`, imported from the card's own trace so the two
 * pictures are the same picture; only the palette changes, because a phosphor
 * trace on black in the middle of a warm-white document would read as a
 * screenshot of a different product pasted into a report. Ink for the live
 * trace, muted for the reference it is being judged against, and clay only when
 * the channel is genuinely out of envelope — the one place this document spends
 * a colour.
 *
 * SVG, like the card, and for the card's reason: it is a still of samples that
 * stopped arriving, it has to scale with the page, and — the reason that
 * matters most here — a canvas does not print.
 */
function ReportTrace({
  channel,
  role,
  subject = false,
  post,
}: {
  channel: DiagChannel;
  role: string;
  subject?: boolean;
  /** The same channel re-measured after a recalibration, when one was run. */
  post?: readonly number[];
}) {
  const delta = rmsDelta(channel.wave, channel.ref);
  const gain = gainRatio(channel.wave, channel.ref);
  const postDelta = post ? rmsDelta(post, channel.ref) : null;
  const postGain = post ? gainRatio(post, channel.ref) : null;
  // Which reading the figure is *about*: with a re-measure on file the current
  // state of the joint is the later one, so that is what decides whether this
  // document spends its one colour here. A frame still tinted for a breach the
  // channel has come out of would be the report arguing against its own trace.
  const breach = channelTone(postDelta ?? delta) === "alert";

  return (
    <figure
      data-evidence={channel.joint}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-2 rounded-lg border p-4",
        subject ? "border-alert/40 bg-alert-tint/40" : "border-line bg-surface",
      )}
    >
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-small text-ink">{jointLabel(channel.joint)}</span>
        <SectionLabel as="span" tone={subject ? "alert" : "muted"}>
          {role}
        </SectionLabel>
      </figcaption>

      <svg
        viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
        preserveAspectRatio="none"
        className="block h-16 w-full"
        role="img"
        aria-label={
          postGain === null
            ? `${jointLabel(channel.joint)} live trace against reference, ${gain.toFixed(2)} times amplitude`
            : `${jointLabel(channel.joint)} live trace against reference, ${gain.toFixed(2)} times amplitude before recalibration, ${postGain.toFixed(2)} times after`
        }
      >
        <line
          x1="0"
          y1={VIEW.h / 2}
          x2={VIEW.w}
          y2={VIEW.h / 2}
          stroke="var(--line)"
          strokeWidth="1"
        />
        <polyline
          data-role="reference"
          points={tracePoints(channel.ref)}
          fill="none"
          stroke="var(--ink-soft)"
          strokeOpacity="0.45"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          data-role={post ? "pre" : "live"}
          points={tracePoints(channel.wave)}
          fill="none"
          stroke={post ? "var(--alert)" : breach ? "var(--alert)" : "var(--ink)"}
          strokeOpacity={post ? "0.3" : "1"}
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
        />
        {post ? (
          <polyline
            data-role="live"
            points={tracePoints(post)}
            fill="none"
            stroke={breach ? "var(--alert)" : "var(--ink)"}
            strokeWidth="1.25"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>

      <div className="flex items-baseline justify-between gap-3 text-label tracking-normal text-ink-soft">
        <span className="tnum">
          RMS Δ {delta.toFixed(3)}
          {postDelta === null ? null : ` → ${postDelta.toFixed(3)}`}
        </span>
        <span className={cn("tnum", breach ? "text-alert-ink" : undefined)}>
          {postGain === null
            ? `${gain.toFixed(2)}× reference`
            : `${gain.toFixed(2)}× → ${postGain.toFixed(2)}× reference`}
        </span>
      </div>
    </figure>
  );
}
