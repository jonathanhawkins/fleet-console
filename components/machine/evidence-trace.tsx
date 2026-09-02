"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { machineJoint } from "./scan-copy";
import { channelTone, gainRatio, rmsDelta, type ChannelTone } from "./waveform-math";

/**
 * A channel, frozen — the evidence on the verdict card.
 *
 * SVG rather than canvas, and the exception proves the rule. Every *live*
 * instrument in this product is canvas on the shared rAF loop, because it
 * redraws sixty times a second and DOM nodes at that rate are the thing the
 * whole architecture is arranged to avoid. This one never redraws: it is a
 * still of 120 samples that stopped arriving before the card existed. Paying
 * for a canvas context, a ResizeObserver and a frame subscription to draw a
 * picture once would be spending the expensive mechanism on the one case it
 * was not built for — and the SVG has two properties canvas cannot match here:
 * it scales with the card without a resize pass, and its geometry is in the
 * DOM where a test can assert it.
 *
 * The card shows two of these side by side, the failing joint and its healthy
 * pair. That is not decoration either: asymmetry between a left and a right is
 * how anyone actually reads a walking machine, and one trace alone only proves
 * that a line is wobbly.
 *
 * ## The re-measure
 *
 * When a recalibration has run, the subject figure holds two live traces
 * instead of one: what the joint was doing, and what it is doing now. The
 * *same* figure, not a third one beside it — the argument the operator has to
 * be able to make is "it came down from there", and two exhibits in different
 * frames make that a comparison the reader has to perform rather than one the
 * evidence performs for them.
 *
 * The old trace stays, dimmed, in the tone it was flagged at. Replacing it
 * would leave a card claiming "1.35× reference" with nothing on screen saying
 * what that is better than, which is a number doing no work at all.
 */

const TONE_STROKE: Record<ChannelTone, string> = {
  nominal: "var(--ink)",
  warn: "var(--warn)",
  alert: "var(--alert)",
};

/** The same three slots as text, for the reading under the trace. */
const TONE_TEXT: Record<ChannelTone, string> = {
  nominal: "text-nominal",
  warn: "text-warn",
  alert: "text-alert",
};

/**
 * …and as a frame. The subject's border is the exhibit's own claim about the
 * channel inside it, so once the channel has been measured again the frame has
 * to follow the measurement: a red box around a trace that is back inside its
 * envelope is the loudest wrong thing on the card.
 */
const TONE_BORDER: Record<ChannelTone, string> = {
  nominal: "border-nominal/60",
  warn: "border-warn/60",
  alert: "border-alert/60",
};

const VIEW = { w: 240, h: 64 };
const PAD = 4;

/** Sample array → SVG polyline points, in the thumbnail's own coordinates. */
export function tracePoints(series: readonly number[]): string {
  if (series.length < 2) return "";
  const amp = VIEW.h / 2 - PAD;
  const step = VIEW.w / (series.length - 1);
  let out = "";
  for (let i = 0; i < series.length; i += 1) {
    const x = (i * step).toFixed(1);
    const y = (VIEW.h / 2 - (series[i] ?? 0) * amp).toFixed(1);
    out += `${i === 0 ? "" : " "}${x},${y}`;
  }
  return out;
}

export interface EvidenceTraceProps {
  joint: string;
  wave: readonly number[];
  ref: readonly number[];
  /** Marks this as the exhibit rather than the control. */
  subject?: boolean;
  /**
   * The same channel measured again after a recalibration. When present it
   * becomes the live trace and `wave` becomes the ghost behind it, and every
   * figure in the readout reads as a transition rather than a value.
   */
  post?: readonly number[];
  className?: string;
}

export function EvidenceTrace({
  joint,
  wave,
  ref,
  subject = false,
  post,
  className,
}: EvidenceTraceProps) {
  const delta = rmsDelta(wave, ref);
  const gain = gainRatio(wave, ref);
  const tone = channelTone(delta);
  // Measured here, by the same functions that measured the original, so the
  // two numbers under one figure cannot come from two different definitions of
  // "how far off is this". Nothing on the wire carries a residual for exactly
  // this reason (lib/schema/messages.ts, the `recalibration` variant).
  const postDelta = post ? rmsDelta(post, ref) : null;
  const postGain = post ? gainRatio(post, ref) : null;
  const postTone = postDelta === null ? null : channelTone(postDelta);
  /**
   * What this figure currently claims about its channel.
   *
   * The subject frames and labels itself in alert because the subject is what
   * is wrong — until it is measured again, at which point the exhibit's own
   * tone is the tone of the newest measurement, exactly as the trace inside it
   * already was. A figure whose frame and caption disagree with the line they
   * are drawn around is a figure arguing with its own evidence.
   */
  const claim: ChannelTone | null = postTone ?? (subject ? "alert" : null);

  return (
    <figure
      data-evidence={joint}
      data-tone={claim ?? "control"}
      className={cn(
        "flex min-w-0 flex-col gap-1 border p-2",
        claim ? TONE_BORDER[claim] : "border-line",
        className,
      )}
    >
      <figcaption className="flex items-baseline justify-between gap-3 text-label uppercase">
        <span className={claim ? TONE_TEXT[claim] : "text-ink-soft"}>
          {machineJoint(joint)}
        </span>
        {/* Two traces in one frame need a key, and this is it: the two words
            printed in the two lines' own tones, in the order the lines were
            measured in. It replaced the single word "RECALIBRATED", which named
            the event but left the reader to work out which of the two lines was
            the result of it — on the one figure whose entire argument is *this
            came down from that*. BEFORE is dimmed to the same 35% the ghost
            trace is drawn at, so the key and the drawing are the same object
            twice. */}
        {post && postTone ? (
          <span className="flex items-baseline gap-1 tnum">
            <span className={cn(TONE_TEXT[tone], "opacity-40")}>Before</span>
            <span aria-hidden className="text-ink-muted">
              ·
            </span>
            <span className={TONE_TEXT[postTone]}>After</span>
          </span>
        ) : (
          <span className="tnum text-ink-muted">{subject ? "Subject" : "Control"}</span>
        )}
      </figcaption>

      <svg
        viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
        preserveAspectRatio="none"
        className="block h-14 w-full"
        role="img"
        aria-label={
          postGain === null
            ? `${machineJoint(joint)} live trace against reference, ${gain.toFixed(2)} times amplitude`
            : `${machineJoint(joint)} live trace against reference, ${gain.toFixed(2)} times amplitude before recalibration, ${postGain.toFixed(2)} times after`
        }
      >
        {/* Centre datum, the same hairline the live strips draw. */}
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
          points={tracePoints(ref)}
          fill="none"
          stroke="var(--ink-soft)"
          strokeOpacity="0.5"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {/* The pre-calibration trace keeps `data-role="live"` when it is the
            only one, and becomes the ghost when it is not — so a test (and an
            eye) can always ask for "the trace that is true now" by one name. */}
        <polyline
          data-role={post ? "pre" : "live"}
          points={tracePoints(wave)}
          fill="none"
          stroke={TONE_STROKE[tone]}
          strokeOpacity={post ? "0.35" : "1"}
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
        />
        {post && postTone ? (
          <polyline
            data-role="live"
            points={tracePoints(post)}
            fill="none"
            stroke={TONE_STROKE[postTone]}
            strokeWidth="1.25"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>

      {/* Two rows rather than two arrows on one.
          `0.189 → 0.091` and `1.76× → 1.39× REF` both wrapped mid-figure at
          this width, which breaks a number across a line — the one thing a
          readout of numbers must not do. Stacked, the current reading takes the
          primary row and the prior one sits under it dim, which is the same
          hierarchy the traces above already draw: the live line bright, what it
          came down from behind it. Both readings move together or neither does.
          A footer showing the new gain beside the old RMS would be two
          measurements of two different moments sitting on one line. */}
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-3 text-label uppercase">
          <span className="tnum text-ink-muted">
            Rms Δ {(postDelta ?? delta).toFixed(3)}
          </span>
          {/* The subject's reading is alert-toned because the subject is what
              is wrong — until it is measured again. Then the colour follows the
              measurement, exactly as the trace above it does: a re-measure that
              came back inside the envelope printed in red would be the figure
              disagreeing with the line it is a caption for. */}
          <span className={cn("tnum", claim ? TONE_TEXT[claim] : "text-ink-soft")}>
            {(postGain ?? gain).toFixed(2)}× ref
          </span>
        </div>
        {postDelta === null || postGain === null ? null : (
          <div className="flex items-baseline justify-between gap-3 text-label text-ink-muted uppercase">
            <span className="tnum">Was {delta.toFixed(3)}</span>
            <span className="tnum">Was {gain.toFixed(2)}×</span>
          </div>
        )}
      </div>
    </figure>
  );
}
