import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { readdirSync } from "node:fs";

/**
 * The README's numbers, checked against the thing they describe.
 *
 * `check-budgets.mjs` exists because a bundle regression should fail a machine
 * rather than an eyeball. Everything else the README quotes — the size of the
 * suite, the weight of the lazy chunks — was typed by hand, and drifted: it
 * claimed 1,512 specs across 96 files while the suite ran 1,526 across 97, and
 * quoted maplibre 2 KB light. Numbers a repo prints about itself are the last
 * place drift should be allowed, because they are the part a reader cannot
 * verify without doing the work again.
 *
 * So the README stays hand-written and this reads it back. Each check names
 * the phrase it is matching, so a failure says which sentence to edit.
 *
 * Usage: node scripts/check-receipts.mjs [out]   (exit 1 on drift)
 */

const OUT = resolve(process.argv[2] ?? "out");
const README = readFileSync("README.md", "utf8");
const failures = [];
const notes = [];

/** Read a number out of the README by the sentence around it. */
function quoted(pattern, label) {
  const m = README.match(pattern);
  if (!m) {
    failures.push(`${label}: the README no longer contains this claim (${pattern})`);
    return null;
  }
  return Number(m[1].replace(/,/g, ""));
}

// -- the suite ---------------------------------------------------------------
// Written by `pnpm test` (vitest's json reporter). Absent when the checker is
// run on its own, which is not a failure — it just skips this pair.
const SUMMARY = ".vitest-summary.json";
if (existsSync(SUMMARY)) {
  const summary = JSON.parse(readFileSync(SUMMARY, "utf8"));
  const tests = summary.numTotalTests;
  // `testResults` is one entry per file. `numTotalTestSuites` counts describe
  // blocks, which is a different (and much larger) number.
  const files = summary.testResults.length;

  const claimedTests = quoted(/([\d,]+) specs across/, "spec count");
  const claimedFiles = quoted(/specs across ([\d,]+) files/, "test file count");
  if (claimedTests !== null && claimedTests !== tests) {
    failures.push(`spec count: README says ${claimedTests}, the suite ran ${tests}`);
  }
  if (claimedFiles !== null && claimedFiles !== files) {
    failures.push(`test file count: README says ${claimedFiles}, the suite ran ${files}`);
  }
  if (claimedTests === tests && claimedFiles === files) {
    notes.push(`suite: ${tests} specs across ${files} files`);
  }
} else {
  notes.push(`suite: skipped (no ${SUMMARY}; run \`pnpm test\` first)`);
}

// -- the lazy chunks ---------------------------------------------------------
/**
 * Each lazy bundle is identified by a string only its own code contains, the
 * same technique the golden-path spec uses to recognise the machine chunk
 * without pinning a build hash.
 */
const MARKERS = [
  { label: "maplibre", needle: "maplibregl", pattern: /maplibre \(([\d.]+) KB gz\)/ },
  {
    label: "three + R3F",
    needle: "WebGLRenderer",
    pattern: /three \+ R3F \(([\d.]+) KB gz\)/,
  },
];

const chunkDir = join(OUT, "_next", "static", "chunks");
if (existsSync(chunkDir)) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".js")) files.push(path);
    }
  };
  walk(chunkDir);

  for (const { label, needle, pattern } of MARKERS) {
    let bytes = 0;
    for (const file of files) {
      const raw = readFileSync(file);
      if (raw.includes(needle)) bytes += gzipSync(raw, { level: 9 }).length;
    }
    if (bytes === 0) {
      failures.push(`${label}: no chunk contains "${needle}" — the marker is stale`);
      continue;
    }
    const measured = bytes / 1024;
    const claimed = quoted(pattern, label);
    if (claimed === null) continue;
    // Two kilobytes, because the same commit does not gzip to the same size
    // everywhere: CI measured maplibre 0.9 KB heavier than this laptop and
    // three 0.9 KB heavier again, on identical sources. A tighter band fails
    // on the runner rather than on a regression, which is the wrong way for a
    // gate to be wrong. The drift this exists to catch — a chunk quietly
    // acquiring a dependency — is tens of kilobytes, not one.
    if (Math.abs(claimed - measured) > 2) {
      failures.push(
        `${label}: README says ${claimed.toFixed(1)} KB gz, measured ${measured.toFixed(1)} KB gz`,
      );
    } else {
      notes.push(`${label}: ${measured.toFixed(1)} KB gz`);
    }
  }
} else {
  notes.push(`chunks: skipped (no ${chunkDir}; run \`pnpm build:static\` first)`);
}

// -- report ------------------------------------------------------------------
for (const note of notes) console.log(`  ok   ${note}`);
if (failures.length > 0) {
  console.error("\ncheck-receipts: the README describes a build that is not this one.\n");
  for (const failure of failures) console.error(`  drift  ${failure}`);
  console.error("\nEdit the sentence, or change the thing it describes.");
  process.exit(1);
}
console.log("\ncheck-receipts: the README's numbers match the build.");
