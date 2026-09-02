import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard for the `sideEffects` field in package.json.
 *
 * That field is what lets Turbopack drop a re-exported module nobody used —
 * it is the whole reason the console barrel stopped putting every component
 * in every route's initial JS (20 KB gz off `/`, 12 KB off `/unit`). The
 * price is that it is a PROMISE: "importing any of our files for a binding
 * you then don't use is safe to erase". A module that does real work at
 * import time breaks that promise, and it breaks it silently — `next dev`
 * does not apply the optimization, so the app is only wrong in production.
 *
 * This test makes the promise checkable. It cannot see every side effect (a
 * top-level statement inside an otherwise-used module needs a parser and is
 * harmless anyway, since a used module is never dropped). What it catches is
 * the shape that actually loses work: a BARE import — `import "./thing"` with
 * no bindings — whose whole purpose is the side effect, and which the
 * optimizer will therefore delete unless the file is declared.
 *
 * If this fails: either the new import has no side effect (import a binding
 * from it instead) or it does (add its repo-relative path to `sideEffects`).
 */

const repoRoot = resolve(import.meta.dirname, "..");
const SOURCE_DIRS = ["app", "components", "lib", "sim"];

interface BareImport {
  file: string;
  specifier: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** `import "x";` / `import 'x';` — an import with no bindings at all. */
const BARE_IMPORT = /^[ \t]*import[ \t]+["']([^"']+)["'][ \t]*;?[ \t]*$/gm;

const bareImports: BareImport[] = SOURCE_DIRS.flatMap((dir) =>
  sourceFiles(join(repoRoot, dir)).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(BARE_IMPORT)].map((match): BareImport => ({
      file: relative(repoRoot, file),
      specifier: match[1]!,
    })),
  ),
);

const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  sideEffects?: string[];
};
const declared = packageJson.sideEffects ?? [];
/** Entries naming one of our files, as opposed to the `*.css` globs. */
const declaredFiles = declared.filter((entry) => !entry.includes("*"));

describe("package.json sideEffects", () => {
  it("is declared as a list (never `false`, never absent)", () => {
    // `true`/absent would silently give the 20 KB back; `false` would erase the
    // CSS imports along with everything else.
    expect(Array.isArray(declared)).toBe(true);
    expect(declared).toContain("**/*.css");
  });

  it("declares every file a bare import exists for", () => {
    const undeclared = bareImports.filter(({ file, specifier }) => {
      // CSS in any package — ours via the globs, a dependency's via its own
      // package.json. Either way this field is not what decides it.
      if (specifier.endsWith(".css")) return false;
      // A bare package specifier is that package's promise, not ours.
      if (!specifier.startsWith(".")) return false;
      const target = relative(repoRoot, resolve(join(repoRoot, file), "..", specifier));
      return !declaredFiles.some(
        (entry) => target === entry || target.startsWith(`${entry}.`),
      );
    });
    expect(undeclared).toEqual([]);
  });

  it("names only files that still exist", () => {
    // A rename that leaves a stale entry behind is a promise about nothing,
    // and hides the moment the real module stopped being declared.
    for (const entry of declaredFiles) {
      expect(
        statSync(join(repoRoot, entry), { throwIfNoEntry: false }),
        `sideEffects names ${entry}, which no longer exists`,
      ).toBeDefined();
    }
  });
});
