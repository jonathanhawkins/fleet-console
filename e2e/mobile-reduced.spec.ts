import { expect, test } from "@playwright/test";
import { useMachineView } from "./diagnostic-view";

/**
 * The verdict sheet under `prefers-reduced-motion`, on the phone — the one
 * surface the desktop RM lane cannot reach, because at ≥64rem the conclusion is
 * a card in a column and the sheet never mounts.
 *
 * The sheet's RM contract (verdict-sheet.tsx) is deliberately not "no gesture":
 * a drag is motion the *operator* performs, so 1:1 tracking stays; what goes is
 * everything the sheet does by itself. Concretely, and asserted here:
 *
 * 1. the surface at rest carries no travel transform (it arrives by fade,
 * never by sliding up from the bottom edge),
 * 2. a drag on the header tracks the finger 1:1 (offset = travel − 10px slop),
 * 3. a release past the commit line applies the decision with zero flight
 * frames — the transform freezes at the release pixel while a crossfade
 * carries the surface out, and the sheet is parked (unmounted, chip up)
 * with no frame ever between the release offset and gone,
 * 4. restore puts the sheet back at rest instantly (transform identity while
 * the crossfade plays), not on a spring ride up from the bottom.
 *
 * Same seeded build and compressed storyline as every other lane; the touch
 * stack is raw CDP `Input.dispatchTouchEvent`, exactly as e2e/mobile.spec.ts
 * drives the full-motion gesture.
 */

const IDENTITY = ["none", "matrix(1, 0, 0, 1, 0, 0)"];

/* This walks the dark diagnostic, which is opt-in: the console now opens a
   scan in the calm operator-space panel by default. */
test.beforeEach(async ({ page }) => {
  await useMachineView(page);
});

test("phone RM: sheet crossfades, tracks 1:1, and parks on the release frame", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // Straight to the unit page, and wait for the *banner* — not merely for a
  // button reading "Run diagnostic".
  //
  // Since every unit is descendable: a nominal N-07 offers the scan from
  // its identity header long before the compressed amber lands (~9 s of sim
  // time), and the sim answers a pre-onset N-07 with the clean all-pass scan it
  // answers any healthy unit with. Waiting on the button therefore started a
  // NO ANOMALY scan a second into the storyline and left every assertion below
  // — the KNEE_L verdict, the sheet it arrives in — looking for a fault that
  // was never diagnosed. The banner is the honest signal that the incident is
  // live, and its pill is the button this test means.
  await page.goto("/unit/N-07");
  await expect(page.getByRole("heading", { name: "N-07" })).toBeVisible();
  const banner = page.locator('[data-slot="incident-banner"]');
  await expect(banner).toBeVisible({ timeout: 25_000 });
  const runDiagnostic = banner.getByRole("button", { name: "Run diagnostic" });
  await expect(runDiagnostic).toBeVisible();
  await runDiagnostic.tap();

  const overlay = page.getByRole("dialog", { name: /Diagnostic scan, unit N-07/ });
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  // --- 1. Arrival: a surface at rest, not a surface that travelled -----------
  const sheet = overlay.locator('[data-slot="verdict-sheet"]');
  await expect(sheet).toBeVisible({ timeout: 40_000 });
  const slide = overlay.locator('[data-slot="verdict-slide"]');
  const arrival = await slide.evaluate((el) => {
    const first = getComputedStyle(el).transform;
    return new Promise<{ first: string; next: string }>((resolve) => {
      requestAnimationFrame(() =>
        resolve({ first, next: getComputedStyle(el).transform }),
      );
    });
  });
  expect(IDENTITY).toContain(arrival.first);
  expect(IDENTITY).toContain(arrival.next);

  // --- 2. The drag: 1:1 under the finger --------------------------------------
  const offset = () =>
    slide.evaluate((el) => {
      const t = getComputedStyle(el).transform;
      return t === "none" ? 0 : new DOMMatrixReadOnly(t).m42;
    });

  const grab = await sheet.locator("[data-sheet-grab]").boundingBox();
  const grabX = Math.round((grab?.x ?? 0) + (grab?.width ?? 0) / 2);
  const grabY = Math.round((grab?.y ?? 0) + (grab?.height ?? 0) / 2);

  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", y?: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: grabX, y: y ?? grabY, id: 1 }],
    });

  // 340px of slow travel — past the 35% commit line (~230-260px of this sheet)
  // on position alone, with the park below killing the release velocity so the
  // decision is positional, not a flick.
  await touch("touchStart");
  for (let i = 1; i <= 20; i++) {
    await page.waitForTimeout(18);
    await touch("touchMove", grabY + i * 17);
  }
  // Park before reading: the drag coalesces pointermove into its own rAF, so
  // the settled offset is only readable once the last scheduled commit has
  // painted. The park also drains the release velocity, so the decision below
  // is positional. (The finger is still down for all of it.)
  await page.waitForTimeout(160);
  const held = await offset();
  // 1:1 within the 10px hysteresis the gesture spends proving it is a drag —
  // reduced motion does not loosen the tracking contract.
  expect(held, "sheet did not track the finger 1:1").toBeGreaterThan(300);
  expect(held, "sheet outran the finger").toBeLessThanOrEqual(340);

  // --- 3. Release: the decision on the release frame, zero flight frames ------
  // Sampler armed before the finger lifts: record the transform every frame
  // until the element unmounts. Under reduced motion no sample may differ from
  // the held offset — the surface fades out where it was released; a spring
  // flight to the bottom edge (the full-motion exit) would sweep 340 → ~sheet
  // height across every one of these frames.
  await page.evaluate(() => {
    const w = window as unknown as {
      __rmRelease?: Promise<{ offsets: number[]; goneAt: number | null }>;
    };
    const el = document.querySelector<HTMLElement>('[data-slot="verdict-slide"]');
    w.__rmRelease = new Promise((resolve) => {
      if (!el) {
        resolve({ offsets: [], goneAt: null });
        return;
      }
      const offsets: number[] = [];
      const t0 = performance.now();
      const sample = () => {
        if (!el.isConnected) {
          resolve({ offsets, goneAt: performance.now() - t0 });
          return;
        }
        const t = getComputedStyle(el).transform;
        offsets.push(t === "none" ? 0 : new DOMMatrixReadOnly(t).m42);
        if (performance.now() - t0 < 2500) requestAnimationFrame(sample);
        else resolve({ offsets, goneAt: null });
      };
      sample();
    });
  });
  await touch("touchEnd");

  const release = await page.evaluate(
    () =>
      (
        window as unknown as {
          __rmRelease?: Promise<{ offsets: number[]; goneAt: number | null }>;
        }
      ).__rmRelease,
  );
  expect(release).toBeDefined();
  expect(release!.offsets.length).toBeGreaterThan(3);
  for (const o of release!.offsets) {
    expect(
      Math.abs(o - held),
      "sheet flew after release — RM exit must not travel",
    ).toBeLessThanOrEqual(1.5);
  }
  expect(release!.goneAt, "sheet never parked after the commit").not.toBeNull();
  expect(release!.goneAt!).toBeLessThan(1500);

  // Parked: minimized state applied — chip in the status rule, no sheet.
  await expect(sheet).toHaveCount(0);
  const restoreChip = overlay.getByRole("button", {
    name: /VERDICT · KNEE_L · A-07 GAIN/i,
  });
  await expect(restoreChip).toBeVisible();

  // --- 4. Restore: back at rest instantly, no ride up from the bottom ---------
  await restoreChip.tap();
  await expect(sheet).toBeVisible();
  const back = await slide.evaluate((el) => getComputedStyle(el).transform);
  expect(IDENTITY, "restore travelled — RM restore must land at rest").toContain(back);
});
