import { expect, test, type Page } from "@playwright/test";

/**
 * The golden path under `prefers-reduced-motion: reduce` (audit finding #5).
 *
 * Every reduced-motion branch in this product has a unit test against a stubbed
 * `matchMedia`, and none of that proves the five implementations — a CSS clamp,
 * framer variants, rAF springs with explicit branches, a canvas turntable, and
 * MapLibre's own `essential: false` skip — compose when the preference is real.
 * This project (playwright.config.ts) runs the same seeded build as the desktop
 * lane with `reducedMotion: "reduce"` on the context, and asserts the CONTRACT
 * at each surface: what is on screen, sampled at frame granularity, never the
 * animation library's internals.
 *
 * Two tests, not one, because two surfaces need to be *watched during the same
 * alert beat*: the fleet map's camera and the unit page's banner arrival. Each
 * test boots its own worker sim, so each gets its own 9-second amber to stand
 * in front of.
 *
 * Frame sampling is in-page (MutationObserver to catch the mount commit, then
 * requestAnimationFrame), because the contract is per-frame — "no travel", "full
 * height on the arrival frame" — and a Playwright poll from outside the page
 * cannot see frames.
 */

/** Computed `transform` values that mean "this element is not translated". */
const IDENTITY = ["none", "matrix(1, 0, 0, 1, 0, 0)"];

interface MarkerSample {
  t: number;
  x7: number;
  y7: number;
  x1: number;
  y1: number;
}

interface FrameSample {
  t: number;
  transform: string;
  opacity: number;
}

/** Viewport centres of the N-07 and N-01 map markers, right now. */
function markerCenters(page: Page) {
  return page.evaluate(() => {
    const centre = (id: string) => {
      const el = document.querySelector(`.fleet-marker[data-unit="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    };
    return { n07: centre("N-07"), n01: centre("N-01") };
  });
}

test("fleet: the alert beat lands the camera with zero travel frames", async ({
  page,
}) => {
  test.setTimeout(60_000);

  await page.goto("/");
  await expect(page.getByText(/8 units/i)).toBeVisible();
  await expect(page.locator(".fleet-marker")).toHaveCount(8, { timeout: 20_000 });

  // Reference positions from before the alert. The guard makes the one race
  // this test has legible: if the amber beat (9 s compressed) somehow landed
  // before this line, fail here with a reason rather than downstream with a
  // shrug. Page load to this point is ~2-3 s, so the window is wide.
  await expect(
    page.locator('[data-slot="alert-row"]'),
    "alert arrived before the pre-alert reference sample — runner stalled >6s",
  ).toHaveCount(0);
  const before = await markerCenters(page);
  expect(before.n07).not.toBeNull();
  expect(before.n01).not.toBeNull();

  /**
   * Now stand in front of the alert. In-page: wait (at rAF cadence) for the
   * feed row that arrives in the same commit as the status flip, then sample
   * two marker centres every frame for 1.6 s — longer than the 1.4 s ease the
   * full-motion path would run. MapLibre repositions marker DOM on every
   * camera frame, so the markers ARE the camera, read from outside the WebGL
   * context.
   *
   * Under reduced motion MapLibre skips the non-essential `easeTo` outright
   * (duration 0, applied synchronously in the same task as the store commit),
   * so the first sample is already post-jump and every later sample matches
   * it. Under full motion these samples would sweep for 1.4 s.
   */
  const watch = await page.evaluate(() => {
    return new Promise<{ error?: string; samples: MarkerSample[] }>((resolve) => {
      const centre = (id: string) => {
        const el = document.querySelector(`.fleet-marker[data-unit="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      };
      const samples: MarkerSample[] = [];
      const armed = performance.now();
      const tick = () => {
        if (performance.now() - armed > 25_000) {
          resolve({ error: "alert never arrived", samples });
          return;
        }
        if (!document.querySelector('[data-slot="alert-row"]')) {
          requestAnimationFrame(tick);
          return;
        }
        const t0 = performance.now();
        const sample = () => {
          const a = centre("N-07");
          const b = centre("N-01");
          if (!a || !b) {
            resolve({ error: "marker vanished mid-sample", samples });
            return;
          }
          samples.push({
            t: performance.now() - t0,
            x7: a.x,
            y7: a.y,
            x1: b.x,
            y1: b.y,
          });
          if (performance.now() - t0 < 1600) requestAnimationFrame(sample);
          else resolve({ samples });
        };
        sample();
      };
      tick();
    });
  });

  expect(watch.error).toBeUndefined();
  // A real rAF cadence over 1.6 s, not three sleepy polls.
  expect(watch.samples.length).toBeGreaterThan(40);

  // 1. No travel: across the whole post-alert window, neither marker moves.
  const spread = (pick: (s: MarkerSample) => number) => {
    const values = watch.samples.map(pick);
    return Math.max(...values) - Math.min(...values);
  };
  for (const axis of [
    (s: MarkerSample) => s.x7,
    (s: MarkerSample) => s.y7,
    (s: MarkerSample) => s.x1,
    (s: MarkerSample) => s.y1,
  ]) {
    expect(spread(axis), "camera travelled during the alert beat").toBeLessThan(1.5);
  }

  // 2. ...but the camera DID end up on the alert — the ease was skipped, not
  // the destination. The jump recentres on N-07 and steps the zoom, so the
  // markers land somewhere new relative to the pre-alert fit.
  const first = watch.samples[0]!;
  const moved =
    Math.hypot(first.x7 - (before.n07?.x ?? 0), first.y7 - (before.n07?.y ?? 0)) > 4 ||
    Math.hypot(first.x1 - (before.n01?.x ?? 0), first.y1 - (before.n01?.y ?? 0)) > 4;
  expect(moved, "camera never moved at all — the alert ease did not fire").toBe(true);
});

test("unit → descent → verdict → return: every surface swaps without travelling", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // Straight to the unit page, before the alert: the banner test below is
  // about its *arrival* branch (a banner pushing into an already-read
  // page), and a banner that is part of the first paint takes the instant
  // branch in both timelines and proves nothing.
  await page.goto("/unit/N-07");
  await expect(page.getByRole("heading", { name: "N-07" })).toBeVisible();
  await expect(
    page.locator('[data-slot="incident-banner"]'),
    "banner present before the alert — the arrival branch is not being exercised",
  ).toHaveCount(0);

  // --- the banner arrives at full height on its first frame ----------
  // Watcher armed before the alert: catch the reveal wrapper's mount commit
  // (MutationObserver fires after React's layout effects, i.e. after the
  // full-motion path would have written its 0px opening frame), then measure
  // the wrapper's laid-out height for six consecutive frames. Reduced motion
  // means no height spring: every sample is the banner's full height, from
  // frame zero.
  await page.evaluate(() => {
    const w = window as unknown as { __rmBanner?: Promise<number[]> };
    w.__rmBanner = new Promise<number[]>((resolve) => {
      const find = () =>
        document.querySelector<HTMLElement>('[data-slot="incident-reveal"]');
      const start = (el: HTMLElement) => {
        const heights: number[] = [];
        const sample = () => {
          heights.push(el.getBoundingClientRect().height);
          if (heights.length >= 6) resolve(heights);
          else requestAnimationFrame(sample);
        };
        sample();
      };
      const now = find();
      if (now) {
        start(now);
        return;
      }
      const mo = new MutationObserver(() => {
        const el = find();
        if (!el) return;
        mo.disconnect();
        start(el);
      });
      mo.observe(document.body, { childList: true, subtree: true });
    });
  });

  const banner = page.locator('[data-slot="incident-banner"]');
  await expect(banner).toBeVisible({ timeout: 25_000 });
  const heights = await page.evaluate(
    () => (window as unknown as { __rmBanner?: Promise<number[]> }).__rmBanner,
  );
  expect(heights).toBeDefined();
  const settled = (await banner.boundingBox())?.height ?? 0;
  expect(settled).toBeGreaterThan(40);
  for (const h of heights ?? []) {
    // Full height immediately — the honest layout shift, not a watched spring.
    expect(Math.abs(h - settled), "banner opened over multiple frames").toBeLessThan(1.5);
  }

  // --- The descent arrives as the REDUCED crossfade --------------------------
  // The moving element in the full timeline is the surface (the dialog's
  // parent): translateY(100%) → 0 over 350 ms. In the reduced timeline it may
  // only ever fade. Sample its computed transform and opacity every frame from
  // the mount commit: no sample may carry a translation, the first sample is
  // mid-fade (it *arrived* by opacity), and it settles on the ~200 ms reduced
  // clock rather than the 1.1 s full one.
  await page.evaluate(() => {
    const w = window as unknown as { __rmDescent?: Promise<FrameSample[]> };
    w.__rmDescent = new Promise<FrameSample[]>((resolve) => {
      const mo = new MutationObserver(() => {
        const dialog = document.querySelector<HTMLElement>(
          '[data-space="machine"][role="dialog"]',
        );
        const surface = dialog?.parentElement;
        if (!surface) return;
        mo.disconnect();
        const samples: FrameSample[] = [];
        const t0 = performance.now();
        const sample = () => {
          const cs = getComputedStyle(surface);
          samples.push({
            t: performance.now() - t0,
            transform: cs.transform,
            opacity: Number(cs.opacity),
          });
          if (performance.now() - t0 < 800) requestAnimationFrame(sample);
          else resolve(samples);
        };
        sample();
      });
      mo.observe(document.body, { childList: true, subtree: true });
    });
  });

  // The banner's pill, not any button reading "Run diagnostic": a
  // nominal unit carries the same action in its identity header, and only the
  // banner's presence means the incident is live.
  await banner.getByRole("button", { name: "Run diagnostic" }).click();
  const overlay = page.getByRole("dialog", { name: /Diagnostic scan, unit N-07/ });
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  const entry = await page.evaluate(
    () => (window as unknown as { __rmDescent?: Promise<FrameSample[]> }).__rmDescent,
  );
  expect(entry).toBeDefined();
  expect(entry!.length).toBeGreaterThan(20);
  for (const s of entry!) {
    expect(IDENTITY, `surface translated during RM entry at t=${s.t}ms`).toContain(
      s.transform,
    );
  }
  expect(entry![0]!.opacity, "surface popped in rather than crossfading").toBeLessThan(
    0.5,
  );
  const settledAt = entry!.find((s) => s.opacity >= 0.99);
  expect(settledAt, "crossfade never completed inside the sample window").toBeDefined();
  expect(settledAt!.t, "entry ran long — not the 200ms reduced timeline").toBeLessThan(
    700,
  );

  // The reduced branch's own frame line: the static edge, not the travelling
  // one. (In the full timeline this class does not exist.)
  await expect(overlay.locator(".descent-edge--static")).toHaveCount(1);

  // --- diag-sweep: gone entirely, not frozen ----------------------------------
  // The banner behind the overlay is in its "running" state, which renders the
  // sweep element; under the preference the stylesheet removes it outright
  // (display: none — a parked segment would read as a stalled progress bar).
  const sweep = page.locator(".diag-sweep");
  await expect(sweep).toHaveCount(1);
  await expect(sweep).toBeHidden();

  // --- Verdict, and a wireframe that holds still ------------------------------
  const headline = overlay.getByRole("heading", { name: "KNEE_L · ACTUATOR A-07" });
  await expect(headline).toBeVisible({ timeout: 40_000 });
  await expect(overlay.locator('[data-slot="wireframe-elevation"] canvas')).toHaveCount(
    1,
    { timeout: 15_000 },
  );

  // Yaw pinned: the turntable redraws only when something changed, and under
  // reduced motion nothing does — two reads of the same canvas a second apart
  // are byte-identical. (Full motion turns 3°/s and repaints every frame.)
  // Sampled at the verdict, after the flag: no channel lifts remain to decay.
  const grab = () =>
    page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '[data-slot="wireframe-elevation"] canvas',
      );
      return canvas ? canvas.toDataURL() : "missing";
    });
  const shot1 = await grab();
  expect(shot1).toMatch(/^data:image\/png/);
  expect(shot1.length, "wireframe canvas is blank").toBeGreaterThan(5000);
  await page.waitForTimeout(1000);
  const shot2 = await grab();
  expect(shot2, "wireframe redrew — yaw is not pinned").toBe(shot1);

  // --- Column reset: one frame, no spring -------------------------------------
  // Drag a divider off its designed width, double-click it home. The reduced
  // branch hands the column straight back to the stylesheet: by the first
  // read after the gesture the width is already the designed one, and the next
  // frame agrees — no interpolation to watch.
  const logPanel = page.locator('.scan-grid [data-area="log"]');
  const designed = (await logPanel.boundingBox())?.width ?? 0;
  expect(designed).toBeGreaterThan(200);

  const handle = page.locator('.scan-handle[data-edge="log"]');
  const hb = await handle.boundingBox();
  expect(hb).not.toBeNull();
  const hx = (hb?.x ?? 0) + (hb?.width ?? 0) / 2;
  const hy = (hb?.y ?? 0) + (hb?.height ?? 0) / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + 90, hy, { steps: 6 });
  await page.mouse.up();
  const dragged = (await logPanel.boundingBox())?.width ?? 0;
  expect(dragged - designed, "divider drag did not take").toBeGreaterThan(40);

  await handle.dblclick();
  const reset = await page.evaluate(() => {
    return new Promise<{
      error?: string;
      override?: string;
      valuenow?: string | null;
      w0?: number;
      w1?: number;
    }>((resolve) => {
      const grid = document.querySelector<HTMLElement>(".scan-grid");
      const el = grid?.querySelector<HTMLElement>('[data-area="log"]');
      const h = document.querySelector<HTMLElement>('.scan-handle[data-edge="log"]');
      if (!grid || !el || !h) {
        resolve({ error: "grid missing" });
        return;
      }
      const override = grid.style.getPropertyValue("--scan-log");
      const valuenow = h.getAttribute("aria-valuenow");
      const w0 = el.getBoundingClientRect().width;
      requestAnimationFrame(() => {
        resolve({ override, valuenow, w0, w1: el.getBoundingClientRect().width });
      });
    });
  });
  expect(reset.error).toBeUndefined();
  // The stylesheet owns the column again, synchronously with the gesture…
  expect(reset.override, "inline override survived the RM reset").toBe("");
  // …the width is the designed one on the first frame…
  expect(Math.abs((reset.w0 ?? 0) - designed)).toBeLessThanOrEqual(1.5);
  // …and the next frame is identical: nothing is travelling.
  expect(Math.abs((reset.w1 ?? 0) - (reset.w0 ?? 0))).toBeLessThanOrEqual(0.1);
  // The receipt of the clamp regression this lane found: with 0.01ms
  // transitions in the RM clamp, the reset's own measurement read yesterday's
  // layout and published the DRAGGED width to assistive tech, permanently.
  expect(Number(reset.valuenow)).toBe(Math.round(reset.w0 ?? 0));

  // --- RETURN: the ascent is the same crossfade, backwards --------------------
  await page.evaluate(() => {
    const w = window as unknown as {
      __rmExit?: Promise<{ samples: FrameSample[]; detachedAt: number | null }>;
    };
    const dialog = document.querySelector<HTMLElement>(
      '[data-space="machine"][role="dialog"]',
    );
    const surface = dialog?.parentElement;
    w.__rmExit = new Promise((resolve) => {
      if (!surface) {
        resolve({ samples: [], detachedAt: null });
        return;
      }
      const samples: FrameSample[] = [];
      const t0 = performance.now();
      const sample = () => {
        if (!surface.isConnected) {
          resolve({ samples, detachedAt: performance.now() - t0 });
          return;
        }
        const cs = getComputedStyle(surface);
        samples.push({
          t: performance.now() - t0,
          transform: cs.transform,
          opacity: Number(cs.opacity),
        });
        if (performance.now() - t0 < 3000) requestAnimationFrame(sample);
        else resolve({ samples, detachedAt: null });
      };
      sample();
    });
  });

  await overlay.getByRole("button", { name: /return to console/i }).click();
  await expect(overlay).toBeHidden({ timeout: 10_000 });
  const exit = await page.evaluate(
    () =>
      (
        window as unknown as {
          __rmExit?: Promise<{
            samples: { t: number; transform: string; opacity: number }[];
            detachedAt: number | null;
          }>;
        }
      ).__rmExit,
  );
  expect(exit).toBeDefined();
  for (const s of exit!.samples) {
    expect(IDENTITY, `surface translated during RM exit at t=${s.t}ms`).toContain(
      s.transform,
    );
  }
  // The exit faded rather than cutting: mid-fade frames were seen…
  expect(Math.min(...exit!.samples.map((s) => s.opacity))).toBeLessThan(0.9);
  // …and the surface actually left.
  expect(exit!.detachedAt, "surface never unmounted after RETURN").not.toBeNull();

  // Back in operator space with the incident on file, same as every lane.
  await expect(page.getByText("Diagnostic complete — service recommended")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Incident history" })).toBeVisible();
});
