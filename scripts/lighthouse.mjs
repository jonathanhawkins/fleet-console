import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lighthouse, { desktopConfig } from "lighthouse";
import { launch } from "chrome-launcher";

/**
 * Lighthouse gate. Zero-config, CI-shaped, and it leaves a receipt.
 *
 * Serves the static export the way the deploy target does (compressed text,
 * `scripts/serve-static.mjs --gzip`), runs the desktop preset against the two
 * routes the budget script already guards, writes each full report to
 * `docs/evidence/lighthouse/<route>.json` (the median-performance run of three;
 * one on CI, or `LH_RUNS`), prints the four category scores,
 * and exits 1 when any score is below the bar:
 *
 *   performance      >= 90
 *   accessibility    == 100
 *   best-practices   == 100
 *   seo              == 100
 *
 * The stored JSON is the claim — docs/perf.md and the README point at it
 * rather than quoting numbers from memory — and CI runs this same script after
 * the budgets so the claim cannot go stale without a red job. Screenshots are
 * left out of the report (they are base64 and dwarf everything else); every
 * audit, metric and score is kept, so the file loads in the Lighthouse Viewer.
 *
 * Chrome resolution, in order: `CHROME_PATH`, the Chromium Playwright installed
 * (the e2e job has already run `playwright install chromium`), then
 * chrome-launcher's own discovery of a locally installed Chrome.
 *
 * Requires an existing export — it never builds one, so it can't measure a
 * build that didn't ship. Run `pnpm build:static` first, or let `pnpm e2e`.
 *
 * Usage: node scripts/lighthouse.mjs [dir=out]   (env: LH_PORT, CHROME_PATH)
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.argv[2] ?? "out");
const PORT = Number.parseInt(process.env.LH_PORT ?? "4180", 10);
const EVIDENCE = join(ROOT, "docs", "evidence", "lighthouse");

const ROUTES = [
  { route: "/", file: "index.json" },
  { route: "/unit/N-01", file: "unit-N-01.json" },
];

/**
 * Performance is gated on a laptop (documented hardware, docs/perf.md) and
 * reported on CI: a shared runner's main thread with software WebGL swings
 * total-blocking-time by an order of magnitude between runs, so a score gate
 * there would measure the runner, not the page. The deterministic categories
 * are gated everywhere.
 */
const GATED_LOCALLY_ONLY = new Set(process.env.CI ? ["performance"] : []);

const BAR = {
  performance: 90,
  accessibility: 100,
  "best-practices": 100,
  seo: 100,
};

if (!existsSync(join(OUT, "index.html"))) {
  console.error(
    `lighthouse: missing ${join(OUT, "index.html")}\n` +
      `No static export to measure. Run \`pnpm build:static\` first (or \`pnpm e2e\`, which builds one).`,
  );
  process.exit(1);
}

/** Where Chrome is. Playwright's copy is what CI has; a laptop has its own. */
async function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const { chromium } = await import("@playwright/test");
    const path = chromium.executablePath();
    if (existsSync(path)) return path;
  } catch {
    // Playwright not installed here; fall through to discovery.
  }
  return undefined; // chrome-launcher looks for an installed Chrome
}

/** Serve `out/` on PORT and resolve once it answers. */
function serve() {
  const child = spawn(
    process.execPath,
    [join(ROOT, "scripts", "serve-static.mjs"), OUT, String(PORT), "--gzip"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const origin = `http://localhost:${PORT}`;
  const ready = (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${origin}/`);
        if (res.ok) return origin;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`lighthouse: static server did not answer on ${origin}`);
  })();
  return { child, ready };
}

const score = (lhr, id) => Math.round((lhr.categories[id]?.score ?? 0) * 100);
const ms = (lhr, id) => `${Math.round(lhr.audits[id]?.numericValue ?? 0)} ms`;
const s = (lhr, id) => `${((lhr.audits[id]?.numericValue ?? 0) / 1000).toFixed(1)} s`;

const server = serve();
let chrome;
let failed = false;
const rows = [];

try {
  const origin = await server.ready;
  chrome = await launch({
    chromePath: await chromePath(),
    // No --disable-gpu: the fleet map is WebGL, and without a GL context
    // MapLibre throws at mount and Next renders its error page — a document
    // with no lang and no main, which scores 73 on accessibility and says
    // nothing about the product. SwiftShader is the software GL headless Chrome
    // falls back to (and all a CI runner has); asking for it explicitly makes
    // the laptop receipt and the CI receipt the same measurement.
    chromeFlags: [
      "--headless=new",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      ...(process.env.CI ? ["--no-sandbox"] : []),
    ],
  });

  mkdirSync(EVIDENCE, { recursive: true });

  // Performance is noisy run to run (main-thread contention moves TBT by
  // 100+ ms on the same build), so each route is measured RUNS times and the
  // median-performance run is the one kept and gated. CI reports a single run.
  const RUNS = Number.parseInt(process.env.LH_RUNS ?? "", 10) || (process.env.CI ? 1 : 3);

  for (const { route, file } of ROUTES) {
    const runs = [];
    for (let i = 0; i < RUNS; i += 1) {
      const result = await lighthouse(
        `${origin}${route}`,
        {
          port: chrome.port,
          output: "json",
          logLevel: "error",
          onlyCategories: Object.keys(BAR),
          disableFullPageScreenshot: true,
          skipAudits: ["screenshot-thumbnails", "final-screenshot"],
        },
        desktopConfig,
      );
      if (!result) throw new Error(`lighthouse: no result for ${route}`);
      if (result.lhr.runtimeError) {
        throw new Error(`lighthouse: ${route}: ${result.lhr.runtimeError.message}`);
      }
      runs.push(result.lhr);
    }
    runs.sort((a, b) => score(a, "performance") - score(b, "performance"));
    const lhr = runs[Math.floor(runs.length / 2)];

    writeFileSync(join(EVIDENCE, file), JSON.stringify(lhr, null, 2) + "\n");

    const scores = Object.fromEntries(Object.keys(BAR).map((id) => [id, score(lhr, id)]));
    const pass = Object.entries(BAR).every(
      ([id, bar]) => GATED_LOCALLY_ONLY.has(id) || scores[id] >= bar,
    );
    if (!pass) failed = true;
    rows.push({
      route,
      ...scores,
      FCP: s(lhr, "first-contentful-paint"),
      LCP: s(lhr, "largest-contentful-paint"),
      TBT: ms(lhr, "total-blocking-time"),
      CLS: (lhr.audits["cumulative-layout-shift"]?.numericValue ?? 0).toFixed(3),
      verdict: pass ? "PASS" : "FAIL",
      receipt: `docs/evidence/lighthouse/${file}`,
    });
  }
} finally {
  await chrome?.kill();
  server.child.kill();
}

console.table(rows);

// CI: the same table, as markdown, on the job summary next to the budgets.
if (process.env.GITHUB_STEP_SUMMARY) {
  const cols = Object.keys(rows[0]);
  const md = [
    `### Lighthouse (desktop preset, static export served gzip)`,
    ``,
    `| ${cols.join(" | ")} |`,
    `| ${cols.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${cols.map((c) => r[c]).join(" | ")} |`),
    ``,
    `Gate on CI: accessibility, best-practices, seo = 100. Performance (≥ ${BAR.performance}) is gated locally; the stored receipt is docs/evidence/lighthouse/.`,
    ``,
  ].join("\n");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

if (failed) {
  console.error(
    GATED_LOCALLY_ONLY.size
      ? "lighthouse: below the bar (accessibility, best-practices, seo = 100)."
      : `lighthouse: below the bar (performance ≥ ${BAR.performance}; accessibility, best-practices, seo = 100).`,
  );
  process.exit(1);
}
