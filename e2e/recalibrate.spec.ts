import { expect, test, type Locator } from "@playwright/test";
import { useMachineView } from "./diagnostic-view";

/**
 * The rendered colour of a token, resolved in the same element's context.
 *
 * Machine space's palette is CSS variables on `[data-space="machine"]`, so
 * "is this line alert red or phosphor" cannot be asked of a class name — a
 * class name is what the component *believes*. This paints the token onto a
 * throwaway span inside the element under test and reads back what the browser
 * actually computed, which is the only form of the question that can fail when
 * the token ladder moves.
 */
async function tokenColor(el: Locator, token: string): Promise<string> {
  return el.evaluate((node, name) => {
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(node).getPropertyValue(name).trim();
    node.appendChild(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, token);
}

/**
 * the branch the golden path deliberately does not take.
 *
 * The 90-second walk ends at the verdict and ascends, because that walk IS the
 * product and a demo that requires two maneuvers to reach its point is a demo
 * with a longer point. This spec is the "and there is more": sit the robot
 * down, run the cheapest fix, and watch the console argue with its own evidence
 * about whether that was enough.
 *
 * Same build and same lane as the golden path (playwright.config.ts): the N-07
 * storyline is already compressed there, and this walk needs exactly it.
 *
 * Everything is asserted by observed state — the gate's own label, the wire's
 * own words, the numbers under the trace — never by sleeping to a beat.
 */
/* These walk the dark diagnostic, which is opt-in: the console now opens a
   scan in the calm operator-space panel by default. */
test.beforeEach(async ({ page }) => {
  await useMachineView(page);
});

test("verdict → safe sit → recalibrate → partial result on the evidence", async ({
  page,
}) => {
  test.setTimeout(90_000);

  await page.goto("/unit/N-07");
  const banner = page.locator('[data-slot="incident-banner"]');
  await banner.getByRole("button", { name: "Run diagnostic" }).click();

  const overlay = page.getByRole("dialog", { name: /Diagnostic scan, unit N-07/ });
  await expect(overlay).toBeVisible({ timeout: 15_000 });
  await expect(
    overlay.getByRole("heading", { name: "KNEE_L · ACTUATOR A-07" }),
  ).toBeVisible({ timeout: 20_000 });

  // --- The gate: the cheap fix is offered, and is not pressable yet ----------
  // The robot is walking on the joint. This is the state the whole ordering
  // argument rests on: RECALIBRATE is visible (the report recommended it), says
  // why it cannot run, and sending is impossible rather than merely discouraged.
  const gated = overlay.getByRole("button", {
    name: /^Recalibrate joint · REQUIRES SEATED POSTURE$/i,
  });
  await expect(gated).toBeVisible();
  await expect(gated).toBeDisabled();
  // Its own note, not DISABLE JOINT's: both gates are up at this moment,
  // which is the correct reading of a robot that is standing on the joint.
  await expect(
    overlay.getByText(/^Unloaded sweep · permitted only while seated$/i),
  ).toBeVisible();

  // --- SAFE SIT: the precondition, executed ---------------------------------
  await overlay.getByRole("button", { name: /^Command safe sit$/i }).click();
  const sitConfirm = overlay.getByRole("alertdialog");
  await expect(sitConfirm).toBeVisible();
  await expect(sitConfirm.getByText(/service still required/i)).toBeVisible();
  await sitConfirm.getByRole("button", { name: /^Confirm$/i }).click();
  // Twice on screen by design: the card's own readout and the status rule that
  // outlives the card (CommandStatusLine). Either is proof the maneuver landed.
  await expect(overlay.getByText("SAFE SIT COMPLETE").first()).toBeVisible({
    timeout: 20_000,
  });

  // The gate lifts on the settle beat's unit_update — no reload, no re-scan.
  const recalibrate = overlay.getByRole("button", { name: /^Recalibrate joint$/i });
  await expect(recalibrate).toBeEnabled({ timeout: 15_000 });

  // --- The maneuver ----------------------------------------------------------
  await recalibrate.click();
  const confirm = overlay.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  // The line that keeps the partial result from reading as a broken promise.
  await expect(confirm.getByText(/calibration corrects gain, not wear/i)).toBeVisible();
  await confirm.getByRole("button", { name: /^Confirm$/i }).click();

  // Narrated in the machine's own words, then finished.
  await expect(overlay.getByText("RECALIBRATION COMPLETE").first()).toBeVisible({
    timeout: 25_000,
  });
  // …and in the live region at the foot of the instrument, which is where a
  // screen reader hears it whether or not the card is still open.
  await expect(overlay.locator('[data-slot="command-status"]')).toHaveText(
    "RECALIBRATION COMPLETE",
  );

  // --- The payoff: the exhibit is re-drawn against its own earlier self ------
  const subject = overlay.locator('[data-evidence="knee_L"]');
  await expect(subject.locator('[data-role="pre"]')).toBeVisible();
  await expect(subject.locator('[data-role="live"]')).toBeVisible();
  // Current reading in the primary row, with what it came down from under it.
  await expect(subject).toContainText(/× REF/i);
  await expect(subject).toContainText(/WAS 1\.7\d×/i);
  await expect(subject).toContainText(/WAS 0\.1\d\d/i);

  // …and the conclusion amends rather than moves: the scan still found a gain
  // anomaly, and what is left of it is now mechanical.
  const partialHeadline = overlay.getByRole("heading", {
    name: "KNEE_L · ACTUATOR A-07",
  });
  await expect(partialHeadline).toBeVisible();
  // The outcome rides on the anomaly line, and PARTIAL is amber against an
  // anomaly still in alert: two facts, two tones, one line.
  const partialAnomaly = overlay.locator('[data-slot="verdict-anomaly"]');
  await expect(partialAnomaly).toHaveText(/^GAIN ANOMALY · PARTIAL$/i);
  await expect(
    overlay.getByText(/^RESIDUAL 1\.\d\d× REFERENCE · MECHANICAL WEAR/),
  ).toBeVisible();
  await expect(overlay.getByText(/GAIN DRIFT EXCLUDED · REMAINING/)).toBeVisible();

  // The register the cleared branch below is measured against. A partial stays
  // loud: the headline is alert red, the exhibit is still framed in alert, and
  // the session header's phase chip is still the amber VERDICT.
  const partialCard = overlay.locator('[data-slot="verdict-card"]');
  await expect(partialCard).toHaveAttribute("data-outcome", "partial");
  // The elevation stays red with the fault: same drawing, opposite reading.
  await expect(
    overlay.getByRole("img", { name: /knee L marked damaged/i }),
  ).toBeVisible();
  // The frame follows the measurement, not the fact that a maneuver ran: the
  // scripted partial lands the channel in the warn band (sim/engine/faults.ts
  // holds that as a contract), so the exhibit steps down one tier and stops
  // there. What it must never do here is reach nominal.
  await expect(overlay.locator('[data-evidence="knee_L"]')).toHaveAttribute(
    "data-tone",
    "warn",
  );
  await expect(overlay.getByText(/^VERDICT$/)).toBeVisible();
  // The tone, read off the browser rather than off a class name. The cleared
  // walk below makes the mirror-image assertion, and between them the two
  // outcomes are pinned to be told apart at a glance.
  const partialColor = await partialHeadline.evaluate((el) => getComputedStyle(el).color);
  expect(partialColor).toBe(await tokenColor(partialHeadline, "--alert"));
  expect(partialColor).not.toBe(await tokenColor(partialHeadline, "--nominal"));

  // --- Dispatch is now the earned next step, and still only files ------------
  const dispatch = overlay.getByRole("button", { name: /^Dispatch service$/i });
  await expect(dispatch).toBeEnabled();
  await dispatch.click();
  await expect(
    overlay.getByRole("button", { name: /Dispatch service · recorded/i }),
  ).toBeDisabled();

  // --- Ascent: the report carries what was tried and what it was worth -------
  await overlay.getByRole("button", { name: /return to console/i }).click();
  await expect(overlay).toBeHidden({ timeout: 10_000 });

  // The row's reference IS the way in to the report.
  await page
    .getByRole("button", { name: /^Open incident report/i })
    .first()
    .click();
  const report = page.locator(`[data-report]`);
  await expect(report).toBeVisible({ timeout: 10_000 });
  await expect(
    report.getByText(/unloaded recalibration was run over the link/i),
  ).toBeVisible();
  // The ladder climbed: a remote attempt, then a technician.
  await expect(report.getByText(/field service/i).first()).toBeVisible();
  await expect(
    report.locator('[data-evidence="knee_L"] [data-role="pre"]'),
  ).toBeVisible();
});

/**
 * the second ending, and the reason the first one is worth telling.
 *
 * Same button, a different diagnosis, a different rung. N-07's knee is a gain
 * anomaly over tendon wear, so the cheap fix is worth something and not enough
 * — which is what earns the van. N-01's right ankle is an encoder whose zero has
 * drifted, and re-zeroing an encoder is exactly what a calibration is, so here
 * the ladder stops at remote operations and nobody drives anywhere.
 *
 * This walk needs no compressed storyline of its own, and that is a property of
 * the fault rather than a convenience: an encoder zero does not ramp. It drifted
 * before the run began, so the channel is displaced from the first sample and
 * the scan finds it whenever one is asked for — at 0:10 exactly as at 5:31, when
 * the unit's own gait-asymmetry estimator finally trips and raises the amber.
 * The alert-clear half of the act is pinned in sim/recalibrate.test.ts, against
 * the wire, where a beat can be reached without waiting for one.
 */
test("offset verdict → safe sit → recalibrate → cleared, and the ladder stops", async ({
  page,
}) => {
  test.setTimeout(90_000);

  await page.goto("/unit/N-01");
  await page
    .getByRole("button", { name: /^Run diagnostic$/i })
    .first()
    .click();

  const overlay = page.getByRole("dialog", { name: /Diagnostic scan, unit N-01/ });
  await expect(overlay).toBeVisible({ timeout: 15_000 });

  // --- The verdict: a different joint, a different kind of wrong -------------
  await expect(
    overlay.getByRole("heading", { name: "ANKLE_R · ACTUATOR A-12" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(overlay.getByText(/^offset anomaly$/i)).toBeVisible();
  // Its own differential, from the table — not the knee's.
  await expect(
    overlay.getByText(/CONSISTENT WITH ENCODER ZERO DRIFT · MOUNT SHIFT/),
  ).toBeVisible();
  // The machine's own words carry the half that distinguishes the two faults:
  // the shape is right, the datum is not.
  await expect(overlay.getByText(/ENVELOPE INTACT/)).toBeVisible();
  // A joint that carries load perfectly well is not one to take out of service.
  await expect(overlay.getByRole("button", { name: /^Disable joint/i })).toHaveCount(0);

  // --- The same gate, on the same button ------------------------------------
  await expect(
    overlay.getByRole("button", {
      name: /^Recalibrate joint · REQUIRES SEATED POSTURE$/i,
    }),
  ).toBeDisabled();

  await overlay.getByRole("button", { name: /^Command safe sit$/i }).click();
  await overlay
    .getByRole("alertdialog")
    .getByRole("button", { name: /^Confirm$/i })
    .click();
  await expect(overlay.getByText("SAFE SIT COMPLETE").first()).toBeVisible({
    timeout: 20_000,
  });

  const recalibrate = overlay.getByRole("button", { name: /^Recalibrate joint$/i });
  await expect(recalibrate).toBeEnabled({ timeout: 15_000 });
  await recalibrate.click();

  // The confirmation states the limit of THIS calibration, not the knee's: an
  // operator whose robot has no gain fault is not told about gain.
  const confirm = overlay.getByRole("alertdialog");
  await expect(
    confirm.getByText(/calibration corrects the datum, not the mounting/i),
  ).toBeVisible();
  await expect(confirm.getByText(/corrects gain, not wear/i)).toHaveCount(0);
  await confirm.getByRole("button", { name: /^Confirm$/i }).click();

  await expect(overlay.getByText("RECALIBRATION COMPLETE").first()).toBeVisible({
    timeout: 25_000,
  });

  // --- The payoff: the channel came back ------------------------------------
  const subject = overlay.locator('[data-evidence="ankle_R"]');
  await expect(subject.locator('[data-role="pre"]')).toBeVisible();
  await expect(subject.locator('[data-role="live"]')).toBeVisible();
  // The reading that carries this fault's story is the displacement, and it
  // collapses by an order of magnitude. The amplitude ratio barely moves, which
  // is exactly why the copy refuses to state an offset in it.
  await expect(subject).toContainText(/WAS 0\.2\d\d/i);
  await expect(subject).toContainText(/RMS Δ 0\.0\d\d/i);

  // --- The register of the whole board changes, not one line of it ----------
  // The conclusion amends without moving: the scan still found an offset on
  // ANKLE_R, and what is left of it is nothing.
  const headline = overlay.getByRole("heading", { name: "ANKLE_R · ACTUATOR A-12" });
  await expect(headline).toBeVisible();
  await expect(overlay.locator('[data-slot="verdict-card"]')).toHaveAttribute(
    "data-outcome",
    "cleared",
  );
  // The loudest object in machine space is no longer red — the mirror image of
  // the partial walk's assertion above, and the claim this whole change exists
  // to make. Read off the browser, not off a class name.
  const clearedColor = await headline.evaluate((el) => getComputedStyle(el).color);
  expect(clearedColor).toBe(await tokenColor(headline, "--nominal"));
  expect(clearedColor).not.toBe(await tokenColor(headline, "--alert"));

  // The anomaly line carries the outcome, and the summary is dated rather than
  // left standing in the present tense over a measurement that has moved.
  await expect(overlay.locator('[data-slot="verdict-anomaly"]')).toHaveText(
    /^OFFSET ANOMALY · CLEARED$/i,
  );
  await expect(overlay.getByText(/^At scan · RIGHT ANKLE ACTUATOR A-12/i)).toBeVisible();
  await expect(
    overlay.getByText(/RE-MEASURED AFTER CALIBRATION: CHANNEL WITHIN REFERENCE/),
  ).toBeVisible();
  await expect(overlay.getByText(/CHANNEL RESTORED · RESIDUAL/)).toBeVisible();

  // The exhibit's frame follows the measurement inside it…
  await expect(subject).toHaveAttribute("data-tone", "nominal");
  await expect(subject.getByText(/^BEFORE$/i)).toBeVisible();
  await expect(subject.getByText(/^AFTER$/i)).toBeVisible();

  // …the board's one inverted stamp goes from red DAMAGED to phosphor RESTORED…
  await expect(overlay.locator('[data-row="ANKLE_R"]')).toHaveAttribute(
    "data-state",
    "restored",
  );
  await expect(overlay.locator('[data-row="ANKLE_R"]')).toContainText(/RESTORED/i);

  // …the drawing beside the inventory stops marking the limb damaged, which is
  // the one claim on the board a canvas cannot be asked for in pixels…
  await expect(
    overlay.getByRole("img", { name: /ankle R marked restored/i }),
  ).toBeVisible();
  await expect(overlay.getByRole("img", { name: /ankle R marked damaged/i })).toHaveCount(
    0,
  );

  // …the session header's phase chip reads the resolution rather than amber
  // VERDICT, which is exactly what tells this state apart from the partial one…
  await expect(overlay.getByText(/^CLEARED$/)).toBeVisible();
  await expect(overlay.getByText(/^VERDICT$/)).toHaveCount(0);

  // …and the footer agrees with all of it.
  await expect(
    overlay.getByText(/SCAN COMPLETE · \d\d CHANNELS · 01 ANOMALY CLEARED/),
  ).toBeVisible();

  // The escalation is no longer offered as if it were needed. It is not hidden
  // — the report recommended it — it is inert, with the reason on the label.
  const notIndicated = overlay.getByRole("button", {
    name: /^Dispatch service · NOT INDICATED$/i,
  });
  await expect(notIndicated).toBeDisabled();
  await expect(
    overlay.getByText(/^CHANNEL RESTORED · ESCALATION NO LONGER INDICATED$/i),
  ).toBeVisible();

  // The receipts stay: they are the audit of what was done to the robot.
  await expect(overlay.getByText("RECALIBRATION COMPLETE").first()).toBeVisible();

  // --- Ascent: the report files it at rung two, and stops there --------------
  await overlay.getByRole("button", { name: /return to console/i }).click();
  await expect(overlay).toBeHidden({ timeout: 10_000 });

  await page
    .getByRole("button", { name: /^Open incident report/i })
    .first()
    .click();
  const report = page.locator(`[data-report]`);
  await expect(report).toBeVisible({ timeout: 10_000 });
  await expect(report.getByText(/the fault cleared without a visit/i)).toBeVisible();
  // The one line of the filed document that says how expensive this got.
  await expect(report.getByText(/remote operations/i).first()).toBeVisible();
  await expect(report.getByText(/field service/i)).toHaveCount(0);
  await expect(report.getByText(/depot/i)).toHaveCount(0);
  // …and the measurement is stated in its own units, not as a gain.
  await expect(report.getByText(/trace displaced 0\.2\d\d from datum/i)).toBeVisible();
});
