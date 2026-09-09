import type { FleetMessage } from "@/lib/schema";

/**
 * The history a console is handed the moment it connects.
 *
 * A fleet that begins the instant you open the page has no past, and the
 * console's best idea depends on one: the trend watch fits a least-squares
 * slope over `TREND_WINDOW_MS` and refuses to answer on fewer than
 * `TREND_MIN_SAMPLES` spanning `TREND_MIN_SPAN_MS` — deliberately, because a
 * burst of samples is not a trend. Cold, that is ten seconds of a calm board
 * before the console is even *allowed* to notice anything, and the first
 * person outside this project to open the link left before then.
 *
 * So the run starts already underway. The host steps the engine through this
 * much storyline before the greeting and hands the batches over afterwards,
 * which fills the window with exactly the samples the fleet would have
 * produced had you been watching. Nothing is fabricated: it is the same
 * engine, the same seed, the same 10 Hz, just played out before you arrived.
 *
 * It is deliberately a little longer than the fit window, so the console is
 * not fitting across the very edge of its own history on the first frame.
 */
export const PREROLL_MS = 16_000;

/**
 * The calm between the end of the history and the first beat — what someone
 * sees before anything starts to go wrong, and the margin that keeps a
 * pre-roll from playing the incident to a console it has not greeted yet.
 */
export const PREROLL_LEAD_MS = 2_000;

/**
 * How much history this run may hand over, given where its first beat is.
 *
 * A pre-roll is only ever the calm before the story. The e2e builds compress
 * that story into seconds — onset at 6 s, and one lane parks it at zero — so a
 * pre-roll measured against the real timeline would run straight through the
 * incident before the greeting. Clamping here means no caller has to know
 * that, and a timeline nobody anticipated still cannot break the greeting.
 */
export function prerollFor(requestedMs: number, onsetMs: number): number {
  return Math.max(0, Math.min(requestedMs, onsetMs - PREROLL_LEAD_MS));
}

/**
 * Sent *after* the greeting, never before.
 *
 * A `fleet_snapshot` restates the world, and the store answers by seaming the
 * telemetry channel: the rings survive, but each unit's newest retained
 * sample is marked as the end of a previous run so that nothing fits a rate
 * across the join. History delivered ahead of the snapshot would land behind
 * that seam and be, correctly, ignored — the whole point of the seam is that
 * samples from before a restatement are not evidence about after it.
 *
 * Arriving afterwards, the same samples are simply this run's first batches,
 * which is what they are.
 */
export function collectPreroll(
  advance: (storylineMs: number) => readonly FleetMessage[],
  fromMs: number,
  toMs: number,
  tickMs: number,
): FleetMessage[] {
  const history: FleetMessage[] = [];
  for (let t = fromMs + tickMs; t <= toMs; t += tickMs) {
    for (const m of advance(t)) {
      // Telemetry only. Alerts, statuses and in-flight command events are the
      // greeting's to state, and it has already stated them from the engine's
      // own end-of-preroll position; replaying them here would double them.
      if (m.t === "telemetry") history.push(m);
    }
  }
  return history;
}
