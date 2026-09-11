import { join, resolve } from "node:path";
import { initialJs } from "./measure.mjs";

/**
 * Bundle-budget guard. Zero-dep, CI-shaped.
 *
 * The console barrel + single CSS chunk deliberately concentrate growth into
 * every route's shared initial payload — the exact mechanism by which classic
 * zod (66 KB gz) once sat on every route until caught by hand. This script
 * makes that class of regression fail a machine instead of an eyeball.
 *
 * Method (identical to docs/perf.md) lives in measure.mjs, shared with
 * check-receipts.mjs so the gate and the README cannot disagree about what the
 * number means. Budgets sit AT the PRD §7 limit (200 KB gz), not at current
 * usage, so headroom stays spendable without ratcheting.
 *
 * Requires an existing static export — it never builds one, so it can't mask
 * what actually shipped. Run `pnpm build:static` first, or let `pnpm e2e` do
 * it: this script is appended to the e2e chain (package.json), where
 * Playwright's webServer has just built and served the same `out/`.
 *
 * Usage: pnpm budgets   (exit 1: budget breach, missing build, or stale HTML)
 */

const OUT = resolve(process.argv[2] ?? "out");
const BUDGETS = [
  { route: "/", html: "index.html", budgetKb: 200 },
  { route: "/unit/N-01", html: join("unit", "N-01.html"), budgetKb: 200 },
];

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
let breached = false;
const rows = [];

for (const { route, html, budgetKb } of BUDGETS) {
  let measured;
  try {
    measured = initialJs(OUT, html);
  } catch (error) {
    console.error(
      `check-budgets: ${error.message}\n` +
        `No static export to measure. Run \`pnpm build:static\` first (or \`pnpm e2e\`, which builds one).`,
    );
    process.exit(1);
  }
  const { bytes: gzBytes, scripts } = measured;
  const pass = gzBytes <= budgetKb * 1024;
  if (!pass) breached = true;
  rows.push({
    route,
    scripts,
    "initial JS (gz)": kb(gzBytes),
    budget: `${budgetKb} KB`,
    headroom: kb(budgetKb * 1024 - gzBytes),
    verdict: pass ? "PASS" : "FAIL",
  });
}

console.table(rows);
if (breached) {
  console.error(
    "check-budgets: initial-JS budget exceeded (PRD §7: < 200 KB gz per route).",
  );
  process.exit(1);
}
