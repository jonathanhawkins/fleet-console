import { type DiagSession } from "@/lib/stores";

/**
 * How far along a diagnostic scan is, measured in work the wire has actually
 * reported.
 *
 * A scan takes about fifteen seconds and the operator is entitled to know
 * where in it they are. The tempting implementation — elapsed time over
 * expected duration — is the one thing this console must not do. That bar is
 * not reading the machine, it is reading a clock, and it keeps filling while a
 * dropped socket means nothing at all is happening. It also breaks the moment
 * the timeline is scaled, which the e2e build does at 0.25x.
 *
 * So progress is counted, not timed: twenty subsystem nodes and six measured
 * channels, and the fraction is how many of the twenty-six have arrived. A
 * stalled link stalls the bar, which is the truth. A scan that finishes early
 * finishes the bar, because the verdict is the twenty-seventh fact and it
 * settles the question by itself.
 *
 * The two totals are declared here rather than imported from the simulator,
 * for the same reason the parts manifest declares its own rows: the UI states
 * what it expects the machine to say, and a test — not a shared constant —
 * holds the two to each other. Importing `sim/engine` to count an array would
 * pull the engine into the unit page's initial bundle to learn the number 20.
 */

/** Subsystem nodes one scan walks (sim/engine/diagnostics.ts `DIAG_WALK_PATHS`). */
export const EXPECTED_WALKS = 20;

/** Channels one scan measures, one per joint (sim/engine/constants.ts `JOINTS`). */
export const EXPECTED_CHANNELS = 6;

export const EXPECTED_SCAN_UNITS = EXPECTED_WALKS + EXPECTED_CHANNELS;

/**
 * Which half of the scan is running, for the line above the bar.
 *
 * `starting` is the gap between the operator's press and the first walk line —
 * short, but it is the one stretch where nothing has arrived yet, and a bar
 * sitting at zero with no words under it reads as a scan that failed to begin.
 */
export type ScanStage = "starting" | "subsystems" | "channels" | "complete";

export interface ScanProgress {
  /** 0…1, clamped. */
  fraction: number;
  /** Units of work reported so far. */
  completed: number;
  /** Units expected in total. */
  total: number;
  stage: ScanStage;
}

const COMPLETE: ScanProgress = {
  fraction: 1,
  completed: EXPECTED_SCAN_UNITS,
  total: EXPECTED_SCAN_UNITS,
  stage: "complete",
};

/**
 * Progress for a session, or the settled value once a verdict is in.
 *
 * Counts are clamped rather than trusted: a scan that walked one more node
 * than this file expects should show a full bar and a stale constant, not a
 * bar past its own end. The pinning test is what catches the drift; this is
 * what keeps the screen sane until someone reads it.
 */
export function scanProgress(
  session: Pick<DiagSession, "walkLines" | "channels" | "report"> | null,
): ScanProgress {
  if (!session)
    return { fraction: 0, completed: 0, total: EXPECTED_SCAN_UNITS, stage: "starting" };
  if (session.report) return COMPLETE;

  const walks = Math.min(session.walkLines.length, EXPECTED_WALKS);
  const channels = Math.min(session.channels.length, EXPECTED_CHANNELS);
  const completed = walks + channels;

  return {
    fraction: Math.min(1, completed / EXPECTED_SCAN_UNITS),
    completed,
    total: EXPECTED_SCAN_UNITS,
    stage: completed === 0 ? "starting" : channels > 0 ? "channels" : "subsystems",
  };
}
