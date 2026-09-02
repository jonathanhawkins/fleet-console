"use client";

import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { type UnitStatus } from "@/lib/schema";
import { selectUnitAuditLog, useAuditStore } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { clockTime } from "./alert-lifecycle";
import { formatRecency, useNow } from "./relative-time";
import {
  deriveSessionEvents,
  offsetLabel,
  packEvents,
  sessionMeasures,
  type PlacedEvent,
  type SessionEvent,
  type SessionMeasure,
} from "./session-events";
import {
  getUnitStatusHistory,
  statusHistoryVersion,
  subscribeStatusHistory,
  type StatusMark,
  type StatusSpan,
} from "./status-history";
import { unitStatusChip, unitStatusCopy } from "./unit-status";

/**
 * The session, as a band and the beats on it.
 *
 * Two languages, deliberately, and the split is the whole design: the band
 * carries **state** — how long this unit was fine, when that stopped, how long
 * the trouble lasted — and the ticks carry **moments** — the escalation, the
 * diagnostic somebody ran, the verdict it returned, a link that dropped. A
 * band alone (which is what this was) answers the first question and leaves an
 * operator to guess at the second; ticks alone would throw away duration, which
 * is the thing a timeline is uniquely good at.
 *
 * Still an audit strip, not a chart: there is no axis and no hover readout, and
 * the two captions under it — when the session started, and "now" — are the
 * only scale it offers. "By how much" is the joint grid's question, and the
 * grid answers it properly now.
 *
 * Low-frequency by nature, so it is DOM rather than canvas: it moves when a
 * status changes (a handful of times in the whole scripted incident) and once a
 * second as the right edge advances to keep up with now.
 */

/**
 * Status as ground, events as marks — two languages, deliberately.
 *
 * A tick coloured by severity would be invisible on the segment its own alert
 * created, and would put a second severity scale on a strip that already has
 * one. So the band carries state and the ticks carry moments, in ink.
 *
 * Nominal sits at a third strength: most of this band is nominal most of the
 * time, and a fleet-wide sheet of saturated sage would drown the exception
 * exactly the way eight NOMINAL chips would in the rail.
 */
const SPAN_CLASS: Record<UnitStatus, string> = {
  nominal: "bg-nominal/30",
  amber: "bg-warn/55",
  red: "bg-alert/70",
};

/** Below this, a segment is drawn at a floor width so it cannot vanish. */
const MIN_SPAN_PCT = 0.6;

/** Band height (h-2), the tick's overhang above it, and one row of labels. */
const BAND_H = 8;
const TICK_OVERHANG = 3;
/**
 * A lane is two lines now: the beat, and the clock under it.
 *
 * 11px type on the token's 1.4 leading is 15.4px a line, so a box is 31px and
 * the lane stride leaves three pixels of air beneath it. The card is that much
 * taller for it, which is the honest price of a timeline that answers "when":
 * the strip could always say *that* something happened and never *at what
 * time*, and an operator writing up a call needs the second one.
 *
 * The clock goes under the word rather than beside it because the constraint is
 * horizontal. Inline — "Verdict · 19:41:40" — is a 106px box; stacked it is
 * 48px, and a 390px track carrying seven beats has room for the second shape
 * and not the first.
 */
const LANE_H = 34;
/** Top of the first label row — clear of the band and its overhanging ticks. */
const LABEL_TOP = BAND_H + 6;

/** The measures row: the bracket, its end caps, and the word beneath. */
const MEASURE_TOP_GAP = 6;
const MEASURE_CAP_H = 4;
const MEASURE_H = MEASURE_CAP_H + 16;

/**
 * Narrower than this and a bracket is drawn but cannot be read — "1h 33m" in
 * wide-tracked small caps is about 48px, so under this the label overhangs both
 * of its own end caps and claims time that belongs to its neighbours.
 */
const MIN_MEASURE_PX = 56;

function describe(
  spans: StatusSpan[],
  marks: StatusMark[],
  events: SessionEvent[],
  measures: SessionMeasure[],
  start: number,
  end: number,
): string {
  const parts = spans.map((span) => {
    const seconds = Math.max(1, Math.round(((span.to ?? end) - span.from) / 1000));
    const unit =
      seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
    return `${unitStatusCopy(span.status).toLowerCase()} for ${unit}`;
  });
  const alerts =
    marks.length === 0
      ? "No alerts raised."
      : `${marks.length} alert${marks.length === 1 ? "" : "s"} raised.`;
  const sentence = parts.join(", then ");
  // Every tick, spoken in the order they are drawn — the sighted reader gets
  // the beats from the labels, and this is the same list. The clock is what the
  // label now prints under the word, so it is what gets read out; the offset
  // from the session's zero follows it, because a strip is read in offsets.
  const beats = events
    .map(
      (event) =>
        `${event.label} at ${clockTime(event.ts)}, ${offsetLabel(event.ts, start)}`,
    )
    .join(", ");
  // The brackets are information, not ornament: without this the one fact the
  // sighted reader gets from them — how long the unit waited — is the one fact
  // a screen reader would have to reconstruct from seven timestamps.
  const spans_ =
    measures.length === 0
      ? ""
      : ` Measured: ${measures.map((m) => m.spoken).join(", ")}.`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. ${alerts} Session events: ${beats}.${spans_}`;
}

export interface StatusTimelineProps extends Omit<
  React.ComponentPropsWithoutRef<"div">,
  "children"
> {
  unitId: string;
}

export function StatusTimeline({ className, unitId, ...props }: StatusTimelineProps) {
  // Subscribed for the side effect only: the history lives outside React and
  // the version counter is what tells this component it moved.
  React.useSyncExternalStore(subscribeStatusHistory, statusHistoryVersion, () => 0);
  const now = useNow();
  const history = getUnitStatusHistory(unitId);
  // The action beats. `useShallow` because the selector filters — a fresh array
  // every commit that is contents-equal must not re-render an audit strip. The
  // log is append-only and moves a handful of times in a whole session, which
  // is why this one *is* allowed to be a subscription rather than a ref.
  const audit = useAuditStore(useShallow(selectUnitAuditLog(unitId)));

  /**
   * Label placement is a packing problem and packing needs pixels. Measured
   * once and on resize — never per render — and the timeline draws its ticks
   * without labels until the first measurement lands, which is one frame.
   *
   * A ref *callback* rather than a mount effect, and that is not a style
   * choice. This component's first render is the waiting state, which returns
   * before the track exists; a `useEffect(…, [])` would run against a null ref,
   * never re-run, and leave the packer working with a zero-width track forever —
   * every label clamped to x=0, every one but the first dropped for collision.
   * The callback fires when the element actually arrives, and React 19 calls
   * the cleanup it returns when the element goes away.
   */
  const [trackWidth, setTrackWidth] = React.useState(0);
  const trackRef = React.useCallback((el: HTMLDivElement | null) => {
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined)
        setTrackWidth((w) => (Math.abs(w - width) < 1 ? w : width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // now === 0 is the server render and the first client paint: a relative
  // timeline is not renderable before the clock starts, and guessing would
  // hydrate a mismatch.
  //
  // The waiting state is the same three boxes as the settled one — band, gap,
  // caption row — so the first status span fills a strip that is already drawn
  // instead of replacing a sentence and growing this card by 14px. That growth
  // was the whole of what remained of this route's CLS once the page stopped
  // swapping itself out wholesale; the caption sits at label size
  // here because that is the size of the row it is standing in for.
  if (!history || now === 0 || history.spans.length === 0) {
    return (
      <div
        data-slot="status-timeline"
        data-pending=""
        className={cn("flex flex-col gap-2.5", className)}
        {...props}
      >
        <div
          aria-hidden
          className="h-2 w-full rounded-pill bg-surface-2"
          // The label row this timeline will have, reserved before it has one.
          // Waiting is the page, not a screen instead of it: the
          // settled strip always carries at least "Session start" under the
          // band, so the waiting one has to stand at that height or the first
          // snapshot grows this card and pushes the footer — which is exactly
          // the 0.06 CLS that fix was measured against.
          style={{ marginBottom: LABEL_TOP + LANE_H }}
        />
        <p className="text-label tracking-normal text-ink-soft">
          The session timeline starts as soon as the unit reports in.
        </p>
      </div>
    );
  }

  const start = history.startedAt;
  const marks = history.marks.filter((mark) => mark.ts >= start);
  // A one-second floor: for the first tick of a fresh session the span is a
  // few milliseconds wide and every percentage below would divide by ~nothing.
  const total = Math.max(1000, now - start);
  const pct = (t: number) => ((t - start) / total) * 100;

  const events = deriveSessionEvents(history, audit);
  const placed = packEvents(events, trackWidth, start, start + total);
  const lanesUsed = placed.reduce((max, e) => Math.max(max, e.lane + 1), 0);
  // Measured off the events, positioned off the same percentage scale the ticks
  // use — so a bracket can never end anywhere but on the mark it names. Narrow
  // ones are dropped here rather than clipped: see MIN_MEASURE_PX.
  const measures = sessionMeasures(events).filter(
    (m) => ((m.to.ts - m.from.ts) / total) * trackWidth >= MIN_MEASURE_PX,
  );
  const labelsH = Math.max(1, lanesUsed) * LANE_H;
  const measuresH = measures.length > 0 ? MEASURE_TOP_GAP + MEASURE_H : 0;

  return (
    <div
      data-slot="status-timeline"
      className={cn("flex flex-col gap-2.5", className)}
      {...props}
    >
      <div
        ref={trackRef}
        className="relative"
        // One lane's worth is always reserved, matched by the waiting state
        // above; a second appears only when an incident crowds the labels, and
        // the measures row only when there is a span long enough to name.
        style={{ paddingBottom: LABEL_TOP + labelsH + measuresH }}
      >
        <div className="h-2 w-full overflow-hidden rounded-pill bg-surface-2">
          {history.spans.map((span) => (
            <span
              key={`${span.status}-${span.from}`}
              data-status={unitStatusChip(span.status)}
              className={cn("absolute top-0 h-2", SPAN_CLASS[span.status])}
              style={{
                left: `${Math.max(0, pct(span.from))}%`,
                width: `${Math.max(MIN_SPAN_PCT, pct(span.to ?? now) - pct(span.from))}%`,
              }}
            />
          ))}
        </div>

        {/* Outside the clipped band so a tick can overhang both edges and run
            on down to the word that names it. Everything here is aria-hidden:
            the spoken version is one sentence below, in order, which is a far
            better reading of a timeline than a heap of positioned fragments a
            screen reader would announce in whatever order they are laid out. */}
        {placed.map((event) => (
          <EventTick key={event.id} event={event} start={start} />
        ))}

        {/* Under everything, on their own row: the measures answer a question
            the marks cannot, and putting them among the labels would make them
            compete with the beats they are measuring between. */}
        {measures.map((measure) => (
          <MeasureBracket
            key={measure.id}
            measure={measure}
            pct={pct}
            top={LABEL_TOP + labelsH + MEASURE_TOP_GAP}
          />
        ))}
      </div>

      {/* The band is decoration until it is described; this is the description. */}
      <p className="sr-only">
        {describe(history.spans, marks, events, measures, start, now)}
      </p>

      {/* Sentence case and normal tracking — these are times, not labels. */}
      <div
        aria-hidden
        className="flex items-baseline justify-between tnum text-label tracking-normal text-ink-soft"
      >
        <span>Session started {formatRecency(start, now)}</span>
        <span>now</span>
      </div>
    </div>
  );
}

/**
 * One moment: a hairline through the band, carried down to its word.
 *
 * The descender is what makes the pairing unambiguous once labels start
 * staggering — a word two rows below a crowded band belongs to whichever tick
 * reaches it, and clamping a label away from its own tick (which the packer
 * does at both edges) would otherwise leave the reader guessing. A tick whose
 * label did not fit stops at the band and keeps its meaning in the spoken
 * description.
 *
 * It is also withheld where it would cross another beat's word on the way down
 * (`descends`, session-events.ts): a hairline through 11px type reads as a
 * strike-through, and the clock now printed under every label disambiguates the
 * pairing better than a leader line was doing.
 */
function EventTick({ event, start }: { event: PlacedEvent; start: number }) {
  const labelled = event.lane >= 0;
  const height =
    labelled && event.descends
      ? BAND_H + TICK_OVERHANG + 3 + event.lane * LANE_H
      : BAND_H + TICK_OVERHANG;

  return (
    <>
      <span
        aria-hidden
        data-slot="timeline-tick"
        data-kind={event.kind}
        className="absolute w-px bg-ink/60"
        style={{
          top: -TICK_OVERHANG,
          height,
          left: `${event.pct}%`,
        }}
      />
      {labelled ? (
        <span
          aria-hidden
          data-slot="timeline-label"
          title={`${event.label} · ${offsetLabel(event.ts, start)}`}
          className="absolute flex flex-col whitespace-nowrap"
          style={{ left: event.labelX, top: LABEL_TOP + event.lane * LANE_H }}
        >
          {/* Ink, against the soft captions below: two rows of 11px type this
              close together would otherwise read as one paragraph, and they are
              not the same kind of thing. These are the beats — content. The row
              under them ("Session started 1m ago … now") is the axis, and the
              console spends ink-soft on frames and ink on content everywhere
              else. */}
          <span className="text-label tracking-normal text-ink">{event.label}</span>
          {/* The clock, one step quieter than the word it belongs to.
              Same size, because it is the other half of the same label and a
              smaller size would make it a footnote; softer, because the word is
              what is scanned and the time is what is read once the eye has
              stopped. Tabular, so seven of these down a crowded band line up
              instead of shimmering against each other. */}
          <span className="tnum text-label tracking-normal text-ink-soft">
            {clockTime(event.ts)}
          </span>
        </span>
      ) : null}
    </>
  );
}

/**
 * A span, measured — the dimension line off an engineering drawing.
 *
 * Drawn as a rule with two end caps rising *toward* the beats it spans, so it
 * reads as measuring the distance between two marks rather than as a third
 * status band under the first. It is the quietest object on the strip: hairline
 * rules in `--line-strong` and a muted small-caps word, because the whole point
 * is that it answers a question the operator has *when they look for it* and
 * stays out of the way of the beats until then.
 *
 * Positioned in percentages off the same scale as the ticks, so the caps land
 * on the marks exactly and stay on them through a resize without a second
 * measurement pass.
 */
function MeasureBracket({
  measure,
  pct,
  top,
}: {
  measure: SessionMeasure;
  pct: (t: number) => number;
  top: number;
}) {
  const left = pct(measure.from.ts);
  const width = pct(measure.to.ts) - left;

  return (
    <div
      aria-hidden
      data-slot="timeline-measure"
      data-measure={measure.id}
      className="absolute flex flex-col items-center"
      style={{ left: `${left}%`, width: `${width}%`, top }}
    >
      <div
        className="w-full border-x border-b border-line-strong"
        style={{ height: MEASURE_CAP_H }}
      />
      {/* Not a SectionLabel, and the exception is worth stating: every other
          quiet label in this console is uppercase and wide-tracked, and a
          duration put through that treatment reads "1 M" — the unit suffix
          becomes a separate word. So it takes the register of the clocks it is
          measuring between instead, which is also the more honest family: this
          is a time, not a heading. */}
      <span className="tnum text-label tracking-normal whitespace-nowrap text-ink-soft">
        {measure.label}
      </span>
    </div>
  );
}
