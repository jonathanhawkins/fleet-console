import { expect, test, type Locator } from "@playwright/test";

/**
 * the descent is leaveable, and coming back lands on the scan as it
 * stands now.
 *
 * The golden path proves the loop works when the operator watches it all the
 * way down. This proves the other half, which is the half a real shift is made
 * of: an operator drops into a twenty-five second scan, remembers there are
 * seven other robots, steps out, and comes back. Nothing about that may cost
 * them the diagnostic.
 *
 * Three claims, and they can only be settled in a browser: the surface really
 * unmounts (jsdom cannot animate it away), the session really survives that
 * unmount, and the board really rebuilds from the store — walk lines included,
 * which are virtualized and need a layout to exist at all.
 *
 * Same build and same lane as the golden path: one compile between them.
 */

/** The session id printed in the scan header — stable for the life of a scan. */
async function sessionTag(overlay: Locator): Promise<string | undefined> {
  const text = await overlay.locator("header").first().innerText();
  return text.match(/SESSION\s+([0-9A-F]{4}-[0-9A-F]{4})/)?.[1];
}

/** How many nodes the walk has streamed, off the log panel's own counter. */
async function nodeCount(overlay: Locator): Promise<number> {
  const meta = await overlay.getByText(/\d+ NODES/).innerText();
  return Number.parseInt(meta, 10);
}

test("close mid-scan → in-progress banner → view scan → the board is still there", async ({
  page,
}) => {
  test.setTimeout(90_000);

  await page.goto("/unit/N-07");
  const banner = page.locator('[data-slot="incident-banner"]');
  await expect(banner).toBeVisible({ timeout: 30_000 });

  await banner.getByRole("button", { name: "Run diagnostic" }).click();
  const overlay = page.getByRole("dialog", { name: /Diagnostic scan, unit N-07/ });
  await expect(overlay).toBeVisible({ timeout: 15_000 });

  const scanLog = overlay.getByRole("log", { name: "Subsystem walk" });
  // A node far enough in that leaving cannot be mistaken for leaving nothing.
  await expect(scanLog).toContainText("/sys/actuator_bus/enumerate", { timeout: 20_000 });
  const tagBefore = await sessionTag(overlay);
  const nodesBefore = await nodeCount(overlay);
  expect(tagBefore).toBeTruthy();

  // --- CLOSE mid-scan: ascend, do not abort ---------------------------------
  const close = overlay.getByRole("button", { name: "Close diagnostic view" });
  await expect(close).toHaveAccessibleDescription(/scan keeps running/i);
  await close.click();
  await expect(overlay).toBeHidden({ timeout: 10_000 });

  // The operator page says what is still happening, and offers the way back.
  await expect(page.getByText("Diagnostic in progress")).toBeVisible();
  const viewScan = page.getByRole("button", { name: "View scan" });
  await expect(viewScan).toBeVisible();
  // Nothing was archived: an interrupted view is not an incident.
  await expect(page.locator("[data-incident]")).toHaveCount(0);

  // --- Back in: the same session, further along -----------------------------
  await viewScan.click();
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  expect(await sessionTag(overlay)).toBe(tagBefore);
  // The lines that streamed while the surface did not exist are on screen —
  // machine space renders the store and holds no log of its own.
  await expect(scanLog).toContainText("/sys/actuator_bus/enumerate");
  expect(await nodeCount(overlay)).toBeGreaterThanOrEqual(nodesBefore);
  await expect(overlay.locator(".wave-deck canvas")).toHaveCount(6, { timeout: 20_000 });

  // --- The verdict, closed from the header ----------------------------------
  await expect(
    overlay.getByRole("heading", { name: "KNEE_L · ACTUATOR A-07" }),
  ).toBeVisible({ timeout: 30_000 });
  const closeAtVerdict = overlay.getByRole("button", { name: "Close diagnostic view" });
  await expect(closeAtVerdict).toHaveAccessibleDescription(/incident is logged/i);
  await closeAtVerdict.click();
  await expect(overlay).toBeHidden({ timeout: 10_000 });

  // Closing at the verdict IS returning: the incident is on file.
  await expect(page.getByText("Diagnostic complete — service recommended")).toBeVisible();
  await expect(page.locator("[data-incident]").first()).toContainText(
    "Left knee actuator A-07: gain anomaly.",
  );
  await expect(page.getByRole("button", { name: "Run diagnostic again" })).toBeEnabled();
});

test("Escape leaves a running scan and returns from a finished one", async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto("/unit/N-07");
  const banner = page.locator('[data-slot="incident-banner"]');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await banner.getByRole("button", { name: "Run diagnostic" }).click();
  const overlay = page.getByRole("dialog", { name: /Diagnostic scan, unit N-07/ });
  await expect(overlay).toBeVisible({ timeout: 15_000 });
  await expect(overlay.getByRole("log", { name: "Subsystem walk" })).toContainText(
    "/sys/core/heartbeat.svc",
    { timeout: 20_000 },
  );

  // Mid-scan: the same meaning the header's CLOSE has. This overrides the
  // earlier "no Escape during the scan" decision (descent-overlay.tsx) without
  // touching the half of it that stands — the scan is still not cancellable.
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText("Diagnostic in progress")).toBeVisible();
  await expect(page.locator("[data-incident]")).toHaveCount(0);

  await page.getByRole("button", { name: "View scan" }).click();
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await expect(
    overlay.getByRole("heading", { name: "KNEE_L · ACTUATOR A-07" }),
  ).toBeVisible({ timeout: 30_000 });

  // At the verdict, unchanged: Escape returns, and returning logs.
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden({ timeout: 10_000 });
  await expect(page.locator("[data-incident]")).toHaveCount(1);
});
