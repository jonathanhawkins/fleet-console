"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ConsoleButton, useNow } from "@/components/console";
import { useIncidentStore, type DiagSession } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { useBoot } from "./boot-variants";
import { closeDescent } from "./leave-descent";
import { MachineControl } from "./machine-control";
import {
  elapsedLabel,
  scanPhaseWord,
  scanStatusLine,
  sessionTag,
  type ScanProgress,
} from "./scan-copy";
import { useCalibrationOutcome, type ScanLink } from "./scan-state";

/**
 * Who is being scanned, for how long, and in what state — the title block the
 * eva parts-status board puts above its columns, in this product's vocabulary.
 *
 * The elapsed clock runs on the app's shared one-second ticker rather than on
 * a timer of its own (components/console/relative-time.ts). Two reasons, and
 * the second is the real one: a private `setInterval` here would be a third
 * clock in a screen that already has a 10 Hz telemetry stream and a 60 Hz
 * frame loop, and this text can only change once a second anyway.
 */

const STATE_MARK: Record<string, string> = {
  SCANNING: "bg-nominal",
  VERDICT: "bg-warn",
  // The one state on this rule that is good news, and it takes the same square
  // the scan took while everything was still fine. Amber here would be a
  // warning about a channel the machine has just measured back inside its
  // envelope — the header contradicting the board under it.
  CLEARED: "bg-nominal",
  HOLD: "bg-alert",
};

export interface ScanHeaderProps {
  unitId: string;
  /**
   * Epoch ms the session opened — the store's, not the stage's.
   *
   * The stage's own `startedAt` is a `performance.now()` reading for the wipe,
   * and it starts again every time the surface travels. Since the operator can
   * now leave a running scan and come back to it, driving the session
   * tag and the elapsed clock off that would print a new session id and a
   * T+00:00 for a scan already thirty seconds old.
   */
  startedAt: number;
  link: ScanLink;
  phase: "scanning" | "verdict";
  /**
   * Offer the way *out of a scan that may no longer exist*. True once the link
   * has dropped at all — the console cannot tell a resumable reconnect from a
   * restarted host (see scan-state.ts), so it must not hold a session that will
   * never conclude. Distinct from CLOSE below, and deliberately so: this one
   * aborts, because the alternative is a store stuck in `scanning` for the rest
   * of the app's life with every run control disabled behind it.
   */
  showReturn: boolean;
}

export function ScanHeader({
  unitId,
  startedAt,
  link,
  phase,
  showReturn,
}: ScanHeaderProps) {
  const boot = useBoot();
  const now = useNow();
  // Both clocks are epoch ms now, so the elapsed label is a subtraction. The
  // ticker reports 0 until the client takes over (relative-time.ts).
  const elapsed = now > 0 ? now - startedAt : 0;

  const tag = React.useMemo(() => sessionTag(unitId, startedAt), [unitId, startedAt]);
  // Read here rather than passed in: the phase chip is a projection of the
  // session like every other panel on this surface (scan-state.ts).
  const outcome = useCalibrationOutcome();
  const word = scanPhaseWord(link, phase, outcome === "cleared");

  return (
    // The top of a surface that is `fixed inset-0`, so it is the app and not
    // the browser that owes the notch its clearance. `env()` resolves to 0
    // everywhere else, which is why it can simply be added.
    //
    // Three columns on a board, two rows on a phone, one rule for both: the
    // subject on the left, the session's vitals in the middle, the way out on
    // the right. The `order` swap is what puts CLOSE beside the unit id when
    // the header wraps — a control the operator reaches for without looking
    // belongs on the top line of the surface at every width, not below a
    // wrapped metadata cluster.
    <header className="flex shrink-0 flex-wrap items-baseline justify-between gap-x-8 gap-y-2 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 md:px-6">
      <motion.div variants={boot.item} className="order-1 flex items-baseline gap-4">
        <h1 className="tnum text-title text-ink uppercase">Unit {unitId}</h1>
        <span className="text-label text-ink-soft uppercase">Diagnostic scan</span>
      </motion.div>

      <motion.div
        variants={boot.item}
        className="order-3 flex w-full flex-wrap items-center gap-x-6 gap-y-1 text-label uppercase md:order-2 md:w-auto"
      >
        <span className="text-ink-muted">
          Session <span className="tnum text-ink-soft">{tag}</span>
        </span>
        <span className="tnum text-ink-soft">{elapsedLabel(elapsed)}</span>
        <span className="flex items-center gap-2 text-ink">
          {/* A square, not a dot: machine space has no radius, anywhere. */}
          <span aria-hidden className={cn("size-1.5 shrink-0", STATE_MARK[word])} />
          {word}
        </span>
        {showReturn ? (
          <ConsoleButton
            size="sm"
            variant="secondary"
            onClick={() => useIncidentStore.getState().abortSession()}
          >
            Return to console
          </ConsoleButton>
        ) : null}
      </motion.div>

      <motion.div variants={boot.item} className="order-2 self-center md:order-3">
        <CloseDescentControl phase={phase} />
      </motion.div>
    </header>
  );
}

/**
 * The way out, in every phase.
 *
 * Before this the only exit was RETURN at the foot of the verdict card, which
 * meant an operator who descended into a fifteen-second scan was held in
 * machine space until the scan chose to finish. The fix is not an abort — the
 * sim is running the sequence and a button claiming to stop it would be lying
 * about a machine — it is a door: mid-scan this ascends and leaves the session
 * running, and at the verdict it *is* RETURN, incident and all
 * (leave-descent.ts owns that split).
 *
 * A word in a box rather than a glyph, because machine space prints and does
 * not draw, and CLOSE is the shortest true word for what it does in both
 * phases. `soft`, so it rests one luminance tier below the unit id beside it
 * and a long way below the flag beat, whose contrast is the one thing on this
 * board allowed to be loud; it takes the same phosphor inversion under the
 * cursor that every other chip on the instrument takes. The 24 px box carries
 * the machine controls' 10 px invisible touch margin on coarse pointers
 * (globals.css), which is what makes it a 44 px target on a phone without
 * printing a 44 px box on a board.
 */
function CloseDescentControl({ phase }: { phase: "scanning" | "verdict" }) {
  const describedBy = React.useId();
  return (
    <>
      <MachineControl
        // Named for the surface it closes, not for what happens underneath —
        // "Close diagnostic view" is true in both phases, where "End
        // diagnostic" would be true in neither.
        aria-label="Close diagnostic view"
        aria-describedby={describedBy}
        onClick={closeDescent}
      >
        Close
      </MachineControl>
      {/* The one difference the two phases owe a screen reader: at the verdict
          this archives the incident, and mid-scan it does not stop anything.
          Neither is a thing to discover after pressing. */}
      <span id={describedBy} className="sr-only">
        {phase === "verdict"
          ? "Returns to the console. The incident is logged."
          : "Returns to the console. The scan keeps running."}
      </span>
    </>
  );
}

/**
 * The bottom rule's one sentence: what the scanner is doing right now.
 *
 * Every word of it is composed in scan-copy.ts from session state, so the
 * status line cannot drift from the board above it and cannot claim progress
 * that has not arrived.
 *
 * `trailing` is where a minimized verdict goes to wait (verdict-card.tsx). The
 * bottom rule is the right shelf for it: it is the one strip of chrome that is
 * on screen in every phase, it already speaks in single uppercase lines, and
 * putting the collapsed conclusion anywhere else would mean inventing a second
 * status area for one state.
 */
export function ScanStatusBar({
  session,
  link,
  phase,
  trailing,
}: {
  session: DiagSession | null;
  link: ScanLink;
  phase: "scanning" | "verdict";
  trailing?: React.ReactNode;
}) {
  const progress: ScanProgress = {
    walked: session?.walkLines.length ?? 0,
    channels: session?.channels.length ?? 0,
    flagged: session?.flag != null,
    hasVerdict: session?.report != null,
    cleared: session?.calibration?.outcome === "cleared",
  };

  const line = scanStatusLine(progress, link, phase);
  const held = link !== "open";

  return (
    // Same reasoning as the header's top inset: this rule sits on the bottom
    // edge of the viewport, and on a phone that edge belongs to the home
    // indicator. The minimized verdict's RESTORE and RETURN live here.
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:px-6">
      <p
        // Spoken, because the status line is where a held link is announced and
        // the operator may be watching the waveforms rather than the footer.
        aria-live="polite"
        className={cn("tnum text-label uppercase", held ? "text-alert" : "text-ink-soft")}
      >
        {line}
      </p>
      {trailing}
    </div>
  );
}
