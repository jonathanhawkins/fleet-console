import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";

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

// -- the URLs ----------------------------------------------------------------
/**
 * Every copy of the deployed URL, checked against the one copy code reads.
 *
 * `SITE_URL` is not just a link: `metadataBase` derives the preview card's
 * absolute image URLs from it, so a stale value serves a card that 404s — a
 * failure whose only symptom is that the link looks dead when someone shares
 * it. The other copies live in prose and in CI config and cannot import a
 * constant, so they drift independently.
 *
 * This check does not know the right URL. It knows they have to agree, which
 * is the thing that breaks when the project is renamed or the repo moves: one
 * place gets edited and the rest go on naming a host that no longer answers.
 */
const urlFailures = failures.length;
const CONSTANTS = "lib/constants.ts";
const siteUrl = readFileSync(CONSTANTS, "utf8").match(
  /export const SITE_URL = "([^"]+)"/,
)?.[1];

if (siteUrl === undefined) {
  failures.push(`site URL: ${CONSTANTS} no longer declares SITE_URL`);
} else {
  const host = new URL(siteUrl).host;
  // Cloudflare Pages serves <project>.pages.dev, so the deploy's --project-name
  // and the hostname are the same fact written twice.
  const project = host.split(".")[0];

  // Prose and config copies of the host, wherever they appear.
  for (const file of ["README.md", "docs/walkthrough.md", ".github/workflows/ci.yml"]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const hosts = new Set(text.match(/[a-z0-9-]+\.pages\.dev/g) ?? []);
    for (const found of hosts) {
      if (found !== host) {
        failures.push(
          `site URL: ${file} points at ${found}, but ${CONSTANTS} says ${host}`,
        );
      }
    }
  }

  // The deploy publishes to a project name; a mismatch deploys somewhere real
  // and serves the demo from somewhere else.
  const workflow = existsSync(".github/workflows/ci.yml")
    ? readFileSync(".github/workflows/ci.yml", "utf8")
    : "";
  const deployed = workflow.match(/--project-name (\S+)/)?.[1];
  if (deployed !== undefined && deployed !== project) {
    failures.push(
      `site URL: CI deploys --project-name ${deployed}, which does not serve ${host}`,
    );
  }

  if (!README.includes(siteUrl)) {
    failures.push(`site URL: the README never links ${siteUrl}`);
  }

  if (failures.length === urlFailures) notes.push(`site URL: ${host} everywhere`);
}

// -- the repo slug -----------------------------------------------------------
/**
 * The CI badge names a repository. Moved to a new one, it keeps rendering —
 * the badge of the old repo, green forever, describing nothing.
 *
 * The truth is whatever remote this checkout actually has (`GITHUB_REPOSITORY`
 * on a runner). With neither, there is nothing to compare against and the
 * check skips rather than guesses.
 */
const slug = (() => {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return remote.trim().match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {
    return null;
  }
})();

if (slug === null) {
  notes.push("repo slug: skipped (no git remote and no GITHUB_REPOSITORY)");
} else {
  const named = new Set(
    [...README.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/actions/g)].map((m) => m[1]),
  );
  const wrong = [...named].filter((n) => n !== slug);
  if (wrong.length > 0) {
    failures.push(
      `repo slug: the README badge names ${wrong.join(", ")}, this repo is ${slug}`,
    );
  } else if (named.size > 0) {
    notes.push(`repo slug: ${slug}`);
  } else {
    failures.push("repo slug: the README no longer carries a CI badge");
  }
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
