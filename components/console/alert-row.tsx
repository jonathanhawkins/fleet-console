"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  clockTime,
  durationSince,
  isLive,
  resolutionVia,
  type AlertView,
} from "./alert-lifecycle";
import { ConsoleButton } from "./console-button";
import { Disclosure } from "./disclosure";
import { formatRecency, isoTime } from "./relative-time";
import { SectionLabel } from "./section-label";
import { StatusChip, type StatusChipStatus } from "./status-chip";
import { alertSeverityChip, alertSeverityCopy } from "./unit-status";

/**
 * One alert, and everything the operator can do about it without leaving the
 * feed.
 *
 * Before this the row was a single link and nothing else: it displayed a
 * problem and offered exactly one response, which was to go and look at it:
 * an interface that shows a fault but does not help anyone *manage* one. So the row now carries the four facts a
 * shift handover needs (when it started, how long it has been running, who has
 * it, what closed it) and the one action that changes any of them.
 *
 * ## It is still a link, and the disclosure is a separate control
 *
 * The obvious reading of "click the row to expand it" would cost the golden
 * path its two-click route to the failing unit — feed row → unit page is how an
 * operator gets from "something is wrong" to the instruments, and it is the
 * move this feed was built around. So the row keeps its link and expansion gets
 * its own affordance at the trailing edge. Nesting a button inside an anchor is
 * not an option (it is invalid, and every assistive technology disagrees about
 * what it means), which is why the controls sit outside the link rather than
 * inside the row's one big hit area.
 *
 * ## Acknowledge is one click and there is no undo
 *
 * No confirm dialog: acking is not destructive, it is a claim of ownership, and
 * a modal asking "are you sure you want to take responsibility" would be the
 * console making a decision heavier than it is. There is also no un-ack, which
 * is the deliberate half. The ack is written to an append-only audit log the
 * moment it happens; removing it from the row would leave the log saying an
 * operator took the alert at 14:31:58 and the feed saying nobody ever did. If
 * the wrong person acked, who and when is the useful artefact. Forgiveness here
 * is the record, not an eraser.
 */

/**
 * Controls that stay out of the way until the operator is on the row — and
 * never on a device that has no hover to reveal them with. The base state is
 * visible, and only a pointer that can hover opts into hiding it; a phone or an
 * iPad therefore shows the actions on every row, permanently, which is the only
 * way they exist at all there.
 *
 * Opacity rather than display, so the row's geometry is identical hovered and
 * not: controls that push the message aside as the cursor arrives make a feed
 * jitter under a moving mouse. The hidden button stays focusable on purpose —
 * a keyboard operator tabs to it and `group-focus-within` brings it up.
 */
const QUIET_ACTION = cn(
  "transition-opacity duration-[var(--dur-micro)] ease-console",
  "[@media(hover:hover)]:opacity-0",
  "group-hover/row:opacity-100 group-focus-within/row:opacity-100",
);

/**
 * The ground under a row that is no longer the live question.
 *
 * Sixty percent of the hover tint, and the fraction is the whole point: the
 * feed's card is already greige, so a settled row cannot recede by going
 * lighter — there is nothing lighter than the page in operator space — and a
 * full `--surface-2` would make a settled row look exactly like a hovered one.
 * A half-step down reads as a band that has closed over, and still leaves the
 * hover state somewhere to go. Checked at AA: `--ink-soft` on the deepest form
 * of this ground is 6.0:1, and the bare chip's `--warn-ink` is 5.0:1.
 */
const RECEDED = "bg-surface-2/60 hover:bg-surface-2";

/**
 * The first-visit mark: a 3px rule inside the row's leading edge, in the
 * severity's own colour (first-visit-nudge.ts decides who gets it).
 *
 * **Why the edge and not the ground.** The row's ground is fully spoken for —
 * two steps of recession at rest, `--surface-2` on hover, the same on
 * focus-visible. A resting ground for the marked row would either land on
 * `--surface-2` (so the one row that matters looks permanently hovered, and
 * loses its own hover feedback) or introduce a fourth tint the operator has to
 * rank against the two recession steps. The leading edge was free, and the app
 * already uses exactly that edge to say "this row is part of something"
 * (unit-card.tsx draws `--cohort-mark` there, same 3px inset shadow). This is
 * the same sentence in the severity's voice, and it costs the row no geometry:
 * an inset shadow, so a marked row and an unmarked one measure identically.
 *
 * **Why not a severity-tinted ground either.** `--warn-tint` under a
 * `--warn-tint` chip erases the chip — the failure cohort-incident.tsx names in
 * its own words. The chip is how this row states severity; the mark may not
 * spend it.
 *
 * Full saturation rather than the `-ink` variants: this is a 3px rule, not
 * 11px type, so it has no contrast bar to clear and every reason to be the most
 * findable pixel in a greige feed. It cannot collide with the cohort mark —
 * the nudge suppresses itself entirely while a fleet incident is on the page.
 *
 * **Motion, inherited rather than declared.** The unlayered press contract in
 * globals.css names `[data-slot="alert-row"]` and already transitions
 * `box-shadow` (it is there so a press can move transform and colour together),
 * so the mark arrives and — when the operator gets back from the unit — leaves
 * on a 140 ms `--dur-micro`/`ease-console` crossfade. In the 120–180 ms band,
 * paint only, no layout, and clamped to 0s by the stylesheet's global
 * reduced-motion rule without this file knowing about it. Nothing new to
 * respect: presence, not motion.
 */
const NUDGE_MARK: Record<StatusChipStatus, string> = {
  nominal: "shadow-[inset_3px_0_0_var(--nominal)]",
  warn: "shadow-[inset_3px_0_0_var(--warn)]",
  alert: "shadow-[inset_3px_0_0_var(--alert)]",
};

export interface AlertRowProps extends Omit<
  React.ComponentPropsWithoutRef<"div">,
  "children" | "onToggle"
> {
  view: AlertView;
  /**
   * Epoch ms from the feed's shared 1 s ticker — one clock for the whole list
   * (relative-time.ts), never a timer per row. 0 before the client clock
   * starts, which is the signal to print no elapsed time at all.
   */
  now: number;
  /** Undefined on a row with nothing left to acknowledge. */
  onAcknowledge?: (alertId: string) => void;
  expanded: boolean;
  onToggle: (alertId: string) => void;
  /**
   * The suspect firmware, when this row is one of the alerts a fleet incident
   * is built from (alert-rail.tsx supplies it).
   *
   * The row STAYS — individually, in place, in time order. The feed is the
   * audit trail and four alerts folded into a summary row would be four facts
   * the console decided the operator did not need to see. What the tag does is
   * name the thing they belong to, in the incident card's own words ("Cohort ·
   * 2.4.1", printed identically at the top of the page), so the operator can
   * cross the gap between "four rows arrived at once" and "these are one
   * incident" without the feed having to rearrange itself to say so.
   *
   * It is not a link, and that is a structural fact rather than a decision: the
   * record line lives inside the row's anchor, and an anchor inside an anchor is
   * invalid HTML that assistive technology disagrees about. The shared
   * vocabulary is the pointer.
   */
  cohortFw?: string;
  /**
   * This is the row to start with: the newest live alert about a unit the
   * operator has not opened yet (first-visit-nudge.ts owns the judgement; the
   * feed supplies it, and at most one row in the feed ever has it).
   *
   * Deliberately silent in the accessibility tree. The mark carries no fact the
   * row does not already say in words — severity, unit, message and elapsed
   * time are all there — it only says *look here first*, and a screen reader
   * already gets that from the row being at the top of a newest-first list.
   * Announcing it would be the console repeating itself in the one place where
   * repetition costs the most.
   */
  nudge?: boolean;
  /** The related-events panel; mounted lazily by the Disclosure. */
  detail?: React.ReactNode;
}

export function AlertRow({
  className,
  view,
  now,
  onAcknowledge,
  expanded,
  onToggle,
  cohortFw,
  nudge,
  detail,
  ...props
}: AlertRowProps) {
  const { alert, meta, lifecycle, escalated, escalatedFrom } = view;
  const chip = alertSeverityChip(alert.severity);
  const detailId = `alert-detail-${alert.id}`;

  const resolved = lifecycle === "resolved";
  // Two steps of recession, not one. An amber a red has taken over and an
  // alert someone has claimed are both "not the live question" and share a
  // ground; a resolved alert is finished, and gives up its unit id's weight as
  // well. Neither step reaches for opacity or --muted: everything on this row
  // still has to clear AA, so receding is done with ground and type weight
  // rather than by fading text toward the page.
  //
  // `!isLive` rather than a second spelling of it: the first-visit mark selects
  // on exactly this predicate (alert-lifecycle.ts), and two hand-written copies
  // could drift into a row that is receded and marked in the same commit.
  const receded = !isLive(view);

  const canAck = lifecycle === "open" && onAcknowledge !== undefined;
  const openFor = lifecycle === "open" ? durationSince(alert.ts, now) : null;
  const ackedAgo = formatRecency(meta?.ackedAt, now);

  return (
    <div
      data-slot="alert-row"
      data-status={chip}
      data-lifecycle={lifecycle}
      data-escalated={escalated || undefined}
      data-cohort={cohortFw}
      data-nudge={nudge || undefined}
      className={cn(
        "group/row border-b border-line",
        "transition-colors duration-[var(--dur-micro)] ease-console",
        receded ? RECEDED : "hover:bg-surface-2",
        "has-[:focus-visible]:bg-surface-2",
        // Guarded by `!receded` as well as by the flag: the feed can only mark
        // a live row, and saying so here means a future caller cannot draw a
        // "start here" rule down the side of an alert somebody already owns.
        nudge && !receded && NUDGE_MARK[chip],
        // The entrance plays on mount and only on mount. A CSS animation is
        // bound to the element, not to the render, and the feed keys rows by
        // alert id — so a row that is merely re-rendering (the duration ticking
        // over, an ack landing) sits perfectly still.
        "alert-enter",
        className,
      )}
      {...props}
    >
      {/* Wraps on a phone: the link claims 20rem before the controls are
          allowed to share its line, so a 390px row puts the actions on their
          own right-aligned row underneath instead of squeezing the message
          into seven characters. */}
      <div className="flex flex-wrap items-center gap-x-2 pr-3">
        <Link
          href={`/unit/${alert.unitId}`}
          className={cn(
            "flex min-w-[20rem] flex-1 flex-col gap-1 py-3 pl-5",
            "focus-visible:[outline-offset:-2px]",
          )}
        >
          <span className="flex items-center gap-3">
            {/* A fixed slot rather than a hugging chip: ATTENTION is half again
                as wide as ALERT, and letting the chip set the column would
                leave the unit ids down the feed in a ragged line. The chip
                still hugs its own text — it is the *column* that is fixed.
                Below `sm` it hugs after all: 104px of reserved column on a
                390px row costs the message forty characters, and a two-row feed
                on a phone has no column to keep straight anyway.
                `bare` once the row has receded: the severity is still true, but
                a tinted pill on a settled row out-shouts the live one two rows
                up, which is the exact hierarchy inversion the tone exists for
                (status-chip.tsx). */}
            <span className="flex shrink-0 sm:w-26">
              <StatusChip status={chip} tone={receded ? "bare" : "quiet"}>
                {alertSeverityCopy(alert.severity)}
              </StatusChip>
            </span>
            <span
              className={cn(
                "shrink-0 tnum text-small",
                resolved ? "text-ink-soft" : "font-medium text-ink",
              )}
            >
              {alert.unitId}
            </span>
            <span className="min-w-0 flex-1 truncate text-small text-ink-soft">
              {alert.message}
            </span>
          </span>

          {/* The record line. Sentence case and normal tracking, unlike every
              other 11px string in this app: "14:31:02" set in wide-tracked caps
              reads as a part number. A timestamp is data, not a label. */}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-label tracking-normal text-ink-soft">
            <time dateTime={isoTime(alert.ts)} className="tnum">
              {clockTime(alert.ts)}
            </time>

            {escalatedFrom !== undefined ? (
              // Where this one came from, in the operator's severity words
              // rather than the wire's colours.
              <Segment>
                Escalated from {alertSeverityCopy("amber").toLowerCase()} ·{" "}
                <span className="tnum">{clockTime(escalatedFrom)}</span>
              </Segment>
            ) : null}

            {escalated ? (
              <Segment>
                <SectionLabel as="span">Escalated</SectionLabel>
              </Segment>
            ) : null}

            {cohortFw !== undefined ? (
              <Segment>
                {/* Muted, like the record line it joins. The row already
                    carries its own severity in the chip; a coloured tag here
                    would read as a second, worse alarm rather than as the note
                    that these four are one situation. */}
                <SectionLabel as="span">Cohort · {cohortFw}</SectionLabel>
              </Segment>
            ) : null}

            {openFor !== null ? (
              // The one live number on the row. It ticks off the feed's shared
              // 1 s clock and stops the moment someone takes the alert — a
              // duration that kept counting after an operator claimed it would
              // be measuring the wrong thing.
              <Segment>
                Open for <span className="tnum">{openFor}</span>
              </Segment>
            ) : null}

            {lifecycle === "acked" ? (
              <Segment>
                Acknowledged · {meta?.ackedBy ?? "Operator"}
                {ackedAgo ? ` · ${ackedAgo}` : ""}
              </Segment>
            ) : null}

            {resolved ? (
              <Segment>
                Resolved · {resolutionVia(meta?.resolution)} ·{" "}
                <span className="tnum">
                  {meta?.resolvedAt !== undefined ? clockTime(meta.resolvedAt) : "—"}
                </span>
              </Segment>
            ) : null}
          </span>
        </Link>

        <div className="ml-auto flex shrink-0 items-center gap-1 py-2">
          {canAck ? (
            <ConsoleButton
              variant="ghost"
              size="sm"
              className={QUIET_ACTION}
              // The visible word is the start of the accessible name, so the
              // two never disagree (WCAG 2.5.3) — the rest is what a screen
              // reader needs to tell forty identical buttons apart.
              aria-label={`Acknowledge alert on ${alert.unitId}`}
              onClick={() => onAcknowledge?.(alert.id)}
            >
              Acknowledge
            </ConsoleButton>
          ) : null}

          <ConsoleButton
            variant="ghost"
            size="sm"
            // Never quiet: the disclosure is the only sign that a row has more
            // behind it, and a control that is invisible until hovered is a
            // feature only a mouse user can discover.
            className="px-2"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={`Related events for ${alert.unitId}`}
            onClick={() => onToggle(alert.id)}
          >
            <svg
              aria-hidden
              viewBox="0 0 12 12"
              className={cn(
                "size-3 transition-transform duration-[var(--dur-micro)] ease-console",
                expanded && "rotate-180",
              )}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="square"
            >
              <path d="M2 4.5 6 8.5l4-4" />
            </svg>
          </ConsoleButton>
        </div>
      </div>

      <Disclosure id={detailId} open={expanded}>
        {/* Indented to the message column, so the chronology reads as this
            row's own history rather than as a new list under it. */}
        <div className="border-t border-line/70 px-5 py-3 pl-5 sm:pl-[7.25rem]">
          {detail}
        </div>
      </Disclosure>
    </div>
  );
}

/**
 * One clause of the record line, carrying its own leading separator.
 *
 * The separator travels *inside* the segment, glued to the first word by a
 * non-breaking space, and that is the whole reason this component exists: as a
 * flex item of its own it would be free to end a wrapped line, and a 390px row
 * would read "16:11:46 ·" with the clause it introduces on the line below. It
 * is decoration, so it is hidden from the accessibility tree — a screen reader
 * announcing "middot" between every fact would be reading the punctuation.
 */
function Segment({ children }: { children: React.ReactNode }) {
  return (
    <span>
      <span aria-hidden className="text-ink-soft/60">
        ·
      </span>
      &nbsp;{children}
    </span>
  );
}
