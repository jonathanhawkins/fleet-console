import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { gzBytes, initialJs } from "./measure.mjs";
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

/**
 * Two kilobytes, because the same commit does not gzip to the same size under
 * every toolchain: a newer node's zlib measures maplibre 0.9 KB heavier than an
 * older one and three 0.9 KB heavier again, on identical sources. A tighter
 * band fails on whichever node the runner installed rather than on a
 * regression, which is the wrong way for a gate to be wrong. The drift these
 * exist to catch — a chunk quietly acquiring a dependency, a table left quoting
 * a build two months gone — is tens of kilobytes, not one.
 */
const BAND_KB = 2;

/**
 * The model gets a wider band than the chunks, because its gzip size is the one
 * number here that turns on which zlib compressed it, not on what was built.
 * Node's bundled zlib changed between 22.22.2 and 22.23.2 (1.2.12 to 1.3.1) and
 * the same 200 KB binary comes out 3.9 KB heavier under the newer one — on one
 * machine, where the JS chunks move under a kilobyte. Six kilobytes covers that
 * and still catches the twenty a grown model would add.
 */
const MODEL_BAND_KB = 6;

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
  // The same string the e2e uses to recognise machine-space code on the wire,
  // so the number the README prints and the chunk the spec watches for cannot
  // come to mean different things.
  {
    label: "machine space",
    needle: "SCANNING ACTUATOR BUS",
    pattern: /machine space \(([\d.]+) KB gz\)/,
  },
];

/** What each marker actually weighed, for the rows that are sums of them. */
const lazyKb = {};

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
    lazyKb[label] = measured;
    const claimed = quoted(pattern, label);
    if (claimed === null) continue;
    if (Math.abs(claimed - measured) > BAND_KB) {
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

// -- the budget table --------------------------------------------------------
/**
 * The rows the README prints, against the build it claims to describe.
 *
 * `check-budgets.mjs` fails a route that crosses the PRD ceiling, and that is
 * the check that matters — but nothing failed when a route got *lighter* and
 * the table went on quoting the heavier number. That is the drift that
 * actually happened here, and it is the worse direction for a repo whose
 * argument is its receipts: a reader who re-measures finds the numbers do not
 * match, and has no way to tell which of the two is the lie. Measured through
 * measure.mjs, so this and the budget gate cannot disagree about the method.
 */
const TABLE = [
  {
    label: "fleet page initial JS",
    html: "index.html",
    pattern: /Fleet page initial JS < 200 KB gz\s*\|\s*\*\*([\d.]+) KB\*\*/,
  },
  {
    label: "unit page initial JS",
    html: join("unit", "N-01.html"),
    pattern: /Unit page initial JS < 200 KB gz\s*\|\s*\*\*([\d.]+) KB\*\*/,
  },
];

if (existsSync(join(OUT, "index.html"))) {
  for (const { label, html, pattern } of TABLE) {
    const measured = initialJs(OUT, html).bytes / 1024;
    const claimed = quoted(pattern, label);
    if (claimed === null) continue;
    if (Math.abs(claimed - measured) > BAND_KB) {
      failures.push(
        `${label}: README says ${claimed.toFixed(1)} KB gz, measured ${measured.toFixed(1)} KB gz`,
      );
    } else {
      notes.push(`${label}: ${measured.toFixed(1)} KB gz`);
    }
  }

  /**
   * The component view is the one row that is a sum: the three + R3F chunks
   * plus the model they load. Neither half is gated on its own, so a model
   * that grows by twenty kilobytes lands entirely inside a number nobody
   * rechecks.
   */
  const model = join(OUT, "models", "chassis-silhouette.glb");
  const three = lazyKb["three + R3F"];
  if (existsSync(model) && three !== undefined) {
    const measured = three + gzBytes(model) / 1024;
    const claimed = quoted(
      /Component view \(three \+ GLB\) < 500 KB gz\s*\|\s*([\d.]+) KB/,
      "component view",
    );
    if (claimed !== null) {
      if (Math.abs(claimed - measured) > MODEL_BAND_KB) {
        failures.push(
          `component view: README says ${claimed.toFixed(1)} KB gz, measured ${measured.toFixed(1)} KB gz`,
        );
      } else {
        notes.push(`component view: ${measured.toFixed(1)} KB gz`);
      }
    }
  }
} else {
  notes.push(`budget table: skipped (no export; run \`pnpm build:static\` first)`);
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
 * The authority is not this repo. Cloudflare assigns the hostname when the
 * Pages project is created, and `wrangler pages project list` is the only
 * place it can be read — so this checks that every copy here agrees with
 * `SITE_URL`, and leaves whether `SITE_URL` matches the real project to the
 * one command that can answer it. What it catches is the thing that actually
 * breaks on a rename or a move: one place gets edited and the rest go on
 * naming a host that no longer answers.
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
  const label = host.split(".")[0];

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
  // Pages serves <project>.pages.dev — except when that name was already
  // taken, where Cloudflare appends a suffix and the project answers on
  // <project>-<suffix>.pages.dev instead. Requiring an exact match would fail
  // a correct deploy, so the label has to be the project name or the project
  // name plus a suffix. Naming a different project still fails.
  const deployed = workflow.match(/--project-name (\S+)/)?.[1];
  if (deployed !== undefined && label !== deployed && !label.startsWith(`${deployed}-`)) {
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
