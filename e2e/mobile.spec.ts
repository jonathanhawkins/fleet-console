import { expect, test, type Page } from "@playwright/test";
import { useMachineView } from "./diagnostic-view";

/**
 * The golden path again, on a phone, by touch.
 *
 * Not a duplicate of golden-path.spec.ts and deliberately not a copy of its
 * assertions. That spec proves the *product* works end to end — the trigger
 * discipline, the lazy chunk bookkeeping, the incident record. This one proves
 * the walk survives 390 px and a finger, which is a different claim and fails
 * in different places: a stacked scan that clips instead of scrolls, a verdict
 * buried three boxes deep in a panel, a restore chip squeezed to three letters,
 * a page that can be dragged sideways.
 *
 * So every assertion here is about a shape the desktop run cannot see. The
 * project (playwright.config.ts) is 390x844 with `isMobile` and `hasTouch`, so
 * `pointer: coarse` and `hover: none` are live and every interaction below is a
 * real tap rather than a mouse click that happens to land.
 */

/** The page column must never be draggable sideways. Checked at every beat. */
async function expectNoHorizontalScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, `page scrolls horizontally at ${where}`).toBeLessThanOrEqual(0);
}

/* These walk the dark diagnostic, which is opt-in: the console now opens a
   scan in the calm operator-space panel by default. */
test.beforeEach(async ({ page }) => {
  await useMachineView(page);
});

test("phone: fleet → tap N-07 → descent → verdict sheet → return with incident logged", async ({
  page,
}) => {
  test.setTimeout(90_000);

  // --- Fleet ----------------------------------------------------------------
  await page.goto("/");
  await expect(page.locator('[data-slot="unit-card"]')).toHaveCount(8);
  await expectNoHorizontalScroll(page, "fleet");

  // The rail header's unit count is deliberately absent at this width: it
  // restates the list immediately below it, and keeping it cost more than it
  // was worth — the order toggle beside it was being sliced off the screen
  // (fleet-rail-controls.tsx, e2e/responsive.spec.ts). The controls that carry
  // a decision stay.
  await expect(page.getByRole("button", { name: "Roster" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attention first" })).toBeVisible();

  // The map is full-bleed below `sm`: it runs to both edges of the 390px
  // viewport rather than sitting inside the page gutter.
  const mapCard = page.locator('[data-slot="console-card"]').filter({
    has: page.getByRole("heading", { name: "Fleet map" }),
  });
  const mapBox = await mapCard.boundingBox();
  expect(mapBox?.x).toBeLessThanOrEqual(1);
  expect(mapBox?.width ?? 0).toBeGreaterThanOrEqual(389);

  // Every rail row clears the 44px touch floor (they are 72px by design, but
  // the floor is what the phone actually needs and what a regression breaks).
  const firstRow = page.locator('[data-slot="unit-card"]').first();
  const rowBox = await firstRow.boundingBox();
  expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  // The map markers keep their 30px dial — eight 44px discs would be a map of
  // buttons — and grow an invisible 44px hit area instead, on coarse pointers
  // only. That is two claims and they need two instruments: the pad is a
  // pseudo element, so its size is read from the computed style (a bounding
  // box would report the dial), and its reach is hit-tested, to prove the
  // grown area sits on top of the map rather than under it.
  //
  // Both instruments are load-bearing, because neither is sufficient.
  // The computed style reports `width: 44px` on a `::after` with no `content`
  // — declarations exist, no box is generated, nothing is clickable — so
  // `content` is asserted too: it is the byte the size read cannot see. And
  // the hit test names THIS marker rather than "a marker", because the fleet
  // lives in one neighbourhood and adjacent pads overlap: a probe satisfied by
  // whatever is topmost would stay green through `inset: 0`, which slides
  // every target off its own glyph. `elementsFromPoint` returns the whole
  // stack under the point, so the neighbour on top of it is not an answer
  // either way — the claim is that the measured marker is somewhere in it.
  await expect(page.locator(".fleet-marker")).toHaveCount(8, { timeout: 20_000 });
  const markerReach = await page.evaluate(() => {
    const marker = document.querySelector<HTMLElement>(".fleet-marker");
    if (!marker) return null;
    const pad = getComputedStyle(marker, "::after");
    const box = marker.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    // 21px from centre on each axis is inside a 44px target centred on the
    // dial and outside a 30px one, so this reaches the marker only if its own
    // pad really grew, in that direction, around that centre.
    const probe = (dx: number, dy: number) =>
      document.elementsFromPoint(cx + dx, cy + dy).includes(marker);
    return {
      coarse: matchMedia("(pointer: coarse)").matches,
      dial: Math.round(box.width),
      padContent: pad.content,
      padW: pad.width,
      padH: pad.height,
      up: probe(0, -21),
      down: probe(0, 21),
      side: probe(21, 0),
      other: probe(-21, 0),
    };
  });
  expect(markerReach).toEqual({
    coarse: true,
    dial: 30,
    padContent: '""',
    padW: "44px",
    padH: "44px",
    up: true,
    down: true,
    side: true,
    other: true,
  });

  // --- The alert beat, then drill in by touch --------------------------------
  const railRow = page
    .getByRole("link", { name: /N-07, Elm House\. (Attention|Alert)\./ })
    .and(page.locator('[data-slot="unit-card"]'));
  await expect(railRow).toBeVisible({ timeout: 20_000 });
  await railRow.tap();
  await expect(page).toHaveURL(/\/unit\/N-07$/);

  // --- Unit page -------------------------------------------------------------
  await expect(page.getByRole("heading", { name: "N-07" })).toBeVisible();
  await expect
    .poll(async () => page.locator("main canvas").count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(6);
  await expectNoHorizontalScroll(page, "unit page");

  // The banner stacks: the pill runs the width of the card rather than sitting
  // in a corner of it.
  const banner = page.locator('[data-slot="incident-banner"]');
  await expect(banner).toBeVisible();
  // Scoped to the banner: a unit with nothing wrong offers the
  // same action from its identity header, and this test means the alert's pill.
  const runDiagnostic = banner.getByRole("button", { name: "Run diagnostic" });
  const bannerBox = await banner.boundingBox();
  const buttonBox = await runDiagnostic.boundingBox();
  expect(buttonBox?.width ?? 0).toBeGreaterThan((bannerBox?.width ?? 0) * 0.8);
  expect(buttonBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  // --- The descent -----------------------------------------------------------
  await runDiagnostic.tap();
  const overlay = page.getByRole("dialog", { name: /Diagnostic scan, unit N-07/ });
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  // Six channel strips, and — the phone's one deliberate subtraction — no
  // model wireframe. The turntable's whole job on the board is to be the far
  // end of the leader line, and at this width there is no run for that line to
  // make (see status-board.tsx). Asserted as absence so the decision cannot be
  // undone by accident: the desktop spec asserts the same canvas is present.
  await expect(overlay.locator(".wave-deck canvas")).toHaveCount(6, { timeout: 20_000 });
  await expect(overlay.locator('[data-slot="wireframe-elevation"]')).toHaveCount(0);

  // The frame holds while the flow scrolls: session header at the top, status
  // line at the bottom, in every scroll position.
  const scanLog = overlay.getByRole("log", { name: "Subsystem walk" });
  await expect(scanLog).toContainText("SCAN START", { timeout: 15_000 });
  await expect(overlay.getByRole("heading", { name: "Unit N-07" })).toBeVisible();

  // The walk log is a tail with a way to open it — a phone gets eight lines,
  // not a column.
  const expand = overlay.getByRole("button", { name: /^Expand$/i });
  await expect(expand).toBeVisible();

  // --- Verdict, as a sheet ----------------------------------------------------
  const sheet = overlay.locator('[data-slot="verdict-sheet"]');
  await expect(sheet).toBeVisible({ timeout: 25_000 });
  const headline = sheet.getByRole("heading", { name: "KNEE_L · ACTUATOR A-07" });
  await expect(headline).toBeVisible();
  // Escape does not exist on a phone, so RETURN has to be reachable without
  // scrolling: it is pinned to the bottom edge of the sheet.
  const sheetReturn = sheet.getByRole("button", { name: /return to console/i });
  await expect(sheetReturn).toBeInViewport();
  await expectNoHorizontalScroll(page, "verdict sheet");

  // --- Minimize: the chip has to fit a 390px status rule ----------------------
  await sheet.getByRole("button", { name: /minimize verdict/i }).tap();
  await expect(sheet).toHaveCount(0);
  const restoreChip = overlay.getByRole("button", {
    name: /VERDICT · KNEE_L · A-07 GAIN/i,
  });
  // The complete line survives in the accessible name even though the middle
  // of it is ellipsised on screen; VERDICT and RESTORE are what hold width.
  await expect(restoreChip).toBeVisible();
  const chipBox = await restoreChip.boundingBox();
  expect(chipBox?.width ?? 0).toBeLessThanOrEqual(390);
  await expect(restoreChip).toContainText("VERDICT");
  await expect(restoreChip).toContainText("Restore");
  // The board is browsable behind the put-down conclusion, as on a desk.
  await expect(scanLog).toBeVisible();

  await restoreChip.tap();
  await expect(sheet).toBeVisible();

  // --- Minimize again, this time by throwing it -------------------------------
  // The sheet is grabbable. Three properties are checked here and
  // nowhere else, because none of them survive being described in a unit test:
  // the surface tracks the finger 1:1 while it is held, a released drag that
  // went nowhere comes home, and a flick commits on velocity from a position
  // that would not have committed on its own.
  const slide = overlay.locator('[data-slot="verdict-slide"]');
  const offset = () =>
    slide.evaluate((el) => {
      const t = getComputedStyle(el).transform;
      return t === "none" ? 0 : new DOMMatrixReadOnly(t).m42;
    });

  // The header is the handle. Grab it in the middle — but only once the sheet
  // has finished coming back up, or the box measured is a box in flight.
  await expect.poll(offset, { timeout: 2000 }).toBe(0);
  const grab = await sheet.locator("[data-sheet-grab]").boundingBox();
  const grabX = Math.round((grab?.x ?? 0) + (grab?.width ?? 0) / 2);
  const grabY = Math.round((grab?.y ?? 0) + (grab?.height ?? 0) / 2);

  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", y?: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: grabX, y: y ?? grabY, id: 1 }],
    });

  // Drag down slowly and park. 120px of travel, well under the commit line.
  await touch("touchStart");
  for (let i = 1; i <= 12; i++) {
    await page.waitForTimeout(20);
    await touch("touchMove", grabY + i * 10);
  }
  const held = await offset();
  // 1:1 within the 10px hysteresis the gesture spends proving it is a drag.
  expect(held, "sheet did not track the finger").toBeGreaterThan(90);
  expect(held, "sheet outran the finger").toBeLessThanOrEqual(120);
  await page.waitForTimeout(140); // park: the release carries no velocity
  await touch("touchEnd");
  await expect.poll(offset, { timeout: 2000 }).toBe(0);
  await expect(sheet).toBeVisible();

  // Now flick: short and fast. The sheet reads velocity off the event
  // timestamps over the last 60 ms, so each step's displacement is scaled to
  // this machine's actual dispatch gap (a CI runner can take 40 ms per CDP
  // round trip, a laptop 4 ms) — the finger always moves at ~1.8 px/ms, and
  // the travel stays between 60 and 200 px.
  await touch("touchStart");
  let flickY = grabY;
  let lastAt = performance.now();
  for (let i = 0; i < 5; i++) {
    const now = performance.now();
    const gapMs = i === 0 ? 8 : now - lastAt;
    lastAt = now;
    flickY += Math.min(40, Math.max(12, Math.round(1.8 * gapMs)));
    await touch("touchMove", flickY);
  }
  await touch("touchEnd");
  await expect(sheet).toHaveCount(0);
  await expect(restoreChip).toBeVisible();

  // A flick is a view gesture and must never be an exit: the overlay is still
  // up and the incident is still open. Logging an incident because a thumb
  // slipped would be the console asserting something about a machine that the
  // operator never said.
  await expect(overlay).toBeVisible();
  await expect(page.getByRole("heading", { name: "Incident history" })).toHaveCount(0);

  // Chromium on a loaded runner swallows a tap that lands within about a
  // second of that release: the page sees touchstart and touchend on the chip
  // and nothing after them, and the same tap a second later clicks. The
  // likeliest reading is the rule that a finger arriving mid-fling stops the
  // fling and is not a click, reached through the emulated touch path even
  // though the handle declares touch-action: none. So the fling is waited out
  // rather than tapped through: one tap, one restore. A retry would also pass,
  // and would hide a chip that had learned to ignore its first tap.
  await page.waitForTimeout(1_500);
  await restoreChip.tap();
  await expect(sheet).toBeVisible();
  await expect.poll(offset, { timeout: 2000 }).toBe(0);

  // --- Ascent ----------------------------------------------------------------
  await sheet.getByRole("button", { name: /return to console/i }).tap();
  await expect(overlay).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText("Diagnostic complete — service recommended")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Incident history" })).toBeVisible();
  await expect(page.locator("[data-incident]").first()).toContainText(
    "Left knee actuator A-07: gain anomaly.",
  );
  await expectNoHorizontalScroll(page, "after ascent");
});
