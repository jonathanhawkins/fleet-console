import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * What the two gates both have to mean by "initial JS".
 *
 * `check-budgets.mjs` fails a build that crosses the PRD's ceiling;
 * `check-receipts.mjs` fails a README that has stopped describing the build.
 * They are different questions about the same number, and a number measured
 * two ways is two numbers — so the method lives here and neither script owns
 * a copy of it.
 *
 * The method: every `<script src>` a modern browser executes, gzipped at level
 * 9 and summed. `nomodule` tags are skipped because a browser that supports ES
 * modules never requests them.
 */
export function initialJs(outDir, htmlPath) {
  const markup = readFileSync(join(outDir, htmlPath), "utf8");
  const srcs = new Set(
    [...markup.matchAll(/<script\b[^>]*>/g)]
      .filter(([tag]) => !/\bnomodule\b/i.test(tag))
      .map(([tag]) => /\bsrc="([^"]+)"/.exec(tag)?.[1])
      .filter((src) => src !== undefined),
  );
  let bytes = 0;
  for (const src of srcs) {
    bytes += gzipSync(readFileSync(join(outDir, src)), { level: 9 }).length;
  }
  return { bytes, scripts: srcs.size };
}

/** Gzipped weight of one file in the export — a model, an image, a chunk. */
export function gzBytes(path) {
  return gzipSync(readFileSync(path), { level: 9 }).length;
}
