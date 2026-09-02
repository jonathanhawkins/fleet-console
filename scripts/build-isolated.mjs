import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Isolated production build. Every `next build` used to share `.next`
 * with a running `next dev`, and every deploy build corrupted the live dev
 * cache (ENOENT `_buildManifest.js.tmp` — three occurrences, each costing a
 * manual `.next` move + dev restart).
 *
 * Config cannot fix this: under `output: "export"` Next reinterprets a custom
 * `distDir` as the EXPORT destination and force-resets the intermediate dir to
 * `.next` ("the user-configured distDir is actually the outDir" —
 * next/dist/export/utils.js), and the one prior attempt to move dev instead
 * (distDir override under turbopack dev) lost page-data. So isolation happens
 * at the working-directory level:
 *
 * 1. Mirror the source tree into a scratch workdir BESIDE the checkout
 * (sources are ~4 MB once docs and artifacts are excluded; the copy is
 * wiped and redone per build so it can never go stale). Beside, not under
 * tmpdir: turbopack requires every resolved file inside one root, and the
 * parent directory is the smallest root containing both the mirror and
 * the real node_modules — the documented monorepo shape (turbopack.root,
 * wired through BUILD_ISOLATED_ROOT in next.config.ts). Beside, not
 * inside the repo: a running dev server watches the repo tree, and a
 * build dumping a cache into it would spray watcher events at dev.
 * 2. Symlink the mirror's `node_modules` to the real install.
 * 3. Run `next build --turbopack` with the mirror as cwd. Its `.next` is
 * scratch-local — the workdir persists between runs, so turbopack keeps a
 * warm cache — and the repo's `.next` stays exclusively dev's.
 * 4. If the build produced a static export, replace the export destination
 * (`out/` unless BUILD_OUT_DIR says otherwise) with it — the only write
 * this script ever makes to the repo. `pnpm budgets`,
 * scripts/serve-static.mjs and both Playwright configs keep reading the
 * `out/` they always did.
 *
 * The scratch path is keyed to the repo path, so parallel-agent worktrees get
 * their own workdirs and cannot cross-corrupt. Two builds of the SAME checkout
 * used to collide there, though: the second build re-mirrored sources
 * and wiped `.next` under the first one, which surfaced as ENOENT on
 * `_ssgManifest.js` / `_buildManifest.js.tmp.*` in whichever build lost the
 * race — one agent build and one `pnpm e2e` webServer start, in one afternoon.
 * So the workdir is now claimed rather than assumed; see SLOTS below.
 *
 * Usage: node scripts/build-isolated.mjs [extra `next build` args]
 * (env passes through: STATIC_EXPORT, NEXT_PUBLIC_*, … — `pnpm build`,
 * `pnpm build:static` and the Playwright webServers all run through here)
 *
 * BUILD_OUT_DIR=<repo-relative dir> where a static export lands, default
 * `out`. Only `out` and paths under `.e2e-cohort/` are accepted — see
 * resolveOutDir. Playwright uses it to give concurrent e2e lanes their own
 * artifacts (playwright.config.ts, E2E_PORT_BASE).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The smallest directory containing the mirror AND the real node_modules. */
const isolationRoot = dirname(repoRoot);
/** Slot 0 — the stable, warm-cache workdir a lone build always gets. */
const stableScratch = join(
  isolationRoot,
  `.build-${basename(repoRoot)}-${createHash("sha1").update(repoRoot).digest("hex").slice(0, 10)}`,
);

/**
 * How many warm workdirs this checkout may keep. Concurrency beyond this still
 * works — it just falls back to a one-shot dir with a cold turbopack cache —
 * so the cap is a disk budget, not a concurrency limit. Each slot is ~30 MB.
 */
const SLOTS = 4;

/** `<stable>-p<pid>-<ms>`: the one-shot workdir, removed when its build ends. */
const ONE_SHOT = new RegExp(
  `^${basename(stableScratch).replace(/\./g, "\\.")}-p(\\d+)-\\d+$`,
);

/** Is the process that wrote this lock still running? */
function holderAlive(lockPath) {
  let pid;
  try {
    pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
  } catch {
    return false; // lock vanished between the EEXIST and the read
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return pidAlive(pid);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, just not ours to signal. ESRCH: gone.
    return err?.code === "EPERM";
  }
}

/**
 * Claim `dir` by atomically creating `<dir>.lock`. Returns the lock path, or
 * null if a live build already holds it. A lock whose writer has died is
 * stolen once — a build killed with SIGKILL must not poison the slot forever.
 *
 * The pid is written to a temp file and hard-linked into place rather than
 * opened `wx` and written after: `link()` publishes the name and the content in
 * one step, so the lock is never observable in the empty, pid-less state that
 * sits between an open and its write. That window was not theoretical — two
 * concurrent e2e lanes hit it, the second read an empty lock, concluded the
 * slot had no live owner, stole it, and both builds mirrored sources into the
 * same workdir (`EEXIST: mkdir …/.github`).
 */
function claim(dir) {
  const lockPath = `${dir}.lock`;
  const pending = `${lockPath}.${process.pid}.tmp`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(pending, String(process.pid));
      linkSync(pending, lockPath);
      return lockPath;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (attempt === 0 && !holderAlive(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // another build stole it first; the retry will find it held
        }
        continue;
      }
      return null;
    } finally {
      try {
        unlinkSync(pending);
      } catch {
        // never created, or already cleaned
      }
    }
  }
  return null;
}

/**
 * Remove one-shot workdirs whose build is gone. Deliberately narrower than
 * guardedRm: only a DIRECT child of the isolation root whose name is exactly
 * this checkout's one-shot pattern, and only when the pid it names is dead.
 * Sibling repos' scratch dirs (`.build-<other>-<hash>…`) cannot match.
 */
function sweepAbandoned() {
  let entries;
  try {
    entries = readdirSync(isolationRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = ONE_SHOT.exec(entry.replace(/\.lock$/, ""));
    if (!match || pidAlive(Number(match[1]))) continue;
    rmSync(join(isolationRoot, entry), { recursive: true, force: true });
  }
}

sweepAbandoned();

/** The claimed workdir, plus how to give it back. */
let scratch = null;
let lock = null;
let oneShot = false;
for (let slot = 0; slot < SLOTS && scratch === null; slot++) {
  const candidate = slot === 0 ? stableScratch : `${stableScratch}-s${slot}`;
  const claimed = claim(candidate);
  if (claimed) {
    scratch = candidate;
    lock = claimed;
  }
}
if (scratch === null) {
  // Every warm slot is busy. Correctness beats the cache: take a private dir.
  scratch = `${stableScratch}-p${process.pid}-${Date.now()}`;
  lock = claim(scratch);
  oneShot = true;
}

let released = false;
function release() {
  if (released) return;
  released = true;
  try {
    if (lock) unlinkSync(lock);
  } catch {
    // already gone
  }
  if (oneShot) rmSync(scratch, { recursive: true, force: true });
}
process.on("exit", release);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    release();
    process.exit(1);
  });
}

/**
 * Where a static export lands. `out` by default — `pnpm budgets`,
 * scripts/serve-static.mjs and the Playwright configs all read that — and
 * otherwise a path under `.e2e-cohort/`, which is the one directory already
 * ignored by git, eslint and the source mirror. Nothing else is accepted,
 * because this path is handed to a recursive delete.
 */
function resolveOutDir() {
  const requested = process.env.BUILD_OUT_DIR;
  if (!requested) return join(repoRoot, "out");
  const abs = resolve(repoRoot, requested);
  if (
    abs !== join(repoRoot, "out") &&
    !abs.startsWith(join(repoRoot, ".e2e-cohort") + "/")
  ) {
    console.error(
      `build-isolated: refusing BUILD_OUT_DIR=${requested} — must be "out" or under ".e2e-cohort/".`,
    );
    process.exit(1);
  }
  return abs;
}

const outDir = resolveOutDir();

/** Never mirrored: artifacts, VCS/agent state, and heavy non-build content. */
const NEVER_MIRROR = new Set([
  ".DS_Store",
  ".claude",
  ".e2e-cohort",
  ".git",
  ".next",
  ".next-build",
  ".wrangler",
  "blob-report",
  "coverage",
  "docs",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
  "tsconfig.tsbuildinfo",
]);

/** Scratch-local state that survives the re-mirror (cache + symlink). */
const SCRATCH_KEEP = new Set([".next", "node_modules", "out"]);

/**
 * Guarded rm: this script only ever deletes inside its claimed scratch dir, or
 * the export destination — which resolveOutDir has already restricted to the
 * repo's `out/` or a path under `.e2e-cohort/`.
 */
function guardedRm(path) {
  if (!path.startsWith(scratch + "/") && path !== scratch && path !== outDir) {
    throw new Error(`build-isolated: refusing to remove ${path}`);
  }
  rmSync(path, { recursive: true, force: true });
}

mkdirSync(scratch, { recursive: true });

// Fresh source mirror (copy, never symlink — the build must not write home).
// Hidden directories are local state (VCS, tooling, caches), never sources.
const sources = readdirSync(repoRoot).filter(
  (entry) =>
    !NEVER_MIRROR.has(entry) &&
    !(entry.startsWith(".") && lstatSync(join(repoRoot, entry)).isDirectory()),
);
for (const entry of sources) {
  guardedRm(join(scratch, entry));
  cpSync(join(repoRoot, entry), join(scratch, entry), {
    recursive: true,
    filter: (src) => basename(src) !== ".DS_Store",
  });
}

// Sweep scratch entries whose source no longer exists (renamed/deleted dirs).
const liveEntries = new Set(sources);
for (const entry of readdirSync(scratch)) {
  if (!liveEntries.has(entry) && !SCRATCH_KEEP.has(entry))
    guardedRm(join(scratch, entry));
}

// The one symlink: the mirror shares the real dependency install.
const linkPath = join(scratch, "node_modules");
const realModules = join(repoRoot, "node_modules");
try {
  if (readlinkSync(linkPath) !== realModules) throw new Error("stale link");
} catch {
  if (lstatSync(linkPath, { throwIfNoEntry: false })) guardedRm(linkPath);
  symlinkSync(realModules, linkPath, "dir");
}

// A stale export must never masquerade as this build's output.
guardedRm(join(scratch, "out"));

const nextBin = join(realModules, ".bin", "next");
if (!existsSync(nextBin)) {
  console.error(
    "build-isolated: node_modules/.bin/next not found — run `pnpm install` first.",
  );
  process.exit(1);
}

console.log(
  `build-isolated: building in ${scratch}${oneShot ? " (one-shot: all warm slots busy)" : ""} (repo .next untouched)`,
);
const { status, signal } = spawnSync(
  nextBin,
  ["build", "--turbopack", ...process.argv.slice(2)],
  {
    cwd: scratch,
    stdio: "inherit",
    env: { ...process.env, BUILD_ISOLATED_ROOT: isolationRoot },
  },
);
if (signal) {
  console.error(`build-isolated: next build killed by ${signal}`);
  process.exit(1);
}

if (status === 0 && existsSync(join(scratch, "out"))) {
  guardedRm(outDir);
  mkdirSync(dirname(outDir), { recursive: true });
  cpSync(join(scratch, "out"), outDir, { recursive: true });
  console.log(`build-isolated: static export -> ${relative(repoRoot, outDir)}/`);
}

process.exit(status ?? 1);
