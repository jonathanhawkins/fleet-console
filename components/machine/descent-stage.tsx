"use client";

import * as React from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  descentTimeline,
  EASE_WIPE,
  secs,
  setDescentOccluded,
  usePrefersReducedMotion,
  type DescentTimeline,
} from "@/components/console";
import { selectShownPhase, useIncidentStore } from "@/lib/stores";
import { ChannelReadout } from "./channel-readout";
import { FlagBeat } from "./flag-beat";
import { BootProvider, useBoot } from "./boot-variants";
import { closeDescent } from "./leave-descent";
import { MachineControl } from "./machine-control";
import { buildManifest, manifestCleared, MANIFEST_ROWS } from "./manifest-spec";
import { CommandStatusLine } from "./execute-action";
import { pad2 } from "./scan-copy";
import { ScanColumns } from "./scan-columns";
import { ScanHeader, ScanStatusBar } from "./scan-header";
import { ScanLog } from "./scan-log";
import { ScanPanel } from "./scan-panel";
import { StatusBoard } from "./status-board";
import { VerdictCard, VerdictStrip } from "./verdict-card";
import { VerdictSheet } from "./verdict-sheet";
import {
  useDiagSession,
  useLinkEverLost,
  useScanLink,
  useStackedScan,
  useVerdictSheet,
} from "./scan-state";
import { WaveformDeck, waveformDeckMeta } from "./waveform-deck";
import { cn } from "@/lib/utils";

/**
 * Machine space, and the transition into it. The lazily-loaded root: nothing
 * in this file or anything it imports — framer-motion included — reaches the
 * unit page's initial JS (PRD §7).
 *
 * The three beats (PRD §5) are owned in two places on purpose. Beat 1, the
 * operator page draining, belongs to the gate in components/fleet: it is one
 * attribute on `<html>` and it has to start the instant `scan_start` lands,
 * before this chunk has necessarily resolved. Beats 2 and 3 — the surface
 * wiping bottom-to-top, then the chrome booting in a stagger — belong here,
 * because they are machine space arriving and machine space is what this file
 * is.
 *
 * `startedAt` is what stitches the two halves together. The wipe is scheduled
 * as *time remaining* rather than as a fixed delay from mount, so a chunk that
 * resolved instantly (the preloaded case, which is every real case) gets the
 * designed 200 ms of drain before black starts climbing, and a chunk that had
 * to be fetched does not pay for the drain twice. The descent's total length is
 * bounded either way, which is the property that matters on the one screen the
 * demo is built around.
 */

export interface DescentStageProps {
  unitId: string;
  /** `performance.now()` at the moment the descent was allowed to begin. */
  startedAt: number;
  /** False once the session has ended: play the ascent, then call onDismissed. */
  active: boolean;
  onDismissed(): void;
}

/**
 * The provider seam. `useBoot` has to resolve *below* `BootProvider`, and the
 * surface is what consumes it — so the exported component's only job is to
 * decide the timeline once and hand it down.
 */
export function DescentStage(props: DescentStageProps) {
  const reduced = usePrefersReducedMotion();
  const timeline = React.useMemo(() => descentTimeline(reduced), [reduced]);
  return (
    <BootProvider timeline={timeline}>
      <DescentSurface {...props} timeline={timeline} reduced={reduced} />
    </BootProvider>
  );
}

interface DescentSurfaceProps extends DescentStageProps {
  timeline: DescentTimeline;
  reduced: boolean;
}

/** The departing layer's hit test, hoisted so it is not a new object per frame. */
const UNTOUCHABLE: React.CSSProperties = { pointerEvents: "none" };

function DescentSurface({
  unitId,
  startedAt,
  active,
  onDismissed,
  timeline,
  reduced,
}: DescentSurfaceProps) {
  /**
   * What is on screen, which for the length of the ascent is not what is live
   * in the store.
   *
   * The surface deliberately outlives the session by one exit — the gate says
   * so (descent-overlay.tsx) and the choreography depends on it: the board
   * fades, then the wipe carries black back down. `completeAscent()` returns
   * the store to `idle` with a null session *in the commit that starts that
   * exit*, so a surface rendering the live fields spends its last frames
   * describing a scan that never ran: a session id derived from the current
   * clock (new every render), the state word back to SCANNING, T+00:00, an
   * empty manifest, INITIALISING SCAN.
   *
   * There is nothing here that knows that. The store holds the departing
   * session beside the live one and these three selectors read the one being
   * *shown*, so the surface is a pure function of the store in the exit exactly
   * as it is during the scan — which is the rule scan-state.ts opens with, now
   * without an exception carved into this file. Re-entry (`watchSession`)
   * clears the snapshot and this resumes the live feed on its next render.
   */
  const session = useDiagSession();
  const phase = useIncidentStore(selectShownPhase);
  const link = useScanLink();
  const linkEverLost = useLinkEverLost();
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const boot = useBoot();

  /**
   * Whether the verdict is currently put down. Component state on purpose: see
   * the note in verdict-card.tsx. It lives here rather than in the card because
   * the two halves of the state are in different columns — the card is in the
   * board, the strip it collapses into is in the bottom rule — and this is the
   * nearest thing that owns both.
   */
  const [verdictMinimized, setVerdictMinimized] = React.useState(false);

  /**
   * The phone shape (see the `.scan-grid` note in app/globals.css). Read here
   * only for the three things that are decisions rather than layout: the
   * verdict becomes a sheet instead of a card in a column, the walk log becomes
   * an eight-line tail with a control to open it, and the waveform deck follows
   * each arriving channel into view because on a phone it can be below the fold.
   */
  const stacked = useStackedScan();
  /**
   * Whether the conclusion arrives as a sheet rather than as a card in the
   * board's centre column — every width below 64rem, not just the phone. See
   * `VERDICT_SHEET_QUERY`: between 48 and 64rem the board shares its side of the
   * grid with the channel sweep and has no room to hold a verdict underneath the
   * manifest, which is what made the card overrun its column on a tablet.
   */
  const sheetWidth = useVerdictSheet();
  const [logExpanded, setLogExpanded] = React.useState(false);
  const logPanelRef = React.useRef<HTMLElement | null>(null);

  /**
   * Opening the tail grows the panel downward, and on a phone most of that
   * growth is below the fold — so a tap on EXPAND would otherwise produce a
   * log the operator then has to go looking for. `block: "nearest"` moves the
   * flow the least distance that puts the panel on screen, and the skip-first
   * ref keeps it from firing on arrival, when nothing has been expanded and the
   * sweep is what should be in view.
   */
  const firstLogPass = React.useRef(true);
  React.useEffect(() => {
    if (firstLogPass.current) {
      firstLogPass.current = false;
      return;
    }
    if (!stacked) return;
    logPanelRef.current?.scrollIntoView({
      block: "nearest",
      behavior: reduced ? "auto" : "smooth",
    });
  }, [logExpanded, stacked, reduced]);

  // Time already spent draining the operator page, spent once at mount.
  const wipeDelay = React.useMemo(
    () => Math.max(0, secs(timeline.wipeAtMs - (performance.now() - startedAt))),
    [startedAt, timeline.wipeAtMs],
  );

  const surface = React.useMemo<Variants>(
    () =>
      reduced
        ? {
            hidden: { opacity: 0 },
            covering: {
              opacity: 1,
              transition: { duration: secs(timeline.wipeMs), ease: "linear" },
            },
            away: {
              opacity: 0,
              transition: { duration: secs(timeline.ascentWipeMs), ease: "linear" },
            },
          }
        : {
            hidden: { y: "100%" },
            covering: {
              y: "0%",
              transition: {
                duration: secs(timeline.wipeMs),
                ease: EASE_WIPE,
                delay: wipeDelay,
              },
            },
            away: {
              y: "100%",
              transition: { duration: secs(timeline.ascentWipeMs), ease: EASE_WIPE },
            },
          },
    [reduced, timeline.wipeMs, timeline.ascentWipeMs, wipeDelay],
  );

  /**
   * The rule riding the wipe's leading edge, and the light it spills ahead of
   * itself. It is a child of the surface, so it travels for free — no second
   * animation to keep in sync with the first. Once the surface lands it drops
   * to a dim hairline and becomes the top frame of the board, which is the
   * only reason it is allowed to persist: an edge cue that outlived its edge
   * would be decoration.
   */
  const edge = React.useMemo<Variants>(
    () => ({
      hidden: { opacity: 1 },
      covering: {
        opacity: 0.34,
        transition: {
          delay: wipeDelay + secs(timeline.wipeMs),
          duration: secs(timeline.edgeDimMs),
          ease: "linear",
        },
      },
      // It re-lights with the board it framed, on the board's own beat: the
      // ascent is one event, not an edge leaving separately from an instrument.
      away: {
        opacity: 1,
        transition: { duration: secs(timeline.boardExitMs), ease: "linear" },
      },
    }),
    [wipeDelay, timeline.wipeMs, timeline.edgeDimMs, timeline.boardExitMs],
  );

  /**
   * Escape — the keyboard's half of the CLOSE control, and the same two
   * meanings (leave-descent.ts).
   *
   * This used to be a verdict-only handler: mid-scan there was deliberately no
   * way out, on the reasoning that a surface which can be waved away teaches
   * the operator it was never load-bearing. Overridden by user direction
   * (2026-08-24) and the override is narrow — the scan is still not
   * *cancellable* from the UI, there is still no abort control, and pressing
   * Escape mid-scan does not stop or hide a thing: the session goes on
   * accumulating in the store and the unit page says so with a way back in.
   * What changed is that a modal with no exit for fifteen seconds is a cell,
   * and the keyboard is owed the same door the header now has.
   *
   * The handler runs in every phase now, so it is registered once rather than
   * re-registered on the phase change — `closeDescent` reads the phase at the
   * moment of the press, which is the only reading that can be right.
   */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeDescent();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Focus goes to the surface on arrival and stays inside it: the operator page
   * is inert underneath, and tabbing into a button they cannot see is how a
   * keyboard user learns an overlay was drawn rather than built.
   */
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    root.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === root)
      ) {
        e.preventDefault();
        last.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, []);

  /**
   * The occlusion signal's *clearing* edge. The moment the session
   * ends, `active` flips false and the surface starts its "away" wipe — the
   * operator page begins showing beneath it that same frame, so everything
   * paused under the surface must already be live. The *setting* edge is the
   * surface's own `onAnimationComplete("covering")` below: only the animation
   * knows when the last pixel of page disappeared, in either timeline (wipe
   * landed / reduced-motion crossfade at full opacity). The cleanup covers a
   * hard unmount mid-scan, so the signal can never outlive the surface —
   * including the stage adopted by a mid-scan reload, where the module fact
   * correctly starts false and is only set once the replayed wipe lands.
   *
   * Note what does NOT clear it: link loss (HOLD keeps `phase === "scanning"`)
   * and the verdict card being minimized — in both, the page is still fully
   * covered, so the page stays paused.
   */
  React.useEffect(() => {
    if (!active) {
      setDescentOccluded(false);
      return;
    }
    return () => setDescentOccluded(false);
  }, [active]);

  const scanPhase = phase === "verdict" ? "verdict" : "scanning";
  const cleared = manifestCleared(buildManifest(session));
  const boardMeta = `${pad2(cleared)}/${pad2(MANIFEST_ROWS.length)} CLEARED`;
  const showVerdict = scanPhase === "verdict" && session !== null && !verdictMinimized;
  /** The conclusion has taken the body of the instrument. */
  const sheet = showVerdict && sheetWidth;

  const minimizeVerdict = React.useCallback(() => setVerdictMinimized(true), []);
  const restoreVerdict = React.useCallback(() => setVerdictMinimized(false), []);

  /**
   * Whether the sheet is *actually* over the board, as opposed to having been
   * asked to be.
   *
   * `sheet` flips the instant the state does; the surface takes 151–257 ms to
   * get there and the same to leave. Driving `inert` off the state therefore
   * un-inerted a board still covered by a sheet in mid-flight, and inerted one
   * a restoring sheet had not reached yet — a keyboard could tab into panels
   * nobody can see, or lose panels still in plain sight. The sheet reports the
   * end of its own travel instead. Nobody watching sees this; someone on a
   * keyboard does.
   */
  const [sheetCovering, setSheetCovering] = React.useState(false);

  /**
   * The surface has stopped being the operator's, and has not finished leaving
   *.
   *
   * The latch above is about *display*: it keeps the instrument telling the
   * truth about the scan it is carrying out of the room. It also, on its own,
   * kept the verdict card mounted through the exit — before it, `session`
   * going null unmounted the card in the same commit — and nothing here took
   * the controls on that card out of the pointer's reach.
   *
   * A `fixed inset-0 z-50` box does not stop being hit-testable because it is
   * transparent. Under `prefers-reduced-motion` the exit is a pure opacity
   * ramp, so for its whole length COMMAND SAFE SIT and RECALIBRATE JOINT sat
   * invisible over the unit page, live: a click that reached the confirmation
   * ran `spec.send(unitId)` — a real command, to a real robot, on the wire —
   * and then no-oped `acknowledgeRecommendation`, because `completeAscent` had
   * already returned the store to `idle` and archived the record. The command
   * left the building and the incident could not say so. The same window
   * swallowed clicks meant for the operator page underneath.
   *
   * Two attributes, because they answer two different questions. `inert` is the
   * semantic one: the subtree leaves the accessibility tree, the tab order and
   * find-in-page, which is what a surface nobody can act on should look like to
   * a screen reader and a keyboard. `pointer-events: none` is the physical one:
   * inert suppresses the click but still consumes the hit, and the page coming
   * back into view underneath is entitled to it. Inline rather than a utility
   * class because it is a behavioural fact this file owns and asserts, not a
   * style — and because a fade-out that is still clickable is precisely the bug
   * a stylesheet-only version could regress to unnoticed.
   *
   * Scoped to the layer rather than to the controls: every future thing on this
   * surface inherits the property, which is the difference between fixing this
   * bug and fixing this instance of it. It nests harmlessly over the sheet's own
   * `inert` below — an inert ancestor already covers the subtree — and it can
   * only ever be set while `active` is false, so a surface that is still the
   * operator's is never touched. An `active` that flips back on mid-exit (the
   * gate's re-entry case) clears both on the same render that resumes the feed.
   */
  const departing = !active;

  return (
    // The three panels below read the session for themselves rather than being
    // handed it — the log, the board and the deck are pure functions of it and
    // that is the rule in scan-state.ts. Nothing tells them *whose*: they call
    // the same `useDiagSession` this component does, and the store is what
    // knows that through an ascent the shown session is the departing one.
    <div
      data-descent-layer
      inert={departing || undefined}
      style={departing ? UNTOUCHABLE : undefined}
      className="fixed inset-0 z-50 overflow-hidden"
    >
      {/* Two elements, and the split is not cosmetic. The outer one is what
          moves; the inner one is machine space.

          `[data-space="machine"]` in globals.css carries `position: relative`
          (unlayered, so it outranks every Tailwind utility) because the
          scanline texture is an `::before` that needs a containing block and a
          stacking context on whatever subtree flips into the machine's world.
          Putting the transform and the attribute on one element therefore
          silently loses to that rule: the surface stops being `absolute`,
          collapses to its content's height, and the wipe carries a strip of
          black instead of a screen. Separating the two gives each rule the
          element it was written for. */}
      <motion.div
        variants={surface}
        initial="hidden"
        animate={active ? "covering" : "away"}
        onAnimationComplete={(label) => {
          // The surface has landed: the operator page is 100 % covered from
          // this frame until `active` drops. The `active` guard rejects a
          // completion that resolves after an interrupt has already begun the
          // ascent — occluded must never be true while "away" is playing.
          if (label === "covering" && active) setDescentOccluded(true);
          if (label === "away") onDismissed();
        }}
        // No `will-change`. It was `transform, opacity`, statically, which
        // pinned a full-screen composited layer for the entire scan — every
        // waveform frame, every log line — to buy 350 ms of wipe, and lied on
        // the reduced-motion path by promising a transform that timeline never
        // touches. Measured with it and without, 1280×1100 on the dev build:
        // the wipe is p50 8.3 ms / p95 9.2 ms / max 16.8 ms *without* the hint
        // and p50 8.3 / p95 16.7 / max 17.3 with it, in both timelines. The
        // surface reads `will-change: auto` for the whole descent now and drops
        // nothing, so the hint was cost without a purchase.
        className="absolute inset-0"
      >
        <div
          ref={rootRef}
          // Machine space begins at the surface, not at the layer above it, so
          // the scanline belongs to the screen that is arriving and rides up
          // with it rather than tinting the operator page during the drain.
          data-space="machine"
          role="dialog"
          aria-modal="true"
          aria-label={`Diagnostic scan, unit ${unitId}`}
          tabIndex={-1}
          className="h-full w-full bg-bg outline-none"
        >
          {reduced ? (
            <span aria-hidden className="descent-edge descent-edge--static" />
          ) : (
            <motion.span aria-hidden variants={edge} className="descent-edge" />
          )}

          {/* Above the board, below the scanline: the beat is something that
              happens *to* the instrument, not a layer of the page. */}
          <FlagBeat flagged={session?.flag != null} />

          <motion.div
            variants={boot.parent}
            initial="hidden"
            animate={active ? "shown" : "gone"}
            className="absolute inset-0 flex flex-col"
          >
            <ScanHeader
              unitId={unitId}
              // The session's clock, not the surface's. `startedAt` above is a
              // performance.now() reading that restarts every time the wipe
              // plays — including when an operator who left a running scan
              // comes back to it — and a header driven off it would hand the
              // same scan a second session id and a fresh T+00:00.
              startedAt={session?.startedAt ?? Date.now()}
              link={link}
              phase={scanPhase}
              showReturn={linkEverLost && scanPhase === "scanning"}
            />

            <motion.span
              aria-hidden
              variants={boot.rule}
              className="h-px w-full origin-left bg-line-strong"
            />

            {/* The body of the instrument. On a board it is the three columns
                and nothing else; on a phone it is the same three panels
                scrolling, with the verdict sheet able to take the whole box
                without unmounting them — which is what makes MINIMIZE feel
                like putting something down rather than reopening a screen. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              <ScanColumns className="min-h-0 flex-1" inert={sheetCovering || undefined}>
                <ScanPanel
                  ref={logPanelRef}
                  area="log"
                  label="Subsystem walk"
                  meta={
                    <span className="flex items-center gap-2">
                      {session ? `${session.walkLines.length} NODES` : null}
                      {stacked ? (
                        <MachineControl
                          aria-expanded={logExpanded}
                          onClick={() => setLogExpanded((open) => !open)}
                        >
                          {logExpanded ? "Collapse" : "Expand"}
                        </MachineControl>
                      ) : null}
                    </span>
                  }
                  // A phone gets the tail, not the column: eight lines of a
                  // twenty-node walk, hanging from the bottom edge the way the
                  // log already hangs, with the newest line always the last one
                  // on screen. The whole transcript is one tap away and stays
                  // out of the way until it is asked for — which is the right
                  // default for the panel that, of the three, an operator on a
                  // phone is least likely to be reading and most likely to be
                  // scrolling past.
                  // The tail opens and closes on a transition rather than a
                  // class swap. Both heights are definite, so the browser
                  // interpolates between them — and re-targets from whatever is
                  // on screen if EXPAND is hit again mid-open, which is the one
                  // property a toggle owes a fast thumb. Reduced motion gets the
                  // instant change for free: the clamp at the top of globals.css
                  // collapses the duration to nothing.
                  className={cn(
                    "max-md:overflow-hidden",
                    "max-md:transition-[max-height] max-md:duration-[var(--dur-micro)] max-md:ease-console",
                    logExpanded ? "max-md:max-h-[60dvh]" : "max-md:max-h-[12.5rem]",
                  )}
                >
                  <ScanLog link={link} complete={scanPhase === "verdict"} />
                </ScanPanel>
                <ScanPanel area="board" label="Parts manifest" meta={boardMeta}>
                  {/* The board and, beneath it, the conclusion. The centre column
                      has been holding this space open all scan; the verdict is
                      what it was holding it for, and putting the card here rather
                      than in a modal keeps every piece of evidence that produced
                      it on screen behind it. */}
                  {/* Two boxes, and the split is load-bearing. The inner one
                      scrolls; the outer one is positioned and does not. A
                      command's confirmation (execute-action.tsx) pins itself
                      to the foot of the OUTER box — the column's visible
                      edge, not the scroll content — which is what lets the
                      gate open and close without the column moving under
                      the manifest and the elevation. `.scan-grid` is the
                      only other positioned ancestor, and a gate anchored to
                      that would straddle all three columns. */}
                  <div
                    data-slot="verdict-column"
                    className="relative flex min-h-0 flex-1 flex-col"
                  >
                    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
                      <StatusBoard />
                      {/* Presence, so the card can leave the way it arrived. Its
                          fade lives in boot.verdict; all this does is hold the
                          subtree mounted long enough for the fade to play, which
                          is what makes minimize and restore the same gesture in
                          two directions rather than one animation and one
                          deletion. */}
                      <AnimatePresence>
                        {showVerdict && session && !sheetWidth ? (
                          <div key="verdict" className="px-3 pb-3">
                            <VerdictCard session={session} onMinimize={minimizeVerdict} />
                          </div>
                        ) : null}
                      </AnimatePresence>
                    </div>
                  </div>
                </ScanPanel>
                <ScanPanel
                  area="waves"
                  label="Channel sweep"
                  meta={waveformDeckMeta(session?.channels.length ?? 0)}
                >
                  <WaveformDeck
                    flaggedJoint={session?.flag?.joint ?? null}
                    revealArrivals={stacked}
                    reducedMotion={reduced}
                  />
                  <ChannelReadout channels={session?.channels ?? []} />
                </ScanPanel>
              </ScanColumns>

              {/* The verdict, at phone scale: not a card inside a panel inside a
                  scroller — three boxes deep is where a conclusion goes to be
                  missed — but the whole body of the instrument, between the two
                  rules that keep saying whose scan this is and what it found.
                  The session header and the status line deliberately stay
                  visible: a sheet that covered them would have to reprint the
                  unit id and the phase to be legible, and a conclusion that
                  needs its own title bar has stopped being part of the same
                  instrument. */}
              {/* Mounted for as long as the sheet has anywhere to be — the
                  component keeps itself on screen through its own exit, which is
                  what lets a flick carry all the way down into the status rule
                  instead of vanishing at the moment the state flips. */}
              {sheetWidth && session ? (
                <VerdictSheet
                  open={sheet}
                  onMinimize={minimizeVerdict}
                  // A drag that caught the sheet on its way out and threw it
                  // back up has un-minimized the verdict, and the chip in the
                  // status rule has to hear about it — the gesture decides a
                  // view state, so it owes the same callback the chip does.
                  onRestore={restoreVerdict}
                  onCoveredChange={setSheetCovering}
                  reduced={reduced}
                >
                  <VerdictCard
                    session={session}
                    surface="sheet"
                    onMinimize={minimizeVerdict}
                  />
                </VerdictSheet>
              ) : null}
            </div>

            <motion.span
              aria-hidden
              variants={boot.rule}
              className="h-px w-full origin-left bg-line-strong"
            />

            <motion.div variants={boot.item}>
              <ScanStatusBar
                session={session}
                link={link}
                phase={scanPhase}
                // Two tenants, and the order is the order they matter in. The
                // command line is first because it is the only thing on this
                // surface that is happening to a *robot*; the minimized verdict
                // is a view state waiting to be picked back up.
                //
                // The command line lives here rather than only in the card
                // because the card can be put down mid-maneuver and the bottom
                // rule cannot — see the note on CommandStatusLine, which is
                // also this surface's live region for the command.
                trailing={
                  <>
                    <CommandStatusLine unitId={unitId} />
                    {verdictMinimized && session?.report ? (
                      <VerdictStrip report={session.report} onRestore={restoreVerdict} />
                    ) : null}
                  </>
                }
              />
            </motion.div>
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
}
