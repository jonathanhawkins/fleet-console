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

/**
 * Where the deployed demo lives.
 *
 * One constant because it is not only a link: `metadataBase` turns it into the
 * absolute URLs a link unfurler needs for the preview card, and a stale value
 * there does not break loudly — it serves a card that 404s, which looks like
 * having no card at all. The markdown copies of this URL are listed in
 * CLAUDE.md under "If this repo moves"; they cannot import a constant.
 */
export const SITE_URL = "https://fleet-console.pages.dev";

/**
 * Where the source lives.
 *
 * The demo is an engineering sample, so the code is part of what it shows —
 * the footer links it beside the sentence admitting the fleet is simulated,
 * which is the other half of the same disclosure. `check-receipts.mjs` holds
 * this against the checkout's own git remote, so a move that renames the repo
 * fails there rather than serving a 404 from the footer of every page.
 */
export const REPO_URL = "https://github.com/jonathanhawkins/fleet-console";
