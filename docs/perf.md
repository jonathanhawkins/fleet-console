# Performance receipts

> Budget rows below are the output of `node scripts/check-budgets.mjs` on the
> static export built 2026-09-02 (`/` 180.5 KB gz, `/unit/N-01` 188.7 KB gz,
> 14 scripts each). The same check runs at the end of every `pnpm e2e` and in
> CI, so these two numbers are enforced rather than remembered. The unit route
> peaked at 200.5 KB on 2026-08-31 before a `sideEffects` declaration took
> ~12 KB back; the growth since the first 173.8 / 175.1 KB build is the
> incident-history, cohort and trend-watch work landing in the initial JS.

Measured numbers, not claims (PRD §7). Everything below was measured on the
static export (`pnpm build:static` — `output: "export"`, WorkerTransport, the
exact artifact that deploys), served locally by `scripts/serve-static.mjs`.

**Hardware / environment:** Apple M5 Max (Apple Silicon), 128 GB, macOS 26.4.1.
Chromium via Playwright 1.55 (headless) for runtime probes; Lighthouse 12
desktop preset for page scores. Gzip figures are `gzip -9` of the exact bytes
the server sends per file, summed per page — not an estimator.

## Budgets (PRD §7 + Phase 4 DoD)

| Budget | Measured | Verdict |
| --- | --- | --- |
| Fleet page initial JS < 200 KB gz | **180.5 KB gz** (modern browsers; 14 files) | **PASS** |
| Unit page initial JS < 200 KB gz | **188.7 KB gz** (14 files) | **PASS** |
| 60 fps during the descent | p95 frame **9.2 ms**, 1 of 974 frames > 16.7 ms (0.1%) | **PASS** |
| Interaction latency < 100 ms | Run-diagnostic press → visible feedback **1.3 ms** | **PASS** |
| Component view (three + GLB) < 500 KB gz | 249.4 + 72.3 = **321.7 KB gz**, lazy | **PASS** |
| Telemetry batched at 10 Hz, one commit per batch | 79.2 batches/s for 8 units (= 8 × 9.9 Hz) | **PASS** |

## Bundle: initial JS per route

Next-reported First Load JS, plus the measured wire size (sum of `gzip -9` of
every script the HTML actually loads in a modern browser — the `noModule`
core-js polyfill chunk, 38.5 KB gz, is listed separately because browsers with
ES-module support never request it).

| Route | Next "First Load JS" | Measured JS (gz) | CSS (gz) | HTML (gz) |
| --- | --- | --- | --- | --- |
| `/` (fleet) | 185 kB | **180.5 KB** | 11.4 KB | 3.8 KB |
| `/unit/[id]` | 193 kB | **188.7 KB** | 11.4 KB | 3.4 KB |
| legacy-only polyfill (`noModule`) | — | 38.5 KB | — | — |

**How the fleet page got under budget.** Before this pass it measured
**227.2 KB gz** (Next reported 233 kB): maplibre was already split out, and the
culprit was classic `zod` — the method-chained zod 4 API bundles ~66 KB gz
(306 KB raw) including JSON-Schema machinery this app never calls, and the
transports parse on the main thread, so it sat in the initial JS of every
route. Migrating `lib/schema` and the worker-host protocol to **`zod/mini`**
(same core, same parse semantics and issue shapes, functional API that
tree-shakes) collapsed that chunk to **12.9 KB gz**: **−53.4 KB gz** on every
route, zero UX or behavior change, all 334 unit tests and the golden-path e2e
green before and after.

## Code splitting: what loads late, and how big it is

Verified on this build by content-fingerprinting every emitted chunk. The e2e
additionally asserts, per run, that no machine-space code is fetched while the
operator is on the fleet page.

| Lazy bundle | Trigger | Raw | Gzip |
| --- | --- | --- | --- |
| maplibre-gl (map region) | fleet page mount (`next/dynamic`, ssr:false) | 1026.2 KB | **268.6 KB** |
| machine space (descent stage) | incident banner mount (warm-up) / first descent | 175.1 KB | **56.1 KB** |
| three + R3F (component view) | unit page, on scroll approach | 953.2 KB | **249.4 KB** |
| `chassis-silhouette.glb` | component view | 181.9 KB | **72.3 KB** |
| `chassis-wireframe.json` | parts-manifest board, on descent | 35.6 KB | **9.7 KB** |

### The model wireframe's share of the machine chunk

The parts-manifest board's elevation is a projection of the real chassis model
rather than a hand-drawn SVG, and it costs two separable things.

**Component bytes.** Measured as a paired A/B of the *same tree*: two
`pnpm build:static` runs whose only difference is the board rendering the
wireframe or the SVG elevation, with the machine chunk identified by content
(it is the one chunk carrying the manifest's group labels), not by filename.

| Machine chunk | Raw | Gzip |
| --- | --- | --- |
| with the model wireframe | 175 066 B | **56 099 B** |
| SVG elevation only (baseline) | 166 595 B | **52 856 B** |
| **delta** | +8 471 B | **+3 243 B (+3.2 KB gz)** |

That 3.2 KB gz buys `components/machine/wireframe-elevation.tsx`, `lib/wireframe`
(the zod/mini validator, the dequantizer, and the projector), and the board's
rewired leader line. It is the whole cost of drawing the actual model in machine
space: no three.js, no loader, no scene graph — the 249.4 KB R3F bundle above
stays where it is, on the operator's component view, and machine space never
asks for it. Note the machine chunk's *absolute* size moved from the 49.9 KB gz
recorded earlier in this document for reasons beyond this change (other Phase 7
work landed in the same chunk), which is exactly why the delta above is a paired
measurement rather than a subtraction from the old row.

**Runtime bytes.** `chassis-wireframe.json` is data, not code: a plain `fetch` on the
board's first mount, `cache: "no-cache"` (always revalidate, 304 unless the file
really changed), module-cached so a board rebuilt by a mid-scan reload re-parses
nothing. Format **v2** — positions int16-quantized, plus one int8 mean face
normal per edge — is **15.9 KB gz** (11.5 KB brotli, what Cloudflare Pages
actually serves; 65.4 KB raw against a 120 KB budget) for 1 814 vertices and
1 990 feature edges. The normals cost **+6.2 KB gz** over v1's 9.7 KB and buy
the luminance tiers (`lib/wireframe/tiers.ts`) — the only reason the figure is
readable at an oblique yaw. It rides no JS chunk, which the budget guard
confirms: `/` and `/unit/N-01` initial JS are unchanged.

**Draw cost.** 1 990 segments, projected and stroked from scratch every frame,
on the shared rAF loop: **0.071 ms/frame** — 0.4 % of a 60 fps budget, against a
0.1 ms ceiling.

That is the tiered draw. Its predecessor — the same projection, one
flat `beginPath`/`stroke` for the whole figure — measures **0.052 ms/frame** on
the same model and machine, so the luminance ladder costs **+0.019 ms/frame**
(+37 %) and stays inside budget. The extra work is: rotating one normal and
averaging two z values per edge in the projector, then a nine-slot counting sort
(two sweeps of the segment list) and up to nine strokes instead of one. Paired
A/B on a real 2D context at the board's own 144 × 352 at dpr 2, 4 rounds ×
2 000 frames each way after a 3 000-frame warm-up, interleaved so machine drift
cancels; per-round means held within 0.002 ms on both sides. (The earlier
0.031 ms figure in this document was v1 at 1 607 segments on a different model
extraction, which is why the before/after above is a fresh paired measurement
rather than a subtraction from it.)

Whole-loop frame time with the descent running and the elevation drawing: mean
8.33 ms, p50 8.30, p95 9.30 — the 120 Hz display cadence, i.e. the wireframe is
not visible in it at all. Held still under the pointer — and under
`prefers-reduced-motion`, which pins yaw at 0 — the component does one float
comparison and returns, so a static figure costs nothing to keep on screen. That
early-out is also what makes the reduced-motion canvas byte-identical across
seconds, which the e2e suite asserts: every tier is a function of yaw alone.

## Runtime: the descent under load

Probe: compressed-storyline build (same code, beats at 6/9/12 s, diag pacing
×0.25), instrumented before any page script runs — a rAF delta recorder, a
`Worker` message counter, and a MutationObserver for interaction timestamps —
then one scripted golden-path run.

| Metric | Value |
| --- | --- |
| Descent window recorded | 8.14 s (press → verdict + settle), 974 frames |
| Frame time mean / p95 / max | **8.35 ms / 9.2 ms / 16.8 ms** (120 Hz display cadence) |
| Frames over the 60 fps budget (16.7 ms) | **1 of 974** (0.1%) |
| Worker → main messages during scan | 84.3 msgs/s (telemetry batches + diag events) |
| Steady-state telemetry throughput | 79.4 msgs/s total; **79.2 telemetry batches/s** (8 units × 10 Hz) |
| Run-diagnostic press → visible feedback | **1.3 ms** (banner flips to "Diagnostic in progress", page starts draining) |
| Run-diagnostic press → descent surface in DOM | 333.6 ms — deliberate: the overlay mounts on the sim's `scan_start` event and enters behind a 200 ms dim + 350 ms wipe choreography; the window is network-free (the chunk was warmed at banner mount) |

## Lighthouse (gated; the receipt is the JSON)

The Lighthouse claim is no longer a table typed into this file. It is
`scripts/lighthouse.mjs`: desktop preset, the static export served by
`scripts/serve-static.mjs --gzip` (what the deploy target sends), against `/`
and `/unit/N-01`, on Playwright's Chromium with SwiftShader GL so a laptop and
a CI runner measure the same thing. It exits 1 under **performance 90** or
under **100** on accessibility, best practices or SEO. CI runs it in the e2e
job right after the bundle budgets and posts the scores to the job summary;
there, performance is reported rather than gated, because a shared runner's
main thread with software WebGL moves total-blocking-time by an order of
magnitude between runs (72 on one run, 100 on the next) and a gate on it
would measure the runner, not the page. The performance bar is held on the
hardware above, and the stored reports are cut there.

The reports it wrote are committed, screenshots stripped, everything else
intact — load them in the Lighthouse Viewer:

| Route | Receipt |
| --- | --- |
| `/` | [docs/evidence/lighthouse/index.json](evidence/lighthouse/index.json) |
| `/unit/N-01` | [docs/evidence/lighthouse/unit-N-01.json](evidence/lighthouse/unit-N-01.json) |

Read the four scores from `categories.*.score` and the metrics from
`audits.*.numericValue` in those files, or run `pnpm lighthouse` after
`pnpm build:static` to re-cut them. The sections below are the earlier
hand-run measurements, kept for the method notes and the before/after story;
where they disagree with the JSON, the JSON is current.

## Lighthouse history: desktop preset, local static serve, `/`

| Category | Score |
| --- | --- |
| Performance | **99** |
| Accessibility | **100** |
| Best practices | **100** |
| SEO | **100** |

FCP 0.3 s · LCP 0.9 s · TBT 70 ms · CLS 0 · Speed Index 0.8 s.

Notes, for honesty: the "cache lifetimes" insight flags the local probe server,
which deliberately sends `no-store` so every measured load is cold — the deploy
target (Cloudflare Pages) serves `/_next/static/*` immutable. axe's
`label-content-name-mismatch` flags the fleet-rail rows (score still 100): each
row's `aria-label` is a composed sentence — "N-01, Prospect Row. Nominal. Battery
73 percent. Last contact just now." — which starts with the visible identity
but says "percent" where the row shows "73%"; that composition is a deliberate
screen-reader choice documented in `components/console/unit-card.tsx`.

## Lighthouse history: desktop preset, local static serve, `/unit/N-07`

`/unit/[id]` prerenders as the *waiting state* and swaps the full instrument stack in on the worker's first snapshot —
this run makes that swap's cost visible. Lighthouse 12.8.2 (same major as the
`/` run above), fresh `pnpm build:static` served by `scripts/serve-static.mjs`.

| Category | Score |
| --- | --- |
| Performance | **82** |
| Accessibility | **100** |
| Best practices | **100** |
| SEO | **100** |

FCP 0.3 s · LCP 1.0 s · TBT 370 ms · CLS 0.06 · Speed Index 0.3 s.

Notes, for honesty: the two numbers that separate this from the fleet page's
99 are exactly the swap the audit predicted. **CLS 0.06** is, in effect, one
shift: the `footer` gets pushed down when the instrument stack replaces the
shorter waiting-state markup (the h1 and back-link anchors hold, as hoped —
the second recorded shift is a 0.0003 tabular-number nudge). **TBT 370 ms** is
script evaluation during hydration + instrument swap-in (the unit-page chunk
alone boots in ~470 ms on this machine at the desktop preset's 1× CPU).
Build-snapshot caveat: machine-space paths (`components/machine`, wireframe
assets) were mid-flight in a parallel lane when this build was cut, and its
lint step was skipped for the measurement (the mid-flight lane had transient
unused-import errors; all owned code linted clean) — machine space is lazy and
outside this page's initial load, so the scores above are unaffected, but
re-cut the receipt after that lane lands.

## Lighthouse history: `/unit/N-07` re-cut after the layout reservation

The receipt above, re-cut on the finished build — machine space, the model
wireframe, the resizable columns and the mobile pass all landed, lint clean, no
`--no-lint`. Same method, same Lighthouse 12.8.2, same local static serve.

| | Perf | A11y | BP | SEO | FCP | LCP | TBT | CLS | SI |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| desktop preset — before | 82 | 100 | 100 | 100 | 0.3 s | 1.0 s | 370 ms | 0.06 | 0.3 s |
| **desktop preset — after** | **99** | **100** | **100** | **100** | 0.3 s | 1.0 s | **40 ms** | **0.001** | 0.3 s |
| mobile preset — as served locally | 76 | 100 | 100 | 100 | 1.2 s | 6.7 s | 90 ms | 0.002 | 1.2 s |
| **mobile preset — served compressed** | **97** | **100** | **100** | **100** | 0.8 s | **2.6 s** | 90 ms | 0.002 | 0.8 s |

**What the fix was.** `/unit/[id]` prerenders as a waiting state and swaps in the
instrument stack on the worker's first snapshot. A `layout-shift` probe with
attributed sources named exactly one culprit, worth quoting because it is not
what "CLS on a page of instruments" sounds like: a single 0.060 shift whose only
source was the **footer**, moving from y=863 in a 940 px viewport to off screen
entirely. Nothing else on the page moved — the h1 and the back link were already
anchored, as the note above hoped. The page was not shifting; it was *growing
underneath the one settled element the first viewport happened to contain*.

So the reservation is structural rather than a min-height. Three changes, each
of which makes a waiting state the same shape as the thing it is waiting for:

- **The page waits as itself.** The `fleetSize === 0` branch no longer replaces
  the page with a centred sentence. Every region already had an honest empty
  state — identity prints em-dashes, the timeline says when it will start, the
  eighteen strips say "no reading yet" at their fixed 56 px — so the prerendered
  HTML is now the real page, and the first snapshot fills boxes instead of
  replacing markup. (The unknown-id branch is untouched and still short: no
  instruments are coming, so reserving room for them would be a lie.)
- **The battery gauge has a no-reading state** instead of being swapped for an
  em-dash. Two lines settled, one line pending, was 11 px of growth in the
  identity row (0.032 after the footer was fixed).
- **The status timeline draws its empty band** rather than a sentence: band,
  gap, caption — the same three boxes in both states, worth the last 14 px.

Measured with the same probe, desktop 1350×940: **0.0602 → 0.0125 → 0.0007**.
All three surviving shifts are under 0.0005 and are the tabular-number nudges
the note above already identified. Mobile 390×844 was ~0 throughout (0.0004).

**And the TBT, which was not the target.** The audit asked only whether
reserving space moved it; it moved it from **370 ms to 40 ms**, and the reason
is the same change rather than a second one. Hydrating the waiting state and
then re-rendering the entire instrument stack from scratch was always two
renders of the page; hydrating the page once and letting leaf values arrive is
one. The chunk-splitting the audit floated as the fix for TBT was not needed and
was not done.

**Why two mobile rows.** The mobile preset simulates a 1.6 Mbps link, and
`scripts/serve-static.mjs` deliberately sends no `Content-Encoding` so the e2e's
chunk bookkeeping counts plain bytes. Uncompressed, this page's ~700 KB of raw
JS is ~3.5 s of transfer on that link — 6.3 s of the 6.7 s LCP is render delay
waiting for it, and `uses-text-compression` is the report's largest opportunity
at 3.45 s. The deploy target (Cloudflare Pages) has served it compressed all
along, so the script now takes an opt-in `--gzip` and the second row is the same
build behind it. 175.1 KB gz is what actually goes over the wire; **97** is what
that costs on a throttled phone. The first row is kept because it is the number
the documented method produces, and both are true.

## Scale + ordering: the fleet at 500 units

The PRD's fleet is eight homes; the product it pretends to be has hundreds.
`SIM_UNITS` / `NEXT_PUBLIC_SIM_UNITS` (8–500, deterministic, N-07's storyline
byte-identical at any size) make the claim testable, and this section is the
receipt. Method: same as the rest of this document — the static export
(WorkerTransport), seed 7, compressed storyline, served by
`scripts/serve-static.mjs`, probed in headless Chromium (Playwright 1.55) with
an injected rAF-delta recorder and a `Worker#onmessage` wrapper that times the
full inbound pipeline (zod parse → ordering gate → store commit → synchronous
subscriber notifications). This machine renders at a 120 Hz cadence, so an
idle frame reads ~8.3 ms; the budget line is 60 fps (16.7 ms). Reproduce with
`pnpm e2e:stress` (behaviors) — the numbers were taken with a scratch probe
against `NEXT_PUBLIC_SIM_UNITS=500` builds of this code.

### Headline: 500 units, measured

| Metric | 8 units | 500 units | Verdict |
| --- | --- | --- | --- |
| Fleet page load → live (rail populated, link Live) | 69 ms | **66–82 ms** | PASS |
| Snapshot apply (one message, browser) | — | **2.2 ms** | PASS |
| Steady-state frames (no interaction), p95 / >16.7 ms | 9.2 ms / 0% | **10.1 ms / ~1%** | PASS |
| Rail scroll (programmatic full-list sweep), p95 / >16.7 ms | 9.2 ms / 0% | **9.5 ms / 0.8%** | PASS |
| Rail rows mounted (DOM) | 8 of 8 | **20 of 500** | PASS |
| Map pan p95 (shipped marker mode) | 9.3 ms | **9.2 ms** | PASS |
| Telemetry fan-in (10 Hz × fleet) | 79/s | **~5,000/s, one commit per batch** | PASS |
| JS heap after ~60 s live | 21 MB | **71–86 MB** | — |
| Initial JS budget guard (`pnpm budgets`) | PASS | **PASS** (map layer code rides the lazy maplibre chunk — verified absent from the initial script set) | PASS |

Two fixes were required to hold those numbers; both are part of this receipt.

### Fix 1: the rail was only *pretending* to virtualize

The virtualizer was always there; its scrollport was not. `body` is a
`min-height: 100dvh` flex column, so nothing bounded the shell — at 8 units
the content happened to fit and the rail looked capped; at 500 the list's
36,000 px propagated up, the *document* scrolled, and the "virtualized" rail
mounted all 500 rows. Measured before the fix: 500 mounted rows, **27.1 ms of
main-thread per telemetry wave** (each of the 500 commits notifying ~1,000
row subscriptions), 1-second-ticker re-renders visible as 83–107 ms long
tasks, 138 MB heap.

The fix is layout, not virtualization code. The first version pinned the
fleet page's `body` to `100dvh` so the shell-grid's `min-h-0` chain had a
definite column to clip against. The current version bounds the scrollport
directly: `railScrollportHeight()` in `fleet-rail.tsx` sets an explicit
height of `rows × MAX_VISIBLE_ROWS` (eight, with a four-row floor so an empty
fleet does not fold the shell), the grid takes its height from the rail, and
the page grows as a document when it needs more than the viewport. Below
64rem, where the shell stacks and scrolls as a document on purpose, the rail's
grid row caps at `75dvh` instead of `auto`. After: **20 mounted rows**, wave
cost 27.1 → **6.7 ms**, heap 138 → **71 MB**, scroll p95 **9.5 ms** with 6 of
715 frames over budget.

### Fix 2: map markers — DOM to 300 units, a circle layer above

DOM glyph markers (the designed experience: house glyph, hover label, anchor
semantics) were measured at 8/150/300/500 units; MapLibre repositions every
marker element on every render frame, so camera moves are the stress:

| DOM markers | pan p95 | zoom p95 | alert-ease p95 | pan frames >16.7 ms |
| --- | --- | --- | --- | --- |
| 8 | 9.3 ms | 8.5 ms | 9.1 ms | 0.2% |
| 150 | 9.2 ms | 8.7 ms | 9.3 ms | 0.2% |
| 300 | 9.9 ms | 10.1 ms | 14.9 ms | 0.2% |
| 500 | **22.8 ms** | **18.4 ms** | **17.4 ms** | **11%** |

(An earlier 500-unit run before Fix 1 measured pan p95 31 ms — the broken
rail's wave cost was bleeding into every window, which is why the A/B above
was re-taken on the fixed build.)

So `fleet-map-view.tsx` draws the line at `MARKER_DOM_MAX = 300`, by
measurement: at or below it, the DOM markers ship with documented headroom;
above it, `fleet-map-layer.ts` renders the fleet as one GeoJSON source and a
status-colored circle layer inside the map's own WebGL pass, updated
imperatively from the same store subscription (telemetry still touches
neither mode — the map subscribes to identity changes only). Same build, 500
units, layer mode: pan p95 **9.2 ms**, zoom **8.8 ms**, ease **9.3 ms** —
statistically the 8-unit baseline. The alert-beat commit (which walks every
marker) drops from 9.9 ms (DOM at 500) to **1.3 ms** (setData).

The tradeoff is visual and documented, not silent: above 300 units the house
glyph, hover nameplate and per-marker anchor/focus semantics yield to circles
(identity lives in the virtualized rail and on click-through; canvas features
are not in the accessibility tree, so the rail is the accessible enumeration
at scale). The two behaviors the golden path needs from the map — the
worsened-status ping (rings once, honors `prefers-reduced-motion`) and
click-to-navigate — work identically in both modes
(`fleet-map-layer.test.ts`, `e2e/stress.spec.ts`).

### Commit cost per batch wave (the one-commit-per-batch discipline at 500×)

10 Hz × 500 units is ~5,000 store commits/s arriving as 100 ms waves of ~500
messages. Browser, full pipeline per message: mean **13.4 µs** (p95 0.1 ms,
max 3.5 ms); per wave: mean **6.7 ms**, p50 3.8 ms, p95 16.4–19.4 ms, max
47 ms. Node-side (reducers only, no subscribers): **4.45 µs/batch**, wave p50
**0.41 ms** — and a clean bimodal signature worth recording: every 10th wave
(the one where all 500 batches cross a 1-second boundary together and the
store's `lastContactAt` quantization moves for every unit, each commit
spreading a 500-key record) costs **~12 ms**, all others < 1 ms. That burst
was the p95 above and the ~1% of steady-state frames over budget; the frame
budget held, so the sim's batching stayed as-is and the record-spread was
noted as the first thing to change if a larger fleet ever needs it
(`lib/stores/fleetStore.ts`, `applyTelemetry`). KPI derivation was inside
these numbers (O(fleet) on battery-moved commits, 0.6 ms with the alert
commit at 500, node-side). Both were changed; see the next section.

### The boundary-wave spike, removed

The "first thing to change" above was changed in two steps. The first kept
the per-unit primitives in zustand state and mutated them in place under a
global version counter, which removed the record spread but left every
subscriber's selector running on every batch. The current model (below)
removes telemetry from the store altogether; the A/B in this section is the
receipt for the first step, kept because its numbers are what the second step
was measured against. `kpiAvgBattery` re-derives from a running battery sum in
O(1) per telemetry move instead of an O(fleet) walk, re-seeded by every
full-recompute commit (snapshot, alert, unit_update).

Measured as a **paired interleaved A/B** of the old and new reducers in one
process (machine drift cancels — same method as the wireframe A/B above;
ambient load was swinging solo runs of the identical code by ~2×, which is
exactly why the recorded delta is paired). Node-side reducers only, seed 7,
500 units, 60 waves of `engine.advance(w*100)`, 7 measured rounds per side:

| ms/wave (~500 batches), p50 | old (spread) | new (in place) |
| --- | --- | --- |
| populate wave (every unit's first batch) | 55.4 | **8.9** |
| boundary waves (w = 10, 20, …) | 18.9 | **1.8** |
| quiet waves | 2.35 | **1.79** |

The bimodal signature is gone — a boundary wave now costs the same as a quiet
one — and the two O(fleet²)-flavored moments (populate, boundary) flatten into
the ordinary wave cost. A 600-wave differential run (telemetry + alerts + a
mid-run reconnect snapshot, 500 units) confirmed old and new stores agree on
all selector-visible state at every checkpoint, and that the incremental
battery sum equals a from-scratch recompute throughout. The browser-side wave numbers above (p95 16.4–19.4 ms,
driven by these boundary waves) predate this change and should collapse toward
their p50 — re-cut with the rAF probe on the next full stress pass.

### Telemetry off the store entirely

A telemetry batch now makes **zero zustand commits**. The ring buffers, the
per-unit version counter, the quantized battery (0.1 %) and last-contact (1 s)
live in `lib/stores/telemetryChannel.ts`, a non-reactive module with one
listener set per unit; `recordTelemetryBatch` writes them and notifies only
that unit's subscribers. React reads them through `useSyncExternalStore`
hooks keyed by unit id (`useUnitTelemetryVersion`, `useUnitBattery`,
`useUnitLastContact`), and canvas hosts poll the version from the frame
callback. The store commits only when a reactive fact moves: the rounded fleet
average battery, or the trending set. The contract is pinned in
`lib/stores/fleetStore.test.ts` (no commit on a pure-telemetry batch; one
per-unit notification) and by the render-count tripwires in
`components/console/telemetry-strip.test.tsx` and `fleet-rail.test.tsx`; the
500-unit stress lane (`pnpm e2e:stress`) still passes with the rail DOM
bounded and the N-07 alert surfacing at scale.

### Trend watch: the fleet re-fitted on every commit

The thermal trend watch (`lib/stores/trendWatch.ts`) is a derivation over the
rings, and it memoized on `telemetryVersion` — the counter that changes on
**every** batch, any unit. So the memo only deduped the two subscribers inside
one commit and never survived to the next: one unit's ring moved and all six
joints of every unit were re-fitted, plus two `Array.from` boxes per joint.

Measured as a **paired A/B** in one process (same method as the two above —
node-side, seed-free synthetic 10 Hz feed, every ring filled to its 600-sample
capacity, one commit for one unit followed by one selector pass, the
store-only cost of the same loop subtracted so the number is the derivation's
own; 2,000 iterations at 8 units, 200 at 500; 3 rounds per side, medians):

| per commit | 8 units | 500 units |
| --- | --- | --- |
| before (fleet re-fit) | 0.014 ms | 9.4 ms |
| after (per-unit memo + 1 s quantum + windowed reads) | **0.0013 ms** | **0.024 ms** |
| main thread per wall second (79 / 5,000 commits/s) | 1.10 → **0.10 ms** | 47,000 → **119 ms** |

Three changes, in order of what they bought:

1. **Scope.** The fit runs as a reducer step for the one unit a batch
   carries (`trendOnBatch`), and its output is a reactive `trending` field,
   so a batch re-fits one unit and the selector stays a plain read — pinned
   by `trendFitsForTests()` in `lib/stores/trendWatch.test.ts`, because a
   change here can silently go back to re-fitting the fleet.
2. **Rate.** A unit is re-fitted at most once per second of *its own*
   telemetry clock (`TREND_REFIT_MS`). A 15 s least-squares window read
   through a ±3 °C/min hysteresis band cannot tell 10 Hz from 1 Hz; the cost
   is up to 1 s of latency on a forecast that runs 13 s ahead of an amber.
   Deliberately per-unit rather than a global gate on the whole derivation: a
   global 1 Hz gate would re-fit all 500 units in one burst (~9 ms, a dropped
   frame every second), while the per-unit quantum spreads the same work at
   ~0.024 ms per commit and never occupies a frame.
3. **Allocation.** `RingBuffer.copyTail` reads only the ~150 samples in the
   window instead of copying all 600 to reach them, and `slopePerMin` takes
   the shared `Float64Array` scratch buffers with a count instead of two boxed
   arrays per joint — ~4,400 short-lived arrays/s at 8 units, gone.

What is left at 500 units is the roster walk itself (a cached-number compare
per unit per commit, ~2.5 M/s), which is where the residual 119 ms/s lives. If
a larger fleet ever needs it, the next move is a single-unit incremental path
keyed on which unit committed, which is what the per-batch reducer step now does.

### Out-of-order receipts (the ordering gate, instrumented)

The policy is `lib/stores/README.md` § "Out-of-order and replay policy";
enforcement is `createOrderingGate` at the transport boundary, whose `onDrop`
hook is the dev-only counter — transports console.warn per drop in dev, and
nothing user-facing surfaces it by design. The receipt is a scripted
injection at fleet scale (`lib/transport/orderingGate.stress.test.ts`): the
real engine's 500-unit stream, mangled — one wave re-delivered wholesale, one
wave overtaken by its successor, one wave interleaved with a duplicate wave
in seeded-shuffle order — through the gate into the real fleet store.

| Receipt | Number |
| --- | --- |
| Deliveries (1 snapshot + 7 × 500 telemetry) | 3,501 |
| Scripted disorder among them | 1,500 |
| Drops recorded by `onDrop` | **exactly 1,500, all telemetry** |
| Admitted into the store | 2,001 |
| Ring buffers time-monotonic after | **all 500 units** |
| Batches admitted per unit | 4 — the overtaken wave is *dropped*, never reordered in |
| Reconnect replay after `fleet_snapshot` | **0 drops** (the snapshot resets the gates) |
| `command_event` disorder `[2,1,3,3,5,4]` | 3 drops, lifecycle admits 2→3→5 (seq is the authority) |

### The stress smoke, on demand

`pnpm e2e:stress` (playwright.stress.config.ts — its own config because a
Playwright webServer is per-config, and the main `pnpm e2e` must keep
building the 8-unit deploy artifact). One chromium spec against a
`NEXT_PUBLIC_SIM_UNITS=500` build: live at 500, rail DOM bounded (< 30 rows
mounted while the header reads 500), End/Home keyboard traversal lands
focused rows at both ends, the N-07 amber surfaces in the feed at scale and
its row click-through reaches `/unit/N-07`. Deliberately not chained into
`pnpm e2e`: it is a receipt, not a deploy gate.

Recorded runs (2026-08-24, both green): spec **10.1 s** and **9.7 s**;
21–43 s wall including the webServer's build + serve. The main `pnpm e2e`
(8-unit artifact, all four projects + the budget guard) passed after this
work landed: 7/7 in 33.5 s, `/` at 189.1 KB gz and `/unit/N-01` at
190.1 KB gz against the 200 KB budget — the growth over the 173.8/175.1
recorded above is the Phase 10 lanes landing in parallel, not this one: the
circle-layer module ships inside the lazy maplibre chunk, verified absent
from the initial script set.

One receipt was skipped, honestly: a `WsTransport` 500-unit browser run (dev
sim on a second port). The parallel design lanes were churning the tree too
hard for another measurement build; the ws path shares the zod → ordering
gate → store pipeline measured above and differs only by JSON.parse per
frame on the main thread, and the deploy artifact — the thing this document
receipts — is the worker path. The node-side gate/store numbers above are
transport-independent.

## Bundle budgets: now machine-checked

The per-route initial-JS budgets in the table above are no longer hand-only:
`pnpm budgets` (`scripts/check-budgets.mjs`, zero-dep) parses each exported
route HTML's modern-browser script set, sums `gzip -9` bytes, and fails the
run if `/` or `/unit/N-01` exceeds **200 KB gz** (thresholds sit AT the PRD §7
budget, not at current usage). It requires an existing `out/` and is appended
to `pnpm e2e`, so the CI-shaped flow measures the same artifact Playwright
just tested. First real run (2026-08-21, the build above): `/` 173.8 KB gz
(11 scripts, 26.2 KB headroom) — `/unit/N-01` 175.1 KB gz (12 scripts,
24.9 KB headroom) — both PASS, matching the hand-measured table exactly.
