import { expect, test } from "@playwright/test";

/**
 * 500-unit stress smoke — the scale claims of docs/perf.md
 * ("Scale + ordering"), asserted in a real browser against the same
 * static-export artifact the golden path tests, built with
 * NEXT_PUBLIC_SIM_UNITS=500 (playwright.stress.config.ts).
 *
 * What it proves, in one walk:
 * 1. the fleet loads and goes live at 500 units;
 * 2. the rail is genuinely virtualized — the DOM holds a viewport of rows
 * while the header counts the whole fleet — and stays bounded while
 * traversing to the far end;
 * 3. keyboard traversal (Home/End) still lands on real, focusable rows;
 * 4. the N-07 storyline survives scale: the amber alert surfaces in the
 * feed and its row click-through reaches /unit/N-07 — the golden path's
 * first two beats, with 492 extra units in the room;
 * 5. the search field is what makes 492 extra units tolerable: it finds the
 * one unit in five hundred and gets there.
 *
 * Numbers (fps, commit costs, marker strategy) live in docs/perf.md; this
 * spec pins the *behaviors* so a regression cannot ship silently.
 */

/** The virtualizer mounts a viewport plus overscan; 1100px of 72px rows plus
 * 4 rows of overscan each side is ~20. 30 is the generous ceiling that still
 * proves 500 rows are NOT in the DOM. */
const MAX_MOUNTED_ROWS = 30;

test("500 units: live fleet, bounded rail DOM, Home/End traversal, N-07 alert click-through", async ({
  page,
}) => {
  test.setTimeout(90_000);

  await page.goto("/");

  // --- Live at 500 -----------------------------------------------------------
  await expect(page.getByText(/500 units/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();

  // --- Virtualization: a viewport of rows, not a fleet of them ---------------
  const rows = page.locator('[data-slot="unit-card"]');
  await expect.poll(async () => rows.count()).toBeGreaterThan(5);
  expect(await rows.count()).toBeLessThan(MAX_MOUNTED_ROWS);

  // The first row is the roving tab stop (tabindex 0) — focus it directly:
  // the rail's keyboard contract starts from a focused row.
  await rows.first().focus();
  await expect(rows.first()).toBeFocused();

  // --- End: the far end of a 500-row list is one keypress away ---------------
  await page.keyboard.press("End");
  const lastRow = page
    .getByRole("link", { name: /^N-500, / })
    .and(page.locator('[data-slot="unit-card"]'));
  await expect(lastRow).toBeVisible({ timeout: 5_000 });
  await expect(lastRow).toBeFocused();
  // Scrolled to the bottom, the DOM is still a viewport of rows.
  expect(await rows.count()).toBeLessThan(MAX_MOUNTED_ROWS);

  // --- Home: and back --------------------------------------------------------
  await page.keyboard.press("Home");
  const firstRow = page
    .getByRole("link", { name: /^N-01, Prospect Row/ })
    .and(page.locator('[data-slot="unit-card"]'));
  await expect(firstRow).toBeVisible({ timeout: 5_000 });
  await expect(firstRow).toBeFocused();

  // --- The N-07 beat still lands at scale ------------------------------------
  // Compressed storyline: amber at 9 s. The feed is the operator's path to a
  // unit that raised its hand — assert the row exists and follow it.
  const alertRow = page
    .locator('[data-slot="alert-row"]')
    .filter({ hasText: "N-07" })
    .first();
  await expect(alertRow).toBeVisible({ timeout: 20_000 });
  await alertRow.click();
  await expect(page).toHaveURL(/\/unit\/N-07$/, { timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "N-07" })).toBeVisible();

  // --- Search finds the one unit in five hundred -----------------------------
  // A fresh load: this beat is about the search field finding a needle in a
  // 500-unit haystack, not about whatever the alert beat above left behind.
  // By home name, not id: generated ids pad to 3 digits past unit 99 (N-009 …
  // N-500), so a 2-digit core id like "N-08" also substring-matches N-080
  // through N-089 at this scale. "Hubbard Farm" is a handcrafted name outside
  // both generated word lists (sim/engine/fleet.ts) — unique by construction,
  // and only reachable by name, not by an id anyone could guess.
  await page.goto("/");
  await expect(page.getByText(/500 units/i)).toBeVisible({ timeout: 15_000 });

  const search = page.getByRole("searchbox", { name: "Search units" });
  await search.fill("Hubbard Farm");
  await expect(page.getByText("1 of 500")).toBeVisible();
  await expect(rows).toHaveCount(1);

  await rows.first().click();
  await expect(page).toHaveURL(/\/unit\/N-08$/, { timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "N-08" })).toBeVisible();
});
