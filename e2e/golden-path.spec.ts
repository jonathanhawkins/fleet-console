import { expect, test, type Locator, type Page } from "@playwright/test";

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
 * One spec on purpose (PRD §6): this walk IS the product. Anything
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

/** Computed `transform` values that mean "this element is not translated". */
const IDENTITY = ["none", "matrix(1, 0, 0, 1, 0, 0)"];

/**
 * A token, as the browser resolves it inside machine space. A probe is the
 * only honest way to read one: `--alert` is `var(--alert-red)` is `#ff3b30`,
 * and comparing that string against a computed `rgb(...)` would be the test
 * re-implementing the colour parser. Painting the token onto a throwaway
 * element and reading the computed value back is the browser doing it.
 */
function machineToken(overlay: Locator, name: string): Promise<string> {
  return overlay.evaluate((dialog, token) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${token})`;
    dialog.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

/**
 * What one channel strip has actually painted, counted off its own pixels.
 *
 * The strips are canvases (non-negotiable #3), so there is no DOM to ask what
 * colour the knee's trace is. `getImageData` on the canvas the deck draws into
 * is the platform-independent version of a screenshot: it reads the exact
 * bytes this build put there, on any OS, with no baseline to keep. "Red" is
 * the alert token's neighbourhood (#ff3b30 — red high, green and blue low),
 * which no phosphor, amber or reference-trace pixel can enter; the alpha floor
 * drops anti-aliasing fringe so a healthy strip counts exactly zero.
 */
function stripPixels(
  overlay: Locator,
  joint: string,
): Promise<{ red: number; painted: number }> {
  return overlay.locator(`.wave-strip[data-joint="${joint}"] canvas`).evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width === 0 || canvas.height === 0)
      return { red: -1, painted: -1 };
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let red = 0;
    let painted = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i + 3] ?? 0) < 64) continue;
      painted += 1;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (r > 200 && g < 120 && b < 120) red += 1;
    }
    return { red, painted };
  });
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

  // --- The descent, as pixels: the surface lands and the page is gone ------
  // The moving element is the dialog's parent (translateY 100% → 0 over the
  // 350 ms wipe). Once it has landed, three things are true of the screen and
  // none of them is a screenshot: the surface is the machine `--bg` token
  // edge to edge, the operator page beneath it is drained (beat 1's filter on
  // <html data-descent="under">), and nothing of that page can be hit — the
  // element under every corner and the centre of the viewport is the descent
  // layer's. That last one is what "covered" means, in any browser.
  await expect
    .poll(
      () =>
        overlay.evaluate((dialog, identity) => {
          const cs = getComputedStyle(dialog.parentElement!);
          return identity.includes(cs.transform) && Number(cs.opacity) === 1;
        }, IDENTITY),
      { timeout: 5_000 },
    )
    .toBe(true);
  const landed = await overlay.evaluate((dialog) => {
    const surface = dialog.parentElement!;
    const cs = getComputedStyle(surface);
    const stage = getComputedStyle(dialog);
    const under = document.querySelector<HTMLElement>(
      "body > *:not([data-descent-layer])",
    );
    const layer = document.querySelector("[data-descent-layer]");
    const w = window.innerWidth;
    const h = window.innerHeight;
    const points: Array<[number, number]> = [
      [2, 2],
      [w - 3, 2],
      [2, h - 3],
      [w - 3, h - 3],
      [w / 2, h / 2],
    ];
    return {
      transform: cs.transform,
      opacity: Number(cs.opacity),
      background: stage.backgroundColor,
      drained: document.documentElement.getAttribute("data-descent"),
      underFilter: under ? getComputedStyle(under).filter : null,
      covered: points.every((p) => layer?.contains(document.elementFromPoint(...p))),
    };
  });
  expect(IDENTITY, "surface has not landed").toContain(landed.transform);
  expect(landed.opacity).toBe(1);
  expect(landed.background).toBe(await machineToken(overlay, "--bg"));
  expect(landed.drained).toBe("under");
  expect(landed.underFilter).toMatch(/grayscale\(1\)/);
  expect(landed.covered, "the operator page is reachable under the surface").toBe(true);

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

  // …and on the sweep. The knee's trace is coloured by measurement, run by
  // run, and arrives in alert red; the hip beside it, healthy, never paints a
  // red pixel once its own sweep cursor has passed. Polled rather than read
  // once: the flag lands while the knee's 1.4 s reveal is still drawing, and
  // the red run is the last third of it.
  await expect
    .poll(async () => (await stripPixels(overlay, "knee_L")).red, { timeout: 10_000 })
    .toBeGreaterThan(40);
  await expect
    .poll(async () => stripPixels(overlay, "hip_L"), { timeout: 10_000 })
    .toEqual({ red: 0, painted: expect.any(Number) });
  expect((await stripPixels(overlay, "hip_L")).painted).toBeGreaterThan(100);

  // --- Verdict ---------------------------------------------------------------
  const headline = overlay.getByRole("heading", { name: "KNEE_L · ACTUATOR A-07" });
  await expect(headline).toBeVisible({ timeout: 15_000 });
  await expect(overlay.getByText("LEFT KNEE ACTUATOR A-07: GAIN ANOMALY")).toBeVisible();

  // The payload of the whole demo, in a screen reader's own terms: focus moves
  // to the verdict region itself the instant it lands — not to RETURN, which
  // would say nothing but "button" — and its accessible name states the
  // finding the operator descended for.
  const verdictRegion = overlay.locator('[data-slot="verdict-card"]');
  await expect(verdictRegion).toBeFocused();
  await expect(verdictRegion).toHaveAccessibleName(/KNEE_L/i);
  await expect(verdictRegion).toHaveAccessibleName(/ACTUATOR A-07/i);
  await expect(verdictRegion).toHaveAccessibleName(/gain anomaly/i);

  // The loudest thing in machine space, measured: the finding is set larger
  // than every section label around it (the panel titles and the card's own
  // VERDICT label), and both of its lines carry the alert token — the colour
  // read back off the same stylesheet the headline is painted from.
  const alert = await machineToken(overlay, "--alert");
  const type = await overlay.evaluate((dialog) => {
    const px = (el: Element | null) => Number.parseFloat(getComputedStyle(el!).fontSize);
    const labels = [
      ...dialog.querySelectorAll('[data-slot="scan-panel"] > header h2'),
    ].map(px);
    const verdictLabel = [...dialog.querySelectorAll("span")].find(
      (el) => el.textContent?.trim() === "Verdict",
    );
    const h2 = dialog.querySelector("#verdict-headline");
    const anomaly = dialog.querySelector('[data-slot="verdict-anomaly"]');
    return {
      labels,
      verdictLabel: px(verdictLabel ?? null),
      headline: px(h2),
      headlineColor: getComputedStyle(h2!).color,
      anomaly: px(anomaly),
      anomalyColor: getComputedStyle(anomaly!).color,
    };
  });
  expect(type.labels.length).toBe(3);
  for (const label of [...type.labels, type.verdictLabel]) {
    expect(type.headline).toBeGreaterThan(label * 2);
    expect(type.anomaly).toBeGreaterThan(label);
  }
  expect(type.headline).toBeGreaterThan(type.anomaly);
  expect(type.headlineColor).toBe(alert);
  expect(type.anomalyColor).toBe(alert);

  // --- A command gate opens over the column, and the board does not move ---
  // The confirmation is pinned to the foot of the centre column rather than
  // grown into it, so the manifest and the elevation stay exactly where the
  // operator was looking — on open, and on abort.
  const column = overlay.locator('[data-slot="verdict-column"] > *').first();
  const elevation = overlay.locator('[data-slot="wireframe-elevation"]');
  const before = {
    scroll: await column.evaluate((el) => el.scrollTop),
    elevation: await elevation.boundingBox(),
  };
  await overlay.getByRole("button", { name: /^Command safe sit$/i }).click();
  const gate = overlay.getByRole("alertdialog");
  await expect(gate).toBeVisible();
  await expect(gate.getByRole("button", { name: /^Abort$/i })).toBeFocused();
  // The gate is on screen, inside the column, without anything having scrolled.
  const gateBox = await gate.boundingBox();
  const columnBox = await column.boundingBox();
  expect(gateBox!.y + gateBox!.height).toBeLessThanOrEqual(
    columnBox!.y + columnBox!.height + 1,
  );
  expect(gateBox!.y).toBeGreaterThanOrEqual(columnBox!.y);
  expect(await column.evaluate((el) => el.scrollTop)).toBe(before.scroll);
  expect(await elevation.boundingBox()).toEqual(before.elevation);
  await page.keyboard.press("Escape");
  await expect(gate).toBeHidden();
  // Escape stopped at the gate: still in machine space, focus back on the trigger.
  await expect(overlay).toBeVisible();
  await expect(
    overlay.getByRole("button", { name: /^Command safe sit$/i }),
  ).toBeFocused();
  expect(await column.evaluate((el) => el.scrollTop)).toBe(before.scroll);
  expect(await elevation.boundingBox()).toEqual(before.elevation);

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
