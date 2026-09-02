import { expect, test } from "@playwright/test";

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
  await expect(
    overlay.getByRole("heading", { name: "KNEE_L · ACTUATOR A-07" }),
  ).toBeVisible();
  await expect(overlay.getByText(/^PARTIAL · RESIDUAL/)).toBeVisible();
  await expect(overlay.getByText(/GAIN DRIFT EXCLUDED · REMAINING/)).toBeVisible();

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

  // The conclusion amends without moving: the scan still found an offset on
  // ANKLE_R, and what is left of it is nothing.
  await expect(
    overlay.getByRole("heading", { name: "ANKLE_R · ACTUATOR A-12" }),
  ).toBeVisible();
  await expect(overlay.getByText(/^CLEARED · CHANNEL RESTORED · RESIDUAL/)).toBeVisible();

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
