import { expect, test } from "@playwright/test";

/**
 * The golden path, end to end, against the static WorkerTransport build — the
 * exact artifact that deploys, with no dev server and no ws sim behind it.
 *
 * This walk IS the product: it is what a reviewer sees without touching a
 * setting. The scan runs in operator space, on the unit page, beside the
 * telemetry that motivated it. The dark board is still there and still tested
 * (machine-view.spec.ts pins itself to it), but it is a door the operator
 * opens, and nothing here opens it.
 *
 * Three claims a screenshot could not make. The page is **never taken away** —
 * no dialog, and the eighteen instruments are in the document the whole time.
 * The panel **does not reflow**, because all six channel rows and all nine
 * structure rows exist from the moment it appears and fill in place. And the
 * control that moves a robot is **gated by a confirmation that opens harmless**,
 * which is the one interaction here with a consequence outside the browser.
 */

test("fleet alert → drill-in → scan → verdict → safe sit → incident logged", async ({
  page,
}) => {
  test.setTimeout(90_000);

  await page.goto("/");
  await expect(page.getByText(/8 units/i)).toBeVisible();

  const railRow = page
    .getByRole("link", { name: /N-07, Elm House\. (Attention|Alert)\./ })
    .and(page.locator('[data-slot="unit-card"]'));
  await expect(railRow).toBeVisible({ timeout: 20_000 });
  await railRow.click();
  await expect(page).toHaveURL(/\/unit\/N-07$/);

  const instruments = page.locator("main canvas");
  await expect
    .poll(async () => instruments.count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(6);
  const before = await instruments.count();

  const banner = page.locator('[data-slot="incident-banner"]');
  await banner.getByRole("button", { name: "Run diagnostic" }).click();

  // The panel arrives in the column. Nothing is covered and nothing is a modal.
  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Diagnostic" }) });
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Every row is present before any channel has landed: the column fills, it
  // does not grow. Six joints, dashed until each one reports.
  const rows = panel.locator("[data-channel]");
  await expect(rows).toHaveCount(6);

  // The progress rule counts wire events, so it carries real units.
  const rule = panel.getByRole("progressbar");
  await expect(rule).toHaveAttribute("aria-valuemax", "26");

  // The verdict, in operator space. Two registers on purpose: the console's own
  // headline, and the machine's sentence quoted rather than paraphrased — so
  // "gain anomaly" is deliberately on this card twice, in two voices.
  const finding = panel.getByRole("heading", { name: /Actuator A-07/ });
  await expect(finding).toBeVisible({ timeout: 30_000 });
  await expect(finding).toContainText(/gain anomaly/i);
  await expect(panel.locator("blockquote")).toContainText(/GAIN ANOMALY/);

  // The evidence: the flagged joint is the only subject, and its reading is
  // visibly an outlier rather than merely a coloured row.
  const subject = panel.locator("[data-subject]");
  await expect(subject).toHaveCount(1);
  await expect(subject).toContainText("Left knee");

  const readings = await panel.locator("[data-channel]").allInnerTexts();
  const rms = readings
    .map((text) => Number.parseFloat(text.match(/0\.\d{3}/)?.[0] ?? "NaN"))
    .filter((n) => Number.isFinite(n));
  expect(rms).toHaveLength(6);
  const worst = Math.max(...rms);
  const others = rms.filter((n) => n !== worst);
  // The finding is an order of magnitude clear of everything else.
  expect(worst).toBeGreaterThan(Math.max(...others) * 5);

  // The operator never lost the telemetry that sent them here.
  expect(await instruments.count()).toBeGreaterThanOrEqual(before);

  // The gated recommendation states its reason on the page, not in a tooltip.
  await expect(panel.getByRole("heading", { name: /Act on the unit/i })).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: /Record to the incident/i }),
  ).toBeVisible();

  // The structure half of the manifest: the claim is not "the knee is broken",
  // it is "fifteen things were checked and one of them was not fine".
  await expect(panel.locator("[data-structure]")).toHaveCount(9);
  await expect(panel.getByText(/9 of 9 checked/)).toBeVisible();

  // The twenty walked nodes are kept, verbatim, behind a disclosure.
  const walk = panel.getByRole("button", { name: "Subsystem walk" });
  await expect(walk).toHaveAttribute("aria-expanded", "false");
  await walk.click();
  await expect(panel.getByText("/sys/core/heartbeat.svc")).toBeVisible();

  // --- The one action with a consequence outside the browser ----------------
  const sit = panel.locator("li").filter({ hasText: "Command safe sit" });
  await sit.getByRole("button", { name: "Command" }).click();

  const gate = panel.getByRole("alertdialog");
  await expect(gate).toBeVisible();
  // It opens on the harmless control, so a stray Return cancels.
  await expect(gate.getByRole("button", { name: "Cancel" })).toBeFocused();
  // And it states the consequence an operator is most likely to drop.
  await expect(gate.getByText(/Service still required/i)).toBeVisible();

  await gate.getByRole("button", { name: "Confirm" }).click();
  await expect(panel.getByRole("alertdialog")).toHaveCount(0);
  await expect(sit.getByText(/Recorded/i)).toBeVisible();

  // Filing it puts the incident on the unit's history, with the report behind it.
  await panel.getByRole("button", { name: "File incident" }).click();
  await expect(page.getByRole("heading", { name: "Incident history" })).toBeVisible();

  // …and the panel leaves with the session, because it never owned anything.
  await expect(panel).toHaveCount(0);
});
