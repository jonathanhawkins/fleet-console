import { spawn } from "node:child_process";
import { mkdir, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

/**
 * Recapture the README's evidence: the golden-path recording and the stills
 * the walkthrough points at.
 *
 * These assets existed for months with no way to remake them, so when the
 * default diagnostic changed they went on advertising a flow the product no
 * longer opens with. A screenshot nobody can regenerate is a claim that decays
 * silently, which is the same failure `check-receipts.mjs` exists to catch in
 * prose. This is the missing half of that: the pictures, remade from the same
 * artifact the tests run against.
 *
 *   pnpm build && node scripts/capture-evidence.mjs
 *
 * It drives `out/` — the exported bundle, served the way Cloudflare Pages
 * serves it — not the dev server, so what is recorded is what deploys. Video
 * is captured at 1520×950 and written down to 760×475, the size the README has
 * always embedded; stills are 1600×1000 at 2×, which is the 3200×2000 the
 * existing ones are.
 */

const OUT_DIR = resolve("docs/evidence");
const STILLS = join(OUT_DIR, "stills");
const PORT = Number(process.env.CAPTURE_PORT ?? 4399);
const BASE = `http://localhost:${PORT}`;
const VIDEO_SIZE = { width: 1520, height: 950 };
const STILL_VIEWPORT = { width: 1600, height: 1000 };

const sh = (cmd, args) =>
  new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`)),
    );
    p.on("error", fail);
  });

async function serve() {
  const server = spawn("node", ["scripts/serve-static.mjs", "out", String(PORT)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((ok, fail) => {
    const timer = setTimeout(
      () => fail(new Error("static server did not start")),
      10_000,
    );
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes(String(PORT))) {
        clearTimeout(timer);
        ok();
      }
    });
    server.on("exit", (code) => fail(new Error(`static server exited ${code}`)));
  });
  return server;
}

/**
 * Reach the knee fault without recording the wait for it.
 *
 * The footer's chapter jump replays the run and stops eight seconds short of
 * the act, which is exactly what a recording wants: the alert still *arrives*
 * on camera — the beat the whole first act is about — without half a minute of
 * a calm fleet in front of it.
 */
async function jumpToKneeFault(page) {
  const jump = page.locator('[data-slot="storyline-jump"]').getByRole("button", {
    name: /knee fault/i,
  });
  if ((await jump.count()) === 0) return false;
  await jump.click();
  return true;
}

/** The walk itself, shared by the recording and the stills. */
async function walk(page, { onBeat = async () => {} } = {}) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByText(/8 units/i).waitFor({ timeout: 20_000 });
  await jumpToKneeFault(page);

  const railRow = page
    .getByRole("link", { name: /N-07, Elm House\. (Attention|Alert)\./ })
    .and(page.locator('[data-slot="unit-card"]'));
  await railRow.waitFor({ timeout: 45_000 });
  await onBeat("fleet-alert", page);

  await railRow.click();
  await page
    .getByRole("heading", { name: "N-07", exact: true })
    .waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await onBeat("unit-incident", page);

  const banner = page.locator('[data-slot="incident-banner"]');
  await banner.getByRole("button", { name: "Run diagnostic" }).click();

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Diagnostic" }) });
  await panel.waitFor({ timeout: 15_000 });
  await panel.scrollIntoViewIfNeeded();
  // Mid-scan: channels arriving against their references.
  await page.waitForTimeout(9000);
  await onBeat("diagnostic-scanning", page, panel);

  await panel
    .getByRole("heading", { name: /Actuator A-07/ })
    .waitFor({ timeout: 40_000 });
  await page.waitForTimeout(1200);
  await onBeat("diagnostic-verdict", page, panel);

  // The one control with a consequence outside the browser.
  const sit = panel.locator("li").filter({ hasText: "Command safe sit" });
  const command = sit.getByRole("button", { name: "Command" });
  if (await command.isEnabled().catch(() => false)) {
    await command.click();
    const gate = panel.getByRole("alertdialog");
    await gate.waitFor({ timeout: 5000 });
    await page.waitForTimeout(1400);
    await onBeat("diagnostic-confirm", page, panel);
    await gate.getByRole("button", { name: "Confirm" }).click();
    await page.waitForTimeout(2500);
  }

  await panel.getByRole("button", { name: "File incident" }).click();
  await page
    .getByRole("heading", { name: "Incident history" })
    .waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1200);
}

async function record(browser) {
  const context = await browser.newContext({
    viewport: VIDEO_SIZE,
    recordVideo: { dir: join(OUT_DIR, ".video"), size: VIDEO_SIZE },
  });
  const page = await context.newPage();
  await walk(page);
  await context.close();

  const dir = join(OUT_DIR, ".video");
  const [file] = (await readdir(dir)).filter((f) => f.endsWith(".webm"));
  if (!file) throw new Error("no video produced");
  const webm = join(dir, file);

  const mp4 = join(OUT_DIR, "golden-path.mp4");
  await sh("ffmpeg", [
    "-y",
    "-i",
    webm,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "26",
    "-movflags",
    "+faststart",
    "-vf",
    "scale=760:-2",
    mp4,
  ]);

  // Two-pass palette: a one-pass GIF of a warm-white UI bands the greys.
  const palette = join(dir, "palette.png");
  await sh("ffmpeg", [
    "-y",
    "-i",
    webm,
    "-vf",
    "fps=12,scale=760:-1:flags=lanczos,palettegen=stats_mode=diff",
    palette,
  ]);
  await sh("ffmpeg", [
    "-y",
    "-i",
    webm,
    "-i",
    palette,
    "-lavfi",
    "fps=12,scale=760:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3",
    join(OUT_DIR, "golden-path.gif"),
  ]);
  await rm(dir, { recursive: true, force: true });
}

async function stills(browser) {
  const context = await browser.newContext({
    viewport: STILL_VIEWPORT,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const shots = {
    "fleet-alert": async (p) => p.screenshot({ path: join(STILLS, "fleet-alert.png") }),
    "unit-incident": async (p) =>
      p.screenshot({ path: join(STILLS, "unit-incident.png"), fullPage: true }),
    "diagnostic-scanning": async (_p, panel) =>
      panel.screenshot({ path: join(STILLS, "diagnostic-scanning.png") }),
    "diagnostic-verdict": async (_p, panel) =>
      panel.screenshot({ path: join(STILLS, "diagnostic-verdict.png") }),
    "diagnostic-confirm": async (_p, panel) =>
      panel.screenshot({ path: join(STILLS, "diagnostic-confirm.png") }),
  };

  await walk(page, {
    onBeat: async (name, page_, panel) => {
      const shot = shots[name];
      if (shot) await shot(page_, panel);
    },
  });

  // The filed report, which is its own page-shaped object.
  const reference = page.getByRole("button", { name: /^INC-/ }).first();
  if ((await reference.count()) > 0) {
    await reference.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(STILLS, "incident-report.png") });
  }
  await context.close();
}

const server = await serve();
const browser = await chromium.launch();
try {
  await mkdir(STILLS, { recursive: true });
  await record(browser);
  await stills(browser);
  console.log("captured evidence into docs/evidence/");
} finally {
  await browser.close();
  server.kill();
}
