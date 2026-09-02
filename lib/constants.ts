/**
 * Required on every page (CLAUDE.md non-negotiable #5, PRD §2).
 * All fleet data in this app is simulated; nothing here is real telemetry.
 * (Amended 2026-08-24, then 2026-08-30: no company naming anywhere —
 * the app UI, README, and docs are all company-neutral.)
 */
export const DISCLAIMER = "A design and engineering demo. All data is simulated.";

/** The two visual worlds. Contexts, not a user preference — never a theme toggle. */
export const SPACES = ["operator", "machine"] as const;
export type Space = (typeof SPACES)[number];
