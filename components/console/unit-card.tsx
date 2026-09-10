import * as React from "react";
import Link from "next/link";
import { type Posture, type UnitStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { PostureTag, postureLabel } from "./posture-tag";
import { StatusChip } from "./status-chip";
import { trendDetail, trendSpeech, type UnitTrend } from "./trend-watch";
import { unitStatusChip, unitStatusCopy } from "./unit-status";

/**
 * One home in the fleet, as a row.
 *
 * Pure: it takes a unit and renders it. The store subscription lives one level
 * up in the rail, per row, so that this component stays usable anywhere — a
 * search result, a related-units list on /unit/[id] — and stays testable
 * without a store.
 *
 * Two lines, in the order an operator triages: who and how they are, then the
 * two facts that qualify the answer. The chip is the only saturated thing in
 * the row and it sits on the baseline of the first line, so a column of eight
 * rows resolves to a column of eight status marks you can read without reading.
 */

/** Fixed, and exported: the rail's virtualizer measures rows from this. */
export const UNIT_CARD_HEIGHT = 72;

/**
 * The one exception, and it is a *size* rather than a squeeze.
 *
 * A trending row has a third line to print, and 72px cannot hold three without
 * dropping the row's internal padding from 13.1px to 2.4px — which is not a
 * denser row, it is a broken one. Growing the box by exactly one line plus the
 * gap that carries it keeps the padding identical to every other row in the
 * rail, so the trending row reads as a row with more to say rather than as a
 * row that has been crushed. Typically 0 or 1 rows in the fleet are this tall.
 *
 * That gap is 8px rather than the row's usual 6, which is where the two odd
 * pixels come from. The third line is derived from the second and the two are
 * the same small type, so on the row's own gap they read as one two-line
 * paragraph instead of a statement and the conclusion drawn from it. Matching
 * the first gap's *number* would not match its space — the line above it
 * carries the chip, whose taller box lends that gap leading this one does not
 * have. Two more px seats the line; four would separate it, and the row would
 * start reading as two blocks stacked rather than as one row.
 *
 * Kept in step with the `h-[96px]` below by hand, the same way UNIT_CARD_HEIGHT
 * has always been kept in step with `h-[72px]`: the virtualizer needs the
 * number in JS and the row needs it in a class, and a CSS variable in between
 * would put a layout-critical measurement somewhere neither can typecheck.
 */
export const UNIT_CARD_TRENDING_HEIGHT = 96;

export interface UnitCardProps extends Omit<
  React.ComponentPropsWithoutRef<"a">,
  "href" | "children"
> {
  unitId: string;
  name: string;
  status: UnitStatus;
  /** Percent, 0–100. Rendered to whole numbers — a rail is not a gauge. */
  battery: number;
  /** "just now" · "42s ago". Omitted when there is nothing truthful to say. */
  recency?: string | null;
  /** Gross body posture. Only "sitting" prints anything — see PostureTag. */
  posture?: Posture;
  /**
   * The build this unit is running, printed in the second line — and passed
   * ONLY while the unit is part of a live firmware cohort (fleet-rail.tsx).
   *
   * Firmware is a standing fact about every robot, which is exactly the argument
   * against showing it here all the time: eight rows carrying a version string
   * nobody is currently asking about is eight rows of permanent clutter in the
   * one region whose job is to be scannable. It becomes worth a column the
   * moment the version is the *reason* a set of rows belong together, and it
   * leaves again when the cohort resolves. The unit's own page carries it
   * always (unit-identity.tsx) — that is where a standing fact belongs.
   */
  fw?: string | null;
  /** Member of a live firmware cohort: marks the row, see the CSS note. */
  cohort?: boolean;
  /**
   * The thermal trend watch's entry for this unit, when it has one — a joint
   * whose temperature is climbing on a unit that is still nominal.
   *
   * A third line rather than a fourth item on the second, because at the rail's
   * design width (20rem, so 280px of content) the second line's three facts
   * plus "Trending · left knee +18 °C/min" measure 281px: it fits on paper and
   * clips in practice, and the first thing to go would be the rate. A forecast
   * that has to truncate its number is not a forecast.
   *
   * Never set for a unit that is alerting — the store stands the watch down the
   * moment a unit stops being nominal, so this line and an ATTENTION chip can
   * never appear on the same row arguing about severity.
   */
  trend?: UnitTrend | null;
  /** Where the row navigates. Defaults to the unit's drill-in route. */
  href?: string;
}

export function UnitCard({
  className,
  unitId,
  name,
  status,
  battery,
  recency,
  posture,
  fw,
  cohort,
  trend,
  href,
  ...props
}: UnitCardProps) {
  const chip = unitStatusChip(status);

  return (
    <Link
      href={href ?? `/unit/${unitId}`}
      data-slot="unit-card"
      data-unit={unitId}
      data-status={chip}
      // The cohort mark is an attribute, not a class: it is a *grouping*, and
      // the rule that draws it lives beside the status colours in globals.css
      // where the decision not to spend a new hue on it is documented.
      data-cohort={cohort || undefined}
      // Deliberately NOT a `data-status` value: the row already carries its
      // status in design-system terms, and a fourth token there would make
      // "trending" rankable against nominal/warn/alert. It is a separate,
      // quieter fact about a row that is still nominal.
      data-trending={trend ? trend.joint : undefined}
      // The row's accessible name is assembled here rather than left to the
      // reading order, so a screen reader gets one sentence instead of five
      // fragments — and, because an aria-label *replaces* the content, it has
      // to carry everything the row shows, recency included.
      aria-label={[
        `${unitId}, ${name}.`,
        `${unitStatusCopy(status)}.`,
        postureLabel(posture) ? `${postureLabel(posture)}.` : null,
        // "%" rather than "percent": the visible row says "93%", and an
        // accessible name that replaces the content has to contain it or voice
        // control cannot address the row. Every current screen reader speaks
        // "%" as "percent", so nothing is lost by matching the glyph.
        `Battery ${Math.round(battery)}%.`,
        recency ? `Last contact ${recency}.` : null,
        fw ? `Firmware ${fw}.` : null,
        // Last, matching the reading order: the watch is the row's third line
        // and its most qualified statement, not its headline.
        trend ? trendSpeech(trend) : null,
      ]
        .filter(Boolean)
        .join(" ")}
      className={cn(
        "flex flex-col justify-center gap-1.5 border-b border-line px-5",
        // See UNIT_CARD_TRENDING_HEIGHT: one line and its gap taller, so the
        // third line arrives without spending the row's breathing room.
        trend ? "h-[96px]" : "h-[72px]",
        "transition-colors duration-[var(--dur-micro)] ease-console",
        "hover:bg-surface-2",
        // The cohort mark: a 3px rule inside the leading edge, in the neutral
        // grouping token (globals.css, --cohort-mark). Inset rather than a
        // border so the row's geometry — and the 72px the virtualizer measures
        // from — is identical marked and not.
        "[&[data-cohort]]:shadow-[inset_3px_0_0_var(--cohort-mark)]",
        // The global focus ring is drawn 2px *outside* its box; on a full-bleed
        // row inside a scroll container that lands under the clip. Pulling it
        // inside keeps the same treatment visible where it has to be.
        "focus-visible:bg-surface-2 focus-visible:[outline-offset:-2px]",
        className,
      )}
      {...props}
    >
      <span className="flex items-center gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 tnum text-small font-medium text-ink">{unitId}</span>
          <span className="truncate text-small text-ink-soft">{name}</span>
        </span>
        {/* The row's trailing cluster: what is wrong, and — only when there is
            something to say — how the unit is holding itself. Posture sits to
            the *left* of status because status is the column an operator scans
            down a rail of eight rows without reading, and it stays in the same
            place whether or not a unit is sitting. */}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <PostureTag posture={posture} />
          {/* Bare when nothing is wrong, tinted when something is. A rail of
              eight homes is almost always eight nominals, and eight sage pills
              would drown the one clay one — see the tone note on StatusChip. */}
          <StatusChip status={chip} tone={status === "nominal" ? "bare" : "auto"}>
            {unitStatusCopy(status)}
          </StatusChip>
        </span>
      </span>

      {/* Sentence case and normal tracking: this line is two measurements, and
          the wide-tracked caps used everywhere else in this app would make
          "just now" read as a label rather than as a time. */}
      <span className="flex items-center gap-2 tnum text-label tracking-normal text-ink-soft">
        <span>{Math.round(battery)}%</span>
        {recency ? (
          <>
            <span aria-hidden className="text-ink-muted">
              ·
            </span>
            <span>{recency}</span>
          </>
        ) : null}
        {fw ? (
          <>
            <span aria-hidden className="text-ink-muted">
              ·
            </span>
            {/* Last on the line, not first: the two measurements are what the
                row has always answered, and the build is context for why this
                row is marked — a qualifier, not a new headline. */}
            <span>{fw}</span>
          </>
        ) : null}
      </span>

      {/* The watch. Below the measurements because it is derived from
          them — the row states what it read, then what that reading implies.
          `mt-0.5` on top of the row's gap says exactly that: 2px is not a
          division, it is the beat before a conclusion (UNIT_CARD_TRENDING_HEIGHT).

          One warm word and nothing else: `--warn-ink` on the page ground, no
          tint, no border, no pill. The ATTENTION chip one line up is the same
          hue wearing a filled shape, which is exactly the step this has to sit
          under — an operator scanning the rail finds the chips first and this
          second, which is the order the severities actually run in. */}
      {trend ? (
        <span className="mt-0.5 flex items-center gap-1.5 text-label text-warn-ink">
          <span className="shrink-0 uppercase">Trending</span>
          <span aria-hidden className="shrink-0 text-ink-muted">
            ·
          </span>
          {/* Sentence case, normal tracking, soft ink: the same voice as the
              measurements line above, because this half IS a measurement. Only
              the word "Trending" is a label, and only it is coloured. */}
          <span className="min-w-0 truncate tnum tracking-normal text-ink-soft">
            {trendDetail(trend)}
          </span>
        </span>
      ) : null}
    </Link>
  );
}
