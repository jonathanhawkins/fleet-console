import { expect, test } from "@playwright/test";

/**
 * The map's failure path, end to end.
 *
 * public/map/fleet-light.json has exactly one third-party host: OpenFreeMap,
 * for both the vector tile source (`ofm`) and the glyph endpoint the
 * "place-label" text layer depends on. Blocking that one host therefore
 * exercises both of MapLibre's network dependencies at once — a font failure
 * is not a separate scenario here, it is the same abort on the same origin.
 *
 * What this proves can only be proven in a real browser against the real
 * MapLibre error path: the reveal race itself (load/idle vs error vs the
 * bounded timeout) is pinned at the unit level in fleet-map-view.test.tsx.
 * This is the other half — that a fleet console with no basemap still reads
 * as a fleet console, not as a broken page.
 *
 * Same build and lane as the golden path (playwright.config.ts): a plain
 * fleet with nothing forced into an incident is exactly what this needs.
 */

test("a blocked tile host still shows the fleet, reveals quietly, and stays clickable", async ({
  page,
}) => {
  test.setTimeout(60_000);

  await page.route("**/tiles.openfreemap.org/**", (route) => route.abort());

  await page.goto("/");
  await expect(page.getByText(/8 units/i)).toBeVisible();

  const frame = page.locator('[data-slot="fleet-map-frame"]');
  await expect(frame).toBeVisible();

  // The content — the fleet — is unaffected by the cartography's fate.
  await expect(page.locator(".fleet-marker")).toHaveCount(8);

  // The reveal is bounded: a fully blocked host cannot hold the canvas back
  // for good. BASEMAP_TIMEOUT_MS is 2.5 s; MapLibre's own `error` typically
  // gets there sooner once every request to the blocked host is refused.
  await expect(frame).toHaveAttribute("data-basemap", "ready", { timeout: 5_000 });
  await expect(frame).toHaveAttribute("data-basemap-degraded", "true");

  // The region says so, quietly — RegionNote's own voice, not an alarm.
  await expect(
    page.getByText("Base map unavailable. Fleet positions are unaffected."),
  ).toBeVisible();

  // The small print keeps behaving correctly in this state too. The privacy
  // note is exact copy regardless of the basemap's fate. The tile attribution
  // is the opposite case done right: MapLibre populates it from the fetched
  // TileJSON, not from the style's inline hint (public/map/fleet-light.json's
  // own "fleet-console:attribution" note already says as much), so with the
  // host blocked outright no TileJSON ever arrives and the control correctly
  // renders empty rather than crediting a basemap that never painted a tile —
  // it must not persist stale credit, and it does not.
  await expect(page.getByText("Locations approximate")).toBeVisible();
  const attribution = page.locator(".maplibregl-ctrl-attrib");
  await expect(attribution).toBeAttached();
  await expect(attribution).toBeEmpty();

  // Click-through survives a degraded basemap: the marker is a real link,
  // positioned and interactive independent of the canvas underneath it.
  await page.locator('.fleet-marker[data-unit="N-07"]').click();
  await expect(page).toHaveURL(/\/unit\/N-07$/);
});
