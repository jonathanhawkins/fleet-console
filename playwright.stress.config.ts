import { defineConfig, devices } from "@playwright/test";

/**
 * The 500-unit stress lane — a SEPARATE config on purpose.
 *
 * Playwright's webServer is per-config, and the main suite's build is the
 * 8-unit deploy artifact; this one inlines NEXT_PUBLIC_SIM_UNITS=500 into the
 * same static-export/WorkerTransport build. Keeping it out of
 * playwright.config.ts keeps `pnpm e2e` measuring the artifact that deploys —
 * this lane is a receipt, run on demand:
 *
 * pnpm e2e:stress
 *
 * Same pinned seed and compressed storyline as the main lane, so the N-07
 * incident (the beat the spec asserts) lands on the same schedule it does in
 * the golden path. Chromium only: the stress spec proves scale properties
 * (virtualization bounds, alert surfacing, click-through), not browser
 * matrix coverage — the golden path owns that.
 */

/**
 * Overridable for the same reason as the main config's E2E_PORT_BASE:
 *
 * E2E_STRESS_PORT=4295 pnpm e2e:stress
 *
 * The default is unchanged, and is worth knowing about: 4272 is also the main
 * config's cohort port, so `pnpm e2e` and `pnpm e2e:stress` cannot both run at
 * their defaults. Moving this one is how you run them together.
 */
const DEFAULT_STRESS_PORT = 4272;
const STRESS_PORT =
  Number.parseInt(process.env.E2E_STRESS_PORT ?? "", 10) || DEFAULT_STRESS_PORT;
/** Same rule as the main config: off the shared `out/` unless it is the default. */
const STRESS_OUT =
  STRESS_PORT === DEFAULT_STRESS_PORT ? "out" : `.e2e-cohort/stress-${STRESS_PORT}`;

const STRESS_BUILD_ENV = [
  "STATIC_EXPORT=1",
  "NEXT_PUBLIC_TRANSPORT=worker",
  "NEXT_PUBLIC_SIM_SEED=7",
  "NEXT_PUBLIC_SIM_PREROLL_MS=0",
  "NEXT_PUBLIC_SIM_CHAIN=0",
  "NEXT_PUBLIC_SIM_UNITS=500",
  "NEXT_PUBLIC_SIM_ONSET_MS=6000",
  "NEXT_PUBLIC_SIM_AMBER_MS=9000",
  "NEXT_PUBLIC_SIM_RED_MS=12000",
  // Same rationale as playwright.config.ts: the N-03 self-recovery storyline
  // stays parked outside the test window so the asserted alert feed is exact.
  "NEXT_PUBLIC_SIM_N03_BLOCK_MS=3600000",
  "NEXT_PUBLIC_SIM_N03_CLEAR_MS=3640000",
  "NEXT_PUBLIC_SIM_DIAG_SCALE=0.25",
].join(" ");

export default defineConfig({
  testDir: "./e2e",
  testMatch: /stress\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${STRESS_PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // The desk lane's viewport: tall enough that the virtualization
        // assertion (bounded row count) is meaningfully below the fleet size.
        viewport: { width: 1280, height: 1100 },
      },
    },
  ],
  webServer: {
    command: `${STRESS_BUILD_ENV} BUILD_OUT_DIR=${STRESS_OUT} node scripts/build-isolated.mjs && node scripts/serve-static.mjs ${STRESS_OUT} ${STRESS_PORT}`,
    url: `http://localhost:${STRESS_PORT}`,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
