import { expect, test, type Page } from "@playwright/test";

/**
 * Nothing is cut off, at any width the project claims to support.
 *
 * This exists because of a defect the eye caught and every other lane missed:
 * at 390 px the fleet rail's header ran 72 px past the viewport, so "Attention
 * first" was sliced and the unit count sat entirely off-screen — with
 * `document.scrollWidth === clientWidth`, because an ancestor was clipping
 * rather than overflowing. A phone lane already ran at exactly 390 px and
 * asserted its way through the whole golden path without noticing, since
 * everything it looked for was still findable in the DOM.
 *
 * So the check is structural rather than per-element: walk the tree, and fail
 * on anything whose box extends past the viewport without a scroller above it
 * to reach it. Canvases and deliberate scrollports are excluded — a map is
 * supposed to run off the edge, and a scrollport's whole job is to hold more
 * than it shows.
 */

/** 768 px is the floor CLAUDE.md's quality bar names; 390 px is the phone lane's. */
const WIDTHS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
];

const ROUTES = ["/", "/unit/N-01", "/system"];

interface Clipped {
  text: string;
  slot: string | null;
  right: number;
}

/** Boxes past the right edge with nothing scrollable between them and the page. */
function clippedElements(page: Page): Promise<{ viewport: number; clipped: Clipped[] }> {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const clipped: Array<{ text: string; slot: string | null; right: number }> = [];
    for (const el of document.querySelectorAll("*")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right <= viewport + 1) continue;

      let node: Element | null = el;
      let reachable = false;
      while (node) {
        const style = getComputedStyle(node);
        if (
          style.overflowX === "auto" ||
          style.overflowX === "scroll" ||
          node.tagName === "CANVAS"
        ) {
          reachable = true;
          break;
        }
        node = node.parentElement;
      }
      if (reachable) continue;

      clipped.push({
        text: (el.textContent ?? "").trim().slice(0, 60),
        slot: el.getAttribute("data-slot"),
        right: Math.round(box.right),
      });
    }
    return { viewport, clipped };
  });
}

for (const { name, width, height } of WIDTHS) {
  for (const route of ROUTES) {
    test(`${name}: nothing is cut off on ${route}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(route);
      // Wait for the surface that actually lays out: the rail on the fleet
      // page, the instruments on a unit, the specimens on the gallery.
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1500);

      const { viewport, clipped } = await clippedElements(page);
      expect(viewport).toBe(width);
      expect(clipped, `clipped past ${width}px on ${route}`).toEqual([]);
    });
  }
}

test("the fleet rail's header keeps its controls reachable on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator('[data-slot="unit-card"]')).toHaveCount(8);

  // The two controls that carry a decision stay on screen at every width.
  for (const name of [/^Roster$/, /^Attention first$/]) {
    const control = page.getByRole("button", { name });
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box, `${name} has no box`).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }

  // The count is the one header item a phone may drop — it restates the list
  // directly below it — but a *filtered* count is not derivable from the
  // screen, so filtering must bring it back. Scoped to the rail's own header:
  // the KPI band says "8 of 8" too, about a different thing.
  const railHeader = page
    .locator('[data-slot="console-card"]')
    .filter({ has: page.locator('[data-slot="unit-card"]') })
    .locator("header");
  await expect(railHeader).not.toContainText(/of 8/i);

  await page.getByRole("searchbox", { name: "Search units" }).fill("N-0");
  await expect(railHeader).toContainText(/8 of 8/i);

  const count = railHeader.getByText(/^\d+ of \d+$/i);
  const box = await count.boundingBox();
  expect(box, "the filtered count has no box").not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});
