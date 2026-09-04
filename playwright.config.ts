import { defineConfig, devices } from "@playwright/test";

/**
 * One e2e suite: the 90-second golden path (PRD §6), run against the
 * deploy artifact — a static export with the sim in a Web Worker — not against
 * `next dev`. The webServer builds that artifact with the storyline compressed
 * (onset 6 s / amber 9 s / red 12 s, diag choreography at 0.25x) and a pinned
 * seed, then serves `out/` with the same URL resolution Cloudflare Pages
 * applies (scripts/serve-static.mjs).
 *
 * The compression lives HERE and only here: the committed app defaults stay on
 * the real 45-second storyline, and `pnpm build:static` with no extra env
 * produces the production bundle. `reuseExistingServer` stays false so a run
 * can never accidentally test a stale or default-timeline bundle left on the
 * port by manual work.
 */

/**
 * Ports and artifact paths are keyed to one base, so two lanes can run
 * the full chain at once:
 *
 * E2E_PORT_BASE=4290 pnpm exec playwright test
 *
 * Unset, everything below is exactly what it has always been — ports 4271/4272
 * and the main artifact in `out/`, which is what `pnpm budgets` measures at the
 * end of `pnpm e2e`. A lane on another base keeps its artifacts out of `out/`
 * entirely and points budgets at them itself:
 *
 * node scripts/check-budgets.mjs .e2e-cohort/4290/main
 */
const DEFAULT_PORT_BASE = 4271;
const PORT_BASE =
  Number.parseInt(process.env.E2E_PORT_BASE ?? "", 10) || DEFAULT_PORT_BASE;
const E2E_PORT = PORT_BASE;
/** The cohort lane's own server; see E2E_COHORT_ENV and the webServer note. */
const COHORT_PORT = PORT_BASE + 1;

/**
 * Both artifacts live under `.e2e-cohort/<base>/` — the one directory already
 * ignored by git, eslint, prettier and the build mirror — so a run only ever
 * deletes its own base's subtree and concurrent lanes cannot see each other.
 * The exception is the default lane's main artifact, which stays in `out/`
 * because that is the path the budget check and the perf probes read.
 */
const LANE_OUT = `.e2e-cohort/${PORT_BASE}`;
/** Where the cohort artifact is parked so the other build cannot overwrite it. */
const COHORT_OUT = `${LANE_OUT}/cohort`;
const MAIN_OUT = PORT_BASE === DEFAULT_PORT_BASE ? "out" : `${LANE_OUT}/main`;

/** Far enough past every test window to be a storyline that does not exist. */
const PARKED = 3_600_000;

const E2E_BUILD_ENV = [
  "STATIC_EXPORT=1",
  "NEXT_PUBLIC_TRANSPORT=worker",
  "NEXT_PUBLIC_SIM_SEED=7",
  "NEXT_PUBLIC_SIM_ONSET_MS=6000",
  "NEXT_PUBLIC_SIM_AMBER_MS=9000",
  "NEXT_PUBLIC_SIM_RED_MS=12000",
  // Park the N-03 self-recovery storyline (default block 120 s) far past the
  // test window: the specs assert the N-07 walk against an exact alert feed,
  // and a second storyline drifting into a slow run would inject a row the
  // assertions never asked for. Its own coverage is sim-level (deterministic
  // engine tests) + compressed-timeline browser verification.
  "NEXT_PUBLIC_SIM_N03_BLOCK_MS=3600000",
  "NEXT_PUBLIC_SIM_N03_CLEAR_MS=3640000",
  // Same treatment for the firmware cohort (default onset 180 s,
  // queued install 270 s), and the same reason with more force: a cohort forms
  // FOUR alert rows at once and puts a card above the whole page. Every lane
  // except the cohort one asserts against a fleet where that has not happened.
  `NEXT_PUBLIC_SIM_COHORT_ONSET_MS=${PARKED}`,
  `NEXT_PUBLIC_SIM_COHORT_PENDING_AT_MS=${PARKED + 300_000}`,
  "NEXT_PUBLIC_SIM_DIAG_SCALE=0.25",
].join(" ");

/**
 * The cohort lane's build: the mirror image of the one above.
 *
 * The three storylines cannot share a window — they run on one clock, and the
 * `NEXT_PUBLIC_*` knobs are inlined at build time, so "compressed cohort" and
 * "compressed N-07 walk" are two different artifacts rather than two runtime
 * flags (lib/transport/createTransport.ts). So this lane parks N-07 and N-03
 * and compresses the rollout instead: the signature ambers land 4 s in, 1.5 s
 * apart (detectable at 7 s, four members by 8.5 s), the queued install is 60 s
 * out so HALT_ROLLOUT is comfortably in time on a slow box, and the staged
 * rollback runs at 1.5 s per unit — six seconds to watch four alerts clear
 * themselves.
 */
const E2E_COHORT_ENV = [
  "STATIC_EXPORT=1",
  "NEXT_PUBLIC_TRANSPORT=worker",
  "NEXT_PUBLIC_SIM_SEED=7",
  `NEXT_PUBLIC_SIM_ONSET_MS=${PARKED}`,
  `NEXT_PUBLIC_SIM_AMBER_MS=${PARKED + 10_000}`,
  `NEXT_PUBLIC_SIM_RED_MS=${PARKED + 20_000}`,
  `NEXT_PUBLIC_SIM_N03_BLOCK_MS=${PARKED + 30_000}`,
  `NEXT_PUBLIC_SIM_N03_CLEAR_MS=${PARKED + 40_000}`,
  "NEXT_PUBLIC_SIM_COHORT_ONSET_MS=4000",
  "NEXT_PUBLIC_SIM_COHORT_STAGGER_MS=1500",
  "NEXT_PUBLIC_SIM_COHORT_PENDING_AT_MS=60000",
  "NEXT_PUBLIC_SIM_COHORT_ROLLBACK_MS=1500",
].join(" ");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      /**
       * The desk lane. The golden path (the walk that IS the product), the
       * leave-and-return loop it does not cover — an operator stepping out of
       * a running scan and coming back to it — the recalibration branch it
       * deliberately does not take, which is the maneuver that earns the
       * dispatch, the map's failure path (a blocked tile host, which needs
       * nothing about the storyline), the accessibility walk (axe on each
       * surface the path opens, plus one traversal driven only by the
       * keyboard), and the responsive check, which resizes itself and fails on
       * anything cut off past the viewport with no scroller to reach it.
       * They share the lane because they share a build and a
       * viewport; they are separate files because one of them is the demo and
       * the rest are properties of it.
       */
      name: "chromium",
      testMatch:
        /(golden-path|leave-return|recalibrate|map-degraded|error-states|accessibility|responsive)\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        // Override the device preset's 720p: tall enough that all eight rail
        // rows are mounted even under virtualization — the spec counts them.
        viewport: { width: 1280, height: 1100 },
      },
    },
    {
      /**
       * The fleet incident lane. Its own build and its own server
       * (see E2E_COHORT_ENV), because the storyline it needs is the one every
       * other lane parks — the desk viewport is the only thing it shares with
       * `chromium`.
       *
       * One spec, one walk: detection → the canary argument → HALT_ROLLOUT
       * saving the queued unit → ROLLBACK_COHORT draining unit by unit → the
       * alerts clearing themselves → the card resolving out, with the KPI
       * honest at every step.
       */
      name: "cohort",
      testMatch: /cohort\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://localhost:${COHORT_PORT}`,
        viewport: { width: 1280, height: 1100 },
      },
    },
    {
      /**
       * The phone lane. 390x844 is the iPhone 12/13/14 logical
       * viewport and the narrow end of the range the responsive pass targets;
       * `isMobile` + `hasTouch` are what make it a phone rather than a small
       * window — they turn on Chromium's mobile emulation, so `pointer: coarse`
       * and `hover: none` match, `tap()` dispatches real touch events, and the
       * hover-only affordances the board leans on (the turntable pause, the map
       * marker label) are exercised in the state a finger actually produces.
       *
       * It runs against the same build as the desktop lane — one webServer, two
       * viewports — so the two specs cost one compile between them.
       */
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      /**
       * The reduced-motion lane. Same build, same desktop
       * viewport as `chromium` — the only variable is the preference. Five RM
       * implementations (MapLibre's essential:false skip, the banner's rAF
       * spring branch, the descent's REDUCED framer timeline, the CSS
       * clamp/display:none rules, the wireframe's pinned canvas yaw) have unit
       * coverage in isolation; this project is where they compose in a real
       * browser with `prefers-reduced-motion` actually set.
       */
      name: "reduced-motion",
      testMatch: /reduced-motion\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 1100 },
        contextOptions: { reducedMotion: "reduce" },
      },
    },
    {
      /**
       * The phone under the same preference — the one shape the desktop RM lane
       * cannot reach, because at ≥64rem the verdict is a card in a column and
       * the sheet (with its RM contract: drag keeps 1:1 tracking, decisions
       * apply on the release frame, mount/park is a crossfade) never exists.
       */
      name: "mobile-reduced",
      testMatch: /mobile-reduced\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        contextOptions: { reducedMotion: "reduce" },
      },
    },
  ],
  /**
   * Two artifacts, two ports, one entry.
   *
   * They cannot be two `webServer` entries: Playwright starts those in
   * parallel, and both commands build through scripts/build-isolated.mjs —
   * which also keeps these builds from corrupting a running dev server's
   * `.next`. That script now hands each concurrent build its own
   * workdir, but the two builds are still run in sequence here: they would
   * otherwise hold two turbopack compiles in memory at once for no gain, and
   * building the main artifact last leaves `out/` holding the
   * production-shaped bundle `pnpm budgets` measures at the end of the chain.
   *
   * Each build writes straight to its own destination via BUILD_OUT_DIR, so
   * there is no longer a moment where both artifacts are the same `out/` and
   * one has to be copied aside before the other overwrites it. Both are then
   * served from one shell; Playwright spawns this detached and kills the
   * process group, so the backgrounded server goes down with the foreground
   * one.
   */
  webServer: {
    command: [
      // node rather than `rm -rf`: same effect, no shell-portability question,
      // and it is a no-op on the first run instead of an error. Scoped to this
      // lane's own base, so a concurrent lane's artifacts are never in range.
      `node -e "require('node:fs').rmSync('${LANE_OUT}',{recursive:true,force:true})"`,
      `${E2E_COHORT_ENV} BUILD_OUT_DIR=${COHORT_OUT} node scripts/build-isolated.mjs`,
      `${E2E_BUILD_ENV} BUILD_OUT_DIR=${MAIN_OUT} node scripts/build-isolated.mjs`,
      `(node scripts/serve-static.mjs ${COHORT_OUT} ${COHORT_PORT} & node scripts/serve-static.mjs ${MAIN_OUT} ${E2E_PORT})`,
    ].join(" && "),
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 480_000,
  },
});
