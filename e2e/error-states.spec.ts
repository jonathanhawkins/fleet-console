import { expect, test } from "@playwright/test";

/**
 * The static export has no server, so a bad URL is not a 500 somewhere — it
 * is either every route Next enumerated at build time, or `out/404.html`.
 * `app/unit/[id]/page.tsx` sets `dynamicParams = false` and only the eight
 * roster ids (sim/engine/fleet.ts) get a static page, so N-99 (or any typo)
 * falls straight to that file. This spec is what proves that file is the
 * console's own not-found page and not the framework's stock scaffold: a
 * console whose whole thesis is exactly two visual worlds (CLAUDE.md) cannot
 * let a bad link surface a third, unstyled one — operator space, the footer
 * disclaimer every page owes, and a way back that actually works.
 *
 * Same build and lane as the golden path: nothing here depends on the
 * storyline, so it costs nothing extra to share the compile.
 */

test("an unknown unit id renders the console's own not-found page", async ({ page }) => {
  const response = await page.goto("/unit/N-99");
  expect(response?.status()).toBe(404);

  // The world this page renders in, not the framework's bare scaffold —
  // data-space only exists on the console's own <html>.
  await expect(page.locator("html")).toHaveAttribute("data-space", "operator");

  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();

  // CLAUDE.md non-negotiable #5: on every page, including this one.
  await expect(
    page.getByText("A design and engineering demo. All data is simulated."),
  ).toBeVisible();

  const backLink = page.getByRole("link", { name: "Back to fleet" });
  await expect(backLink).toBeVisible();
  await backLink.click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Design system" })).toBeVisible();
});

test("a nonsense top-level path also renders the console's not-found page", async ({
  page,
}) => {
  const response = await page.goto("/this-route-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.locator("html")).toHaveAttribute("data-space", "operator");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
