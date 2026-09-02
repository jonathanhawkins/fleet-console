import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Static file server for the exported `out/` bundle — what Playwright (and
 * perf probes) run the demo against.
 *
 * Dependency-free on purpose: the e2e webServer must come up the same way on
 * a cold CI box as on this machine, with no dlx cache or registry fetch in the
 * startup path. It mirrors the resolution rules the deploy target (Cloudflare
 * Pages) applies to an exported Next site, so the tests exercise the same URL
 * shapes production serves:
 *
 *   /              -> index.html
 *   /unit/N-07     -> unit/N-07.html   (extensionless -> .html)
 *   /system/       -> system.html      (or system/index.html)
 *   anything else  -> 404.html, status 404
 *
 * No compression and Cache-Control: no-store by default — every run is a cold
 * load, so request bookkeeping in the e2e (which chunks were fetched when)
 * means what it says.
 *
 * `--gzip` opts in to Content-Encoding: gzip for text responses, and exists for
 * exactly one caller: a Lighthouse run under the mobile preset's simulated
 * 1.6 Mbps link. Uncompressed, this page's ~700 KB of raw JS is ~3.5 s of
 * transfer on that link and swamps every other number in the report — while the
 * deploy target (Cloudflare Pages) has served it compressed all along. Off by
 * default, because the e2e wants the plain bytes it counts.
 *
 * Usage: node scripts/serve-static.mjs [dir=out] [port=4173] [--gzip]
 */

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

const root = resolve(positional[0] ?? "out");
const port = Number.parseInt(positional[1] ?? "4173", 10);
const compress = flags.has("--gzip");

/** What Pages compresses: text, not images, fonts or the GLB. */
const COMPRESSIBLE = /^(text\/|application\/json|.*\/javascript|image\/svg)/;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** Candidate files for a URL path, in Pages resolution order. */
function candidates(pathname) {
  if (pathname.endsWith("/"))
    return [`${pathname}index.html`, pathname.replace(/\/+$/, "") + ".html"];
  if (extname(pathname) !== "") return [pathname];
  return [`${pathname}.html`, `${pathname}/index.html`];
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  for (const candidate of candidates(pathname === "/" ? "/index.html" : pathname)) {
    // normalize + prefix check: nothing outside the export dir is servable.
    const file = normalize(join(root, candidate));
    if (!file.startsWith(root)) break;
    try {
      let body = await readFile(file);
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      const headers = { "content-type": type, "cache-control": "no-store" };
      if (
        compress &&
        COMPRESSIBLE.test(type) &&
        (req.headers["accept-encoding"] ?? "").includes("gzip")
      ) {
        body = gzipSync(body, { level: 9 });
        headers["content-encoding"] = "gzip";
        headers.vary = "accept-encoding";
      }
      res.writeHead(200, headers);
      res.end(body);
      return;
    } catch {
      // try the next candidate
    }
  }

  try {
    const body = await readFile(join(root, "404.html"));
    res.writeHead(404, { "content-type": TYPES[".html"], "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

server.listen(port, () => {
  console.log(`serving ${root} on http://localhost:${port}`);
});
