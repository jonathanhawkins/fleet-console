import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Accessibility, where Lighthouse cannot reach.
 *
 * The Lighthouse gate audits three routes at rest: `/`, `/unit/N-01` and
 * `/system`. None of them contains the descent overlay, the verdict, the
 * safe-sit gate or the incident report — which is to say none of them contains
 * a single modal, a focus trap, or a live region, and those are every hard
 * accessibility problem this app has. A 100 that never opened a dialog is a
 * number about the easy part.
 *
 * So: axe on each interactive surface as the golden path reaches it — in three
 * walks: the operator surfaces, machine space, and the way back out — and one
 * walk of that path driven by nothing but the keyboard. All of it runs against the deploy artifact, in machine space
 * as well as operator space — contrast in phosphor-on-black is a claim the
 * repo makes in its first paragraph.
 */

/**
 * WCAG 2 A and AA, which is the bar CLAUDE.md sets. `best-practice` is left
 * off deliberately: it fails things that are matters of taste (a landmark
 * count, a heading-order preference inside a dialog) and mixing them in makes
 * a real violation harder to see.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const scan = (page: Page, selector?: string) => {
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  return selector ? builder.include(selector) : builder;
};

/**
 * Wait until nothing is still fading.
 *
 * axe resolves a text node's contrast by walking up for a background, and an
 * ancestor at a fractional opacity has no answer to give — so every string
 * under a surface that is animating in comes back as a contrast violation. The
 * report overlay fades over 140 ms: shorter than it takes to notice, longer
 * than it takes for a scan fired on `toBeVisible` to land inside it. That is
 * how this spec came to report 22 serious violations against a document whose
 * colours were never in question, and only under load.
 *
 * The test is that opacity has stopped *changing*, not that it has reached 1:
 * plenty of this UI rests at a fractional opacity on purpose (a dimmed "Before"
 * label, a disabled button, an off-emphasis joint), so "everything is opaque"
 * is a state that never arrives.
 */
async function settled(page: Page) {
  const sample = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("*")]
        .map((el) => getComputedStyle(el).opacity)
        .join(","),
    );

  let previous = await sample();
  for (let i = 0; i < 25; i += 1) {
    await page.waitForTimeout(80);
    const next = await sample();
    if (next === previous) return;
    previous = next;
  }
}

/** Fails with the rule ids and the offending markup, not just a count. */
async function expectNoViolations(page: Page, where: string, selector?: string) {
  await settled(page);
  const { violations, passes } = await scan(page, selector).analyze();
  // An empty `violations` is only good news if the scan found something to
  // check. A run against a surface that had not rendered yet would be clean
  // for the wrong reason, which is the failure mode a green a11y gate has.
  expect(passes.length, `axe checked nothing on ${where}`).toBeGreaterThan(0);
  expect(
    violations.map((v) => ({
      surface: where,
      rule: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => n.html.slice(0, 200)),
    })),
    `axe violations on ${where}`,
  ).toEqual([]);
}

/** The rail row for N-07 once the storyline has raised it. */
const attentionRow = (page: Page) =>
  page
    .getByRole("link", { name: /N-07, Elm House\. (Attention|Alert)\./ })
    .and(page.locator('[data-slot="unit-card"]'));

/**
 * The golden path, in the steps the axe walks below share.
 *
 * One walk used to open every surface in sequence, which put twelve fixed
 * seconds of storyline — the amber lands at nine, the scan wants three more —
 * in front of eight full-page scans, and left the whole test four seconds
 * inside its budget on a good runner and outside it on a slow one. On a
 * two-core runner each scan costs about two seconds, so a walk carries no
 * more than three. The walks pay for the storyline each time and buy
 * themselves a budget of their own; a scan that times out is a gate that has
 * said nothing.
 */
async function openFleet(page: Page) {
  await page.goto("/");
  await expect(page.getByText(/8 units/i)).toBeVisible();
  await expect(page.locator('[data-slot="unit-card"]')).toHaveCount(8);
}

async function openIncident(page: Page) {
  await expect(attentionRow(page)).toBeVisible({ timeout: 20_000 });
  await attentionRow(page).click();
  await expect(page.getByRole("heading", { name: "N-07" })).toBeVisible();
  await expect(page.locator('[data-slot="incident-banner"]')).toBeVisible();
}

test("no axe violations on the operator surfaces the golden path opens", async ({
  page,
}) => {
  await openFleet(page);
  await expectNoViolations(page, "fleet page, quiet");

  // The fleet with an alert on it: status colour, the alert feed, the banner.
  await expect(attentionRow(page)).toBeVisible({ timeout: 20_000 });
  await expectNoViolations(page, "fleet page, alert raised");

  await openIncident(page);
  await expectNoViolations(page, "unit page with incident");
});

/** Into the dark diagnostic, as far as its first log line. */
async function startDescent(page: Page): Promise<Locator> {
  await page
    .locator('[data-slot="incident-banner"]')
    .getByRole("button", { name: "Run diagnostic" })
    .click();
  const overlay = page.getByRole("dialog", { name: /Diagnostic scan, unit N-07/ });
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await expect(overlay.getByRole("log", { name: "Subsystem walk" })).toContainText(
    "SCAN START",
    { timeout: 10_000 },
  );
  return overlay;
}

const verdictHeading = (overlay: Locator) =>
  overlay.getByRole("heading", { name: "KNEE_L · ACTUATOR A-07" });

test("no axe violations in machine space", async ({ page }) => {
  await openFleet(page);
  await openIncident(page);

  // Everything below here is phosphor on near-black, which is where a
  // contrast regression would actually land.
  const overlay = await startDescent(page);
  await expectNoViolations(page, "descent, mid-scan");

  await expect(verdictHeading(overlay)).toBeVisible({ timeout: 20_000 });
  await expectNoViolations(page, "verdict");

  // The confirm gate: an alertdialog over a dialog, the deepest focus trap here.
  await overlay.getByRole("button", { name: /^Command safe sit$/i }).click();
  await expect(overlay.getByRole("alertdialog")).toBeVisible();
  await expectNoViolations(page, "safe-sit confirm gate");
  await page.keyboard.press("Escape");
  await expect(overlay.getByRole("alertdialog")).toBeHidden();
});

test("no axe violations on the way back out, with the incident on file", async ({
  page,
}) => {
  await openFleet(page);
  await openIncident(page);
  const overlay = await startDescent(page);
  await expect(verdictHeading(overlay)).toBeVisible({ timeout: 20_000 });

  // Back in operator space with the incident on file, and the report it opens.
  await overlay.getByRole("button", { name: /return to console/i }).click();
  await expect(overlay).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Incident history" })).toBeVisible();
  await expectNoViolations(page, "unit page with incident history");

  await page.locator("[data-incident]").first().getByRole("button").first().click();
  const report = page.getByRole("dialog", { name: /incident/i });
  await expect(report).toBeVisible({ timeout: 10_000 });
  await expectNoViolations(page, "incident report");
});

test("the golden path is drivable from the keyboard alone", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-slot="unit-card"]')).toHaveCount(8);
  await expect(attentionRow(page)).toBeVisible({ timeout: 20_000 });

  /**
   * Tab until `test` is true, or give up. Not a fixed number of presses: the
   * rail is virtualized and the header's contents vary with connection state,
   * so the count is not stable — what has to be true is that the control is
   * *reachable*, and that every stop along the way shows where it is.
   */
  async function tabTo(test: () => Promise<boolean>, what: string, limit = 60) {
    for (let i = 0; i < limit; i += 1) {
      await page.keyboard.press("Tab");
      const focused = page.locator(":focus");
      if ((await focused.count()) > 0) {
        // Every focus stop must be visible — a keyboard user cannot use what
        // they cannot see, in either space.
        const outline = await focused.evaluate((el) => {
          const s = getComputedStyle(el);
          return `${s.outlineStyle} ${s.outlineWidth} ${s.boxShadow}`;
        });
        expect(outline, `focus ring at stop ${i} while looking for ${what}`).not.toBe(
          "none 0px none",
        );
      }
      if (await test()) return;
    }
    throw new Error(`never reached ${what} in ${limit} tab stops`);
  }

  // Into the failing unit from the rail, with Enter rather than a click.
  await tabTo(async () => {
    const href = await page.locator(":focus").getAttribute("href");
    return href === "/unit/N-07";
  }, "the N-07 rail row");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/unit\/N-07$/);
  await expect(page.getByRole("heading", { name: "N-07" })).toBeVisible();

  // Start the scan from the keyboard.
  const runDiagnostic = page
    .locator('[data-slot="incident-banner"]')
    .getByRole("button", { name: "Run diagnostic" });
  await expect(runDiagnostic).toBeVisible();
  await tabTo(
    async () => runDiagnostic.evaluate((el) => el === document.activeElement),
    "Run diagnostic",
  );
  await page.keyboard.press("Enter");

  const overlay = page.getByRole("dialog", { name: /Diagnostic scan, unit N-07/ });
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  // The descent moves focus itself: the verdict takes it when it lands, so a
  // keyboard user is put where the answer is instead of having to go find it.
  const verdict = overlay.locator('[data-slot="verdict-card"]');
  await expect(verdict).toBeFocused({ timeout: 20_000 });
  await expect(verdict).toHaveAccessibleName(/gain anomaly/i);

  // And Escape is the way back out, from inside machine space.
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Incident history" })).toBeVisible();
});
