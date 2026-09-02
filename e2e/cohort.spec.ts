import { expect, test } from "@playwright/test";

/**
 * The fleet-wide blast radius, end to end, against the same static
 * WorkerTransport artifact that deploys — built with the rollout storyline
 * compressed and the N-07/N-03 storylines parked (playwright.config.ts,
 * E2E_COHORT_ENV), on its own port so no other lane ever sees this fleet.
 *
 * What this walk is for: the console noticing that four alerts are ONE
 * incident, and the operator acting at fleet scale with the same safety
 * discipline the machine-space SAFE SIT control keeps. Every beat is asserted
 * by observed state — roles, visible text, bounded polls — never by sleeping to
 * a timestamp, because the claim is that the card SHOWS these things, not that
 * the sim emits them on schedule (the sim's own beats are covered
 * deterministically in sim/rollout.test.ts).
 */

const SIGNATURE = "Balance reflex latency above threshold";
const CANARY = "All on firmware 2.4.1 — 0 of 4 units on 2.3.7 affected";

test("cohort detected → rollout halted in time → staged rollback → resolution", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto("/");
  await expect(page.getByText(/8 units/i)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();

  const card = page.locator('[data-slot="cohort-card"]');
  const kpiAlerting = page
    .locator('[data-slot="stat-group"]')
    .filter({ hasText: "Units alerting" })
    .locator("dd");

  // --- Nothing is happening, and the page says so by saying nothing ---------
  await expect(card).toHaveCount(0);

  // --- Detection: four units, one build ------------------------------------
  // The card arrives at the third raise (the threshold) and grows to four.
  await expect(card).toBeVisible({ timeout: 40_000 });
  await expect(
    card.getByRole("heading", { name: "4 units raising the same warning" }),
  ).toBeVisible({ timeout: 20_000 });

  // The signature, quoted verbatim — the reason these four are one incident.
  await expect(card.getByText(`“${SIGNATURE}”`)).toBeVisible();
  // The canary comparison — the argument for touching a build rather than a
  // robot. This line is the whole epic in one sentence.
  await expect(card.getByText(CANARY)).toBeVisible();
  // Members, as doors.
  await expect(card.locator('[data-slot="cohort-member"]')).toHaveCount(4);
  // The queued fifth install: what HALT_ROLLOUT is racing.
  await expect(card.getByText(/N-05 is scheduled for 2\.4\.1/)).toBeVisible();

  // --- The KPI counts units, and it is honest here --------------------------
  await expect(kpiAlerting).toHaveText("4");

  // --- The feed groups without hiding anything ------------------------------
  const feedRows = page.locator('[data-slot="alert-row"]');
  await expect(feedRows).toHaveCount(4);
  await expect(page.locator('[data-slot="alert-row"][data-cohort="2.4.1"]')).toHaveCount(
    4,
  );
  await expect(feedRows.first().getByText("Cohort · 2.4.1")).toBeVisible();

  // --- The rail marks the members and prints their build --------------------
  // Asserted on the first two rows rather than on a count: the rail is
  // virtualized and the card has just taken a slice of its height, so which of
  // the eight rows are mounted is a layout question, not a claim worth pinning.
  const n02 = page.locator('[data-slot="unit-card"][data-unit="N-02"]');
  await expect(n02).toHaveAttribute("data-cohort", "true");
  await expect(n02).toContainText("2.4.1");
  // Unaffiliated rows stay clean: the version is not permanent clutter.
  const n01 = page.locator('[data-slot="unit-card"][data-unit="N-01"]');
  await expect(n01).not.toHaveAttribute("data-cohort", "true");
  await expect(n01).not.toContainText("2.3.7");

  // --- HALT ROLLOUT, with the gate in front of it ---------------------------
  await page.getByRole("button", { name: "Halt rollout" }).click();
  const gate = page.getByRole("alertdialog");
  await expect(gate).toBeVisible();
  await expect(
    gate.getByRole("heading", { name: "Halt the 2.4.1 rollout?" }),
  ).toBeVisible();
  await expect(gate.getByText("Prevents the scheduled update on N-05.")).toBeVisible();
  // The consequence the operator is most likely to drop: halting saves the
  // fifth unit and does nothing for the four already running the build.
  await expect(gate.getByText("Roll back the cohort to restore them.")).toBeVisible();
  // Focus is on the cancel, not on the dangerous control.
  await expect(gate.getByRole("button", { name: "Cancel" })).toBeFocused();

  // Escape aborts, and nothing has happened.
  await page.keyboard.press("Escape");
  await expect(gate).toHaveCount(0);
  await expect(card.getByText(/N-05 is scheduled for 2\.4\.1/)).toBeVisible();

  // Through the gate this time.
  await page.getByRole("button", { name: "Halt rollout" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm" }).click();

  // The receipt: the demonstrable non-event this storyline is built around.
  await expect(card.getByText("Rollout halted — N-05 remains on 2.3.7")).toBeVisible({
    timeout: 15_000,
  });

  // Halting fixed nothing yet: four units are still alerting.
  await expect(kpiAlerting).toHaveText("4");

  // --- ROLL BACK COHORT: staged, watched, and self-clearing -----------------
  await page.getByRole("button", { name: "Roll back cohort" }).click();
  const rollbackGate = page.getByRole("alertdialog");
  await expect(
    rollbackGate.getByRole("heading", { name: "Roll back 4 units from 2.4.1?" }),
  ).toBeVisible();
  // The staging and the expected duration: the operator is about to watch a
  // queue drain, not press a button and be finished.
  await expect(
    rollbackGate.getByText("Rolls back 4 units, one at a time — about 16 seconds."),
  ).toBeVisible();
  await expect(
    rollbackGate.getByText("Alerts clear as each unit completes."),
  ).toBeVisible();
  await rollbackGate.getByRole("button", { name: "Confirm" }).click();

  // Per-unit progress: one row per unit, exactly one underway at a time.
  const progress = card.locator('[data-slot="rollback-unit"]');
  await expect(progress).toHaveCount(4, { timeout: 15_000 });
  await expect(
    card.locator('[data-slot="rollback-unit"][data-phase="rolling-back"]'),
  ).toHaveCount(1);

  // The alerts clear themselves as each unit lands — the feed showing it
  // happening, which is why the card never duplicates the feed.
  await expect(
    card.getByText(/Rollback complete — 4 units restored to 2\.3\.7\./),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    card.locator('[data-slot="rollback-unit"][data-phase="restored"]'),
  ).toHaveCount(4);

  // --- Honest at the end, on every counter ---------------------------------
  await expect(kpiAlerting).toHaveText("0", { timeout: 15_000 });
  // The card cools to the nominal tier and changes tense with the fleet: a
  // warn-ground card reading "raising" over "Units alerting 0" would be the
  // loudest thing on the page arguing with the band above it.
  await expect(card).toHaveAttribute("data-settled", "true");
  await expect(
    card.getByRole("heading", { name: "4 units raised the same warning" }),
  ).toBeVisible();
  // The rows are resolved, not deleted: the default "Open" filter empties, and
  // the audit trail still holds all four (alert-rail.tsx).
  await expect(
    page.getByText(/No open alerts\. 4 alerts resolved this session\./),
  ).toBeVisible();
  // The marks leave with the incident.
  await expect(n02).not.toHaveAttribute("data-cohort", "true");
  await expect(page.locator('[data-slot="alert-row"][data-cohort]')).toHaveCount(0);

  // --- Resolution: the operator closes it, and the space closes with it -----
  // One door out, and it is a RECORD action: no confirmation, nothing on the
  // wire. Clearing a receipt puts away a command; closing an incident is a
  // different sentence, and the settled card offers only the second.
  await expect(card.getByRole("button", { name: /^Clear / })).toHaveCount(0);
  await card.getByRole("button", { name: "Resolve incident" }).click();
  await expect(card).toBeHidden();
  // …and the collapse actually retires it, rather than leaving a clipped card
  // in the page for the rest of the session.
  await expect(page.locator('[data-slot="cohort-reveal"]')).toHaveCount(0, {
    timeout: 10_000,
  });
  // The incident closes; the record does not.
  const record = page.locator('[data-slot="cohort-record"]');
  await expect(record).toContainText(
    "4 units raised the same warning on 2.4.1 — incident closed.",
  );
  const door = record.locator('[data-slot="cohort-report-link"]');
  await expect(door).toBeFocused();
  await door.click();
  await expect(
    page.locator('[data-slot="incident-report"][data-scope="fleet"]'),
  ).toBeVisible();
});
