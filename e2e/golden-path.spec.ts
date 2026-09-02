import { expect, test, type Page } from "@playwright/test";

/**
 * The golden path, end to end, against the static WorkerTransport build —
 * the exact artifact that deploys, served the way Cloudflare Pages serves it
 * (see scripts/serve-static.mjs), with no dev server and no ws sim behind it.
 *
 * The webServer (playwright.config.ts) builds with a pinned seed and the
 * compressed storyline: onset 6 s, amber 9 s, red 12 s, diag choreography at
 * 0.25x — the same knobs the dev sim exposes, inlined at build time. The
 * storyline is deterministic, but every beat is asserted by observed state
 * (roles and visible text, bounded polls), never by sleeping to a timestamp:
 * the test cares that the amber alert *arrives and is shown*, not when.
 *
 * One spec on purpose (PRD §6, Phase 6): this walk IS the product. Anything
 * it does not cover is covered by the 334 vitest specs underneath it.
 */

/**
 * A string that exists only inside the machine-space chunk (scan-copy.ts, the
 * scan's status line). Fetching a served chunk and finding this marks it as
 * the machine bundle — no hardcoded chunk hashes.
 */
const MACHINE_MARKER = "SCANNING ACTUATOR BUS";

/** Every /_next JS chunk the page requested, tagged with the beat it arrived in. */
interface ChunkLog {
  entries: Array<{ url: string; phase: "fleet" | "unit" | "descent" }>;
  phase: "fleet" | "unit" | "descent";
}

function trackChunks(page: Page): ChunkLog {
  const log: ChunkLog = { entries: [], phase: "fleet" };
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/_next/static/chunks/") && url.endsWith(".js")) {
      log.entries.push({ url, phase: log.phase });
    }
  });
  return log;
}

test("fleet alert → drill-in → descent → verdict → ascent with incident logged", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const chunks = trackChunks(page);

  // --- Fleet: eight units, live over the in-page worker sim ------------------
  await page.goto("/");
  await expect(page.getByText(/8 units/i)).toBeVisible();
  await expect(page.locator('[data-slot="unit-card"]')).toHaveCount(8);
  // The link is genuinely live, not a rendered snapshot. (role=status takes
  // no name from content, so this matches by the region's text.)
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();

  // --- The alert beat: feed entry + the N-07 rail chip flips -----------------
  // Compressed storyline: amber at 9 s. The unit card's accessible name embeds
  // its status chip, so "the chip flipped" is asserted through the a11y tree.
  // (.and(unit-card): the map marker is a link that flips with the same label
  // prefix — this pins the assertion to the rail row specifically.)
  const railRow = page
    .getByRole("link", { name: /N-07, Elm House\. (Attention|Alert)\./ })
    .and(page.locator('[data-slot="unit-card"]'));
  await expect(railRow).toBeVisible({ timeout: 20_000 });
  await expect(
    page
      .locator('[data-slot="alert-row"]')
      .filter({ hasText: /left knee actuator/ })
      .first(),
  ).toBeVisible();

  // --- Drill in --------------------------------------------------------------
  chunks.phase = "unit";
  await railRow.click();
  await expect(page).toHaveURL(/\/unit\/N-07$/);
  await expect(page.getByRole("heading", { name: "N-07" })).toBeVisible();
  // Live telemetry strips are canvases (three per joint), not chart DOM.
  await expect
    .poll(async () => page.locator("main canvas").count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(6);
  // The banner: the one loud object, holding the one primary action.
  const banner = page.locator('[data-slot="incident-banner"]');
  await expect(banner).toBeVisible();
  // Scoped to the banner: the identity header carries the same
  // action for a unit with nothing wrong with it, and this is the alert's pill.
  const runDiagnostic = banner.getByRole("button", { name: "Run diagnostic" });
  await expect(runDiagnostic).toBeVisible();

  // --- The descent -----------------------------------------------------------
  chunks.phase = "descent";
  await runDiagnostic.click();
  // The overlay opens on the sim's scan_start event, not on the click itself.
  const overlay = page.getByRole("dialog", { name: /Diagnostic scan, unit N-07/ });
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  // The lazy split, as bookkeeping: no chunk fetched while the operator was on
  // the fleet page contains machine-space code. (The chunk is *allowed* from
  // the unit page on: the incident banner deliberately warms it on mount so
  // the descent never waits on the network — asserted below by presence.)
  const seen = new Map<string, "fleet" | "unit" | "descent">();
  for (const entry of chunks.entries) {
    if (!seen.has(entry.url)) seen.set(entry.url, entry.phase);
  }
  const machineChunks: string[] = [];
  for (const [url, phase] of seen) {
    const body = await (await page.request.get(url)).text();
    if (body.includes(MACHINE_MARKER)) {
      machineChunks.push(url);
      expect(phase, `machine chunk fetched during the fleet phase: ${url}`).not.toBe(
        "fleet",
      );
    }
  }
  // ...and the machine bundle really is a separate chunk that has arrived by
  // the time the descent is on screen.
  expect(machineChunks.length).toBeGreaterThanOrEqual(1);

  // --- Scan choreography: walk lines stream into the log ---------------------
  const scanLog = overlay.getByRole("log", { name: "Subsystem walk" });
  await expect(scanLog).toContainText("SCAN START", { timeout: 10_000 });
  // The walk's last node (0020). Streamed at the compressed cadence, so this
  // polls the log growing rather than checking a finished transcript.
  await expect(scanLog).toContainText("/proprio/imu/fusion_state", { timeout: 15_000 });

  // --- Waveform channels: six canvases, live vs reference --------------------
  // Six strips in the deck; the seventh canvas is the board's model wireframe,
  // and its presence is the assertion that the elevation swapped off its SVG
  // fallback — i.e. that chassis-wireframe.json fetched and parsed. The verdict's
  // evidence traces are SVG, so nothing else on the overlay is a canvas.
  await expect(overlay.locator(".wave-deck canvas")).toHaveCount(6, { timeout: 15_000 });
  await expect(overlay.locator('[data-slot="wireframe-elevation"] canvas')).toHaveCount(
    1,
    { timeout: 15_000 },
  );

  // --- The flag beat: KNEE_L goes DAMAGED on the manifest --------------------
  await expect(overlay.getByText("DAMAGED").first()).toBeVisible({ timeout: 15_000 });

  // --- Verdict ---------------------------------------------------------------
  const headline = overlay.getByRole("heading", { name: "KNEE_L · ACTUATOR A-07" });
  await expect(headline).toBeVisible({ timeout: 15_000 });
  await expect(overlay.getByText("LEFT KNEE ACTUATOR A-07: GAIN ANOMALY")).toBeVisible();

  // --- Minimize: the conclusion goes down to the status line, evidence stays --
  await overlay.getByRole("button", { name: /minimize verdict/i }).click();
  await expect(headline).toBeHidden();
  await expect(scanLog).toContainText("/proprio/imu/fusion_state"); // still browsable
  const restoreChip = overlay.getByRole("button", {
    name: /VERDICT · KNEE_L · A-07 GAIN/i,
  });
  await expect(restoreChip).toBeVisible();
  await restoreChip.click();
  await expect(headline).toBeVisible();

  // --- Ascent: back to operator space with the incident on file --------------
  await overlay.getByRole("button", { name: /return to console/i }).click();
  await expect(overlay).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText("Diagnostic complete — service recommended")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Incident history" })).toBeVisible();
  await expect(page.locator("[data-incident]").first()).toContainText(
    "Left knee actuator A-07: gain anomaly.",
  );

  // --- …and the action survives the diagnosis -----------------------
  // The banner used to drop its button the moment a verdict was on file, which
  // left the console with no way to scan anything ever again. The re-run is an
  // outline, not a second black pill: one primary action per screen.
  const again = page.getByRole("button", { name: "Run diagnostic again" });
  await expect(again).toBeEnabled();
  await expect(again).toHaveAttribute("data-variant", "secondary");
  await again.click();
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  // The sim's anomaly persists until RESET_SIM, so the second scan finds the
  // same fault — the console is not being told a new story, it is being run
  // again.
  await expect(
    overlay.getByRole("heading", { name: "KNEE_L · ACTUATOR A-07" }),
  ).toBeVisible({ timeout: 20_000 });
});
