import type { EngineConfig } from "./state";

/**
 * The storyline's four chapters, addressable by name.
 *
 * The fleet runs one clock and four stories on it: N-07's knee amber at 18 s,
 * N-03's blocked route at 2:00, the firmware cohort at 3:00, N-01's encoder
 * offset at 5:30. Watched end to end that is five and a half minutes, which is longer
 * than anyone gives a demo they did not build — so three of the four went
 * unseen by everyone who ever opened it.
 *
 * A chapter is named rather than timed on the wire because the console does not
 * know the clock: the timelines are configurable (the e2e build compresses them
 * to seconds, and parks two of the four outright), so a console that asked to
 * seek to 180_000 would be asking for a moment that build does not have. It
 * asks for the cohort; the engine answers with whenever the cohort is.
 */
export const STORYLINE_CHAPTERS = ["knee", "nav", "cohort", "offset"] as const;

export type StorylineChapter = (typeof STORYLINE_CHAPTERS)[number];

/**
 * Land this far short of the beat. Seeking *onto* an alert means arriving to
 * find it already raised, which is the one thing the fleet page is built to
 * show happening — the marker, the rail row and the feed reacting in one batch.
 * Eight seconds is long enough to read the board before it changes.
 */
export const CHAPTER_LEAD_MS = 8_000;

/** Storyline ms of a chapter's first visible beat, per this engine's timelines. */
export function chapterBeatMs(cfg: EngineConfig, chapter: StorylineChapter): number {
  switch (chapter) {
    case "knee":
      // The amber, not the onset: the onset sits inside the history a run is
      // handed, and the first thing anyone sees is the unit turning.
      return cfg.timeline.amberAtMs;
    case "nav":
      return cfg.navTimeline.blockAtMs;
    case "cohort":
      return cfg.cohortTimeline.onsetMs;
    case "offset":
      return cfg.offsetTimeline.alertAtMs;
  }
}

/** Where the storyline clock lands for a chapter: its beat, less the lead-in. */
export function chapterSeekMs(cfg: EngineConfig, chapter: StorylineChapter): number {
  return Math.max(0, chapterBeatMs(cfg, chapter) - CHAPTER_LEAD_MS);
}

/**
 * The shorter lead an *advance* lands with. A seek is pressed by someone who
 * then looks up at a board they have not seen in a while; an advance fires
 * as the operator files an incident and turns back to the fleet, and the next
 * act should be arriving as they do — long enough for the page to change
 * under them, not long enough to wonder whether anything will.
 */
export const ADVANCE_LEAD_MS = 4_000;

/** Where the clock lands for an advance to a chapter: its beat, less the shorter lead. */
export function chapterAdvanceMs(cfg: EngineConfig, chapter: StorylineChapter): number {
  return Math.max(0, chapterBeatMs(cfg, chapter) - ADVANCE_LEAD_MS);
}
