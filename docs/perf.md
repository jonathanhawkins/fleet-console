# Performance receipts

> Budget rows below are the output of `node scripts/check-budgets.mjs` on the
> static export built 2026-09-03 (`/` 185.7 KB gz over 15 scripts,
> `/unit/N-01` 193.9 KB gz over 16). The same check runs at the end of every
> `pnpm e2e` and in CI, so these two numbers are enforced rather than
> remembered. Two moves account for most of the growth from the first
> 173.8 / 175.1 KB build: the incident-history, cohort and trend-watch work
> landing in the initial JS, and — the last ~5 KB, on every route — the
> per-route error boundary `app/error.tsx`, which Next bundles into a route's
> own client JS whether or not it ever renders. That is the price of a render
> failure showing a page instead of nothing, and it is why the boundary
> deliberately does not import the component library.

Measured numbers, not claims (PRD §7). Everything below was measured on the static
export (`pnpm build:static` — `output: "export"`, WorkerTransport, the exact artifact
that deploys), served locally by `scripts/serve-static.mjs`.

**Hardware / environment:** Apple M5 Max (Apple Silicon), 128 GB, macOS 26.4.1. Chromium
via Playwright 1.55 (headless) for runtime probes; Lighthouse 12 desktop preset for page
scores. Gzip figures are `gzip -9` of the exact bytes the server sends per file, summed
per page — not an estimator.

## Budgets (PRD §7 + Phase 4 DoD)

`pnpm budgets` (`scripts/check-budgets.mjs`, zero-dep, appended to `pnpm e2e`) parses
each exported route's modern-browser script set and fails the run past **200 KB gz** —
the PRD §7 line itself, not current usage.

| Budget | Measured | Verdict |
| --- | --- | --- |
| Fleet page initial JS < 200 KB gz | **185.7 KB gz** (modern browsers; 15 files) | **PASS** |
| Unit page initial JS < 200 KB gz | **193.9 KB gz** (16 files) | **PASS** |
| 60 fps during the descent | p95 frame **9.2 ms**, 1 of 974 frames > 16.7 ms (0.1%) | **PASS** |
| Interaction latency < 100 ms | Run-diagnostic press → visible feedback **1.3 ms** | **PASS** |
| Component view (three + GLB) < 500 KB gz | 249.4 + 72.3 = **321.7 KB gz**, lazy | **PASS** |
| Telemetry batched at 10 Hz, one commit per batch | 79.2 batches/s for 8 units (= 8 × 9.9 Hz) | **PASS** |

## Bundle: initial JS per route

Next-reported First Load JS, plus the measured wire size (sum of `gzip -9` of every
script the HTML actually loads in a modern browser — the `noModule` core-js polyfill
chunk, 38.5 KB gz, is listed separately because browsers with ES-module support never
request it).

| Route | Next "First Load JS" | Measured JS (gz) | CSS (gz) | HTML (gz) |
| --- | --- | --- | --- | --- |
| `/` (fleet) | 190 kB | **185.7 KB** | 11.4 KB | 3.8 KB |
| `/unit/[id]` | 198 kB | **193.9 KB** | 11.4 KB | 3.4 KB |
| legacy-only polyfill (`noModule`) | — | 38.5 KB | — | — |

`zod/mini` holds both routes under budget: the schema layer and worker-host protocol
cost 12.9 KB gz there, against ~66 KB gz for method-chained zod 4 (migration story in
the appendix).

## Code splitting: what loads late, and how big it is

Verified on this build by content-fingerprinting every emitted chunk. The e2e
additionally asserts, per run, that no machine-space code is fetched while the operator
is on the fleet page.

| Lazy bundle | Trigger | Raw | Gzip |
| --- | --- | --- | --- |
| maplibre-gl (map region) | fleet page mount (`next/dynamic`, ssr:false) | 1026.2 KB | **268.6 KB** |
| machine space (descent stage) | incident banner mount (warm-up) / first descent | 175.1 KB | **56.1 KB** |
| three + R3F (component view) | unit page, on scroll approach | 953.2 KB | **249.4 KB** |
| `chassis-silhouette.glb` | component view | 181.9 KB | **72.3 KB** |
| `chassis-wireframe.json` | parts-manifest board, on descent | 35.6 KB | **9.7 KB** |

### The model wireframe's share of the machine chunk

The parts-manifest board's elevation is a projection of the real chassis model rather
than a hand-drawn SVG, at **+3.2 KB gz** on the machine chunk over an SVG-only elevation
(`wireframe-elevation.tsx` + `lib/wireframe`; paired A/B in the appendix) — no three.js,
no scene graph. Its data, `chassis-wireframe.json`, is a plain `fetch` on first mount,
module-cached. Format **v2** (int16-quantized positions plus one int8 mean face normal
per edge, 1 814 vertices / 1 990 edges) is **15.9 KB gz** (11.5 KB brotli, what
Cloudflare Pages serves); the normals buy the luminance tiers
(`lib/wireframe/tiers.ts`), the only reason the figure reads at an oblique yaw. It rides
no JS chunk.

Draw cost, 1 990 segments stroked from scratch every frame on the shared rAF loop:
**0.071 ms/frame**, 0.4% of a 60 fps budget and invisible inside the descent's own frame
time below (appendix has the paired A/B against a flat, untiered stroke). Held still,
and under `prefers-reduced-motion` (yaw pinned at 0), the component does one float
comparison and returns, so a static figure costs nothing to keep on screen.

## Runtime: the descent under load

Probe: compressed-storyline build (same code, beats at 6/9/12 s, diag pacing ×0.25),
instrumented before any page script runs — a rAF delta recorder, a `Worker` message
counter, and a MutationObserver for interaction timestamps — then one scripted
golden-path run.

| Metric | Value |
| --- | --- |
| Descent window recorded | 8.14 s (press → verdict + settle), 974 frames |
| Frame time mean / p95 / max | **8.35 ms / 9.2 ms / 16.8 ms** (120 Hz display cadence) |
| Frames over the 60 fps budget (16.7 ms) | **1 of 974** (0.1%) |
| Worker → main messages during scan | 84.3 msgs/s (telemetry batches + diag events) |
| Steady-state telemetry throughput | 79.4 msgs/s total; **79.2 telemetry batches/s** (8 units × 10 Hz) |
| Run-diagnostic press → visible feedback | **1.3 ms** (banner flips to "Diagnostic in progress") |
| Run-diagnostic press → descent surface in DOM | 333.6 ms — deliberate: 200 ms dim + 350 ms wipe, network-free (chunk warmed at banner mount) |

## Lighthouse (gated; the receipt is the JSON)

The Lighthouse claim is no longer a table typed into this file. It is
`scripts/lighthouse.mjs`: desktop preset, the static export served by
`scripts/serve-static.mjs --gzip`, against `/` and `/unit/N-01`, on Playwright's
Chromium with SwiftShader GL. It exits 1 under **performance 90** or under **100** on
accessibility, best practices or SEO. CI reports rather than gates performance, since a
shared runner's software-WebGL main thread swings total-blocking-time by an order of
magnitude between runs; the bar is held on the hardware above.

The reports it wrote are committed, screenshots stripped — load them in the Lighthouse
Viewer:

| Route | Receipt |
| --- | --- |
| `/` | [docs/evidence/lighthouse/index.json](evidence/lighthouse/index.json) |
| `/unit/N-01` | [docs/evidence/lighthouse/unit-N-01.json](evidence/lighthouse/unit-N-01.json) |

Read the four scores from `categories.*.score` and the metrics from
`audits.*.numericValue`, or run `pnpm lighthouse` after `pnpm build:static` to re-cut
them. The one hand-run history worth keeping — the CLS/TBT method and before/after — is
in the appendix; where it disagrees with the JSON, the JSON is current.

## Scale + ordering: the fleet at 500 units

The PRD's fleet is eight homes; the product it pretends to be has hundreds. `SIM_UNITS`
/ `NEXT_PUBLIC_SIM_UNITS` (8–500, deterministic, N-07's storyline byte-identical at any
size) make the claim testable, probed in headless Chromium with an injected rAF-delta
recorder timing the full inbound pipeline (zod parse → ordering gate → store commit →
subscribers) — this machine renders at 120 Hz, so an idle frame reads ~8.3 ms against
the 60 fps (16.7 ms) budget line. Reproduce with `pnpm e2e:stress`.

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
| Initial JS budget guard (`pnpm budgets`) | PASS | **PASS** (map layer rides the lazy maplibre chunk, absent from the initial script set) | PASS |

Holding those numbers took five changes: bounding the rail's scrollport so it actually
virtualizes, capping DOM map markers at 300 units (a WebGL circle layer above that), and
three store-side changes — an in-place KPI derivation, telemetry moved off the store,
and a per-unit trend re-fit — that removed a commit-cost spike. Method and before/after
for all five are in the appendix.

### Out-of-order receipts (the ordering gate, instrumented)

Enforcement is `createOrderingGate` at the transport boundary (policy:
`lib/stores/README.md` § "Out-of-order and replay policy"). The receipt is a scripted
injection at fleet scale (`lib/transport/orderingGate.stress.test.ts`): the real
engine's 500-unit stream, mangled — one wave re-delivered wholesale, one overtaken by
its successor, one interleaved with a duplicate in seeded-shuffle order — through the
gate into the real fleet store.

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

`pnpm e2e:stress` (its own Playwright config, since `pnpm e2e` must keep building the
8-unit artifact): live at 500, rail DOM bounded (< 30 rows mounted while the header
reads 500), End/Home keyboard traversal lands focused rows at both ends, the N-07 amber
surfaces in the feed at scale and its row click-through reaches `/unit/N-07`. Not
chained into `pnpm e2e` — a receipt, not a deploy gate. Recorded runs finish in 9.7–10.1
s. Skipped, honestly: a `WsTransport` 500-unit browser run, sharing the pipeline above
and differing only by per-frame `JSON.parse` — the deploy artifact this document
receipts is the worker path.

## How these numbers moved

Kept for the method — most of it a **paired A/B in one process**, so machine drift
cancels rather than landing in the delta — stated once each, newest number first where a
figure above superseded an earlier one.

**Bundle: `zod/mini`.** Before this pass the fleet page measured **227.2 KB gz**
(maplibre was already split out). The culprit was classic `zod`: the method-chained v4
API bundles ~66 KB gz including unused JSON-Schema machinery, parsed on the main thread
on every route. Migrating `lib/schema` and the worker-host protocol to `zod/mini` (same
core and parse semantics, tree-shaking functional API) collapsed that chunk to 12.9 KB
gz: **−53.4 KB gz** per route, all 334 unit tests and the golden-path e2e green before
and after.

**Wireframe, two A/Bs.** Chunk cost: two `pnpm build:static` runs of the same tree,
differing only in the board rendering the wireframe or an SVG elevation, chunk
identified by content — model 56 099 B gz vs. SVG-only 52 856 B gz, delta **+3 243 B
gz** (the chunk's absolute size has since moved to 56.1 KB gz for unrelated reasons;
this delta is the paired measurement, not a subtraction against that newer total). Draw
cost: the tiered luminance draw (0.071 ms/frame, table above) against a flat
`beginPath`/`stroke` predecessor, **0.052 ms/frame** on the same model and machine —
+0.019 ms/frame (+37%) for the ladder. Paired A/B, 4 rounds × 2 000 frames each way,
interleaved so drift cancels, means within 0.002 ms both sides (supersedes an earlier
0.031 ms figure at 1 607 segments on a different model extraction).

**Fix: the rail was only *pretending* to virtualize.** The virtualizer was always there;
its scrollport was not — at 8 units the shell's unbounded `body` happened to fit, but at
500 the list's 36 000 px propagated up, the *document* scrolled, and the "virtualized"
rail mounted all 500 rows: 27.1 ms of main-thread per telemetry wave, 138 MB heap. Fix:
`railScrollportHeight()` in `fleet-rail.tsx` bounds the scrollport directly (height =
`rows × MAX_VISIBLE_ROWS`, an 8-row cap, 4-row floor). After: 20 mounted rows, wave cost
27.1 → **6.7 ms**, heap 138 → **71 MB**, scroll p95 9.5 ms with 6 of 715 frames over
budget.

**Fix: map markers, DOM to 300 units, a circle layer above.** DOM glyph markers
reposition every marker element on every render frame, so camera moves are the stress:

| DOM markers | pan p95 | zoom p95 | alert-ease p95 | pan frames >16.7 ms |
| --- | --- | --- | --- | --- |
| 8 | 9.3 ms | 8.5 ms | 9.1 ms | 0.2% |
| 150 | 9.2 ms | 8.7 ms | 9.3 ms | 0.2% |
| 300 | 9.9 ms | 10.1 ms | 14.9 ms | 0.2% |
| 500 | **22.8 ms** | **18.4 ms** | **17.4 ms** | **11%** |

`fleet-map-view.tsx` draws the line at `MARKER_DOM_MAX = 300`; above it,
`fleet-map-layer.ts` renders the fleet as one GeoJSON source and a status-colored circle
layer in the map's WebGL pass. Same build, 500 units, layer mode: pan p95 9.2 ms, zoom
8.8 ms — the 8-unit baseline; the alert-beat commit drops from 9.9 ms (DOM) to 1.3 ms
(setData). Tradeoff, documented not silent: above 300 the hover nameplate and per-marker
anchor/focus semantics yield to circles.

**Fix: commit-cost spike at 500 units, removed in two steps.** Before: 10 Hz × 500 units
cost a browser-side mean **6.7 ms/wave**, with a bimodal spike (every 10th wave, ~12 ms
vs < 1 ms) from a 500-key `lastContactAt` record spreading on each shared 1-second
boundary. Step one kept per-unit primitives in zustand, mutated in place under a global
version counter (`kpiAvgBattery`: O(fleet) → O(1)). Paired interleaved A/B, node-side
reducers, 500 units, p50 ms per wave:

| Wave kind | Old (spread) | New (in place) |
| --- | --- | --- |
| populate (every unit's first batch) | 55.4 | **8.9** |
| boundary (w = 10, 20, …) | 18.9 | **1.8** |
| quiet | 2.35 | **1.79** |

**Fix: telemetry off the store entirely.** Step two, current: a telemetry batch now
makes **zero** zustand commits. Ring buffers and quantized battery/last-contact live in
`lib/stores/telemetryChannel.ts`, a non-reactive module notifying only each unit's own
subscribers; React reads them via `useSyncExternalStore`, and canvas hosts poll the
version from the frame callback. Pinned by `lib/stores/fleetStore.test.ts` and the
render-count tripwires in `telemetry-strip.test.tsx` and `fleet-rail.test.tsx`.

**Fix: the trend watch, re-fitted on every commit.** `trendWatch.ts` memoized on
`telemetryVersion`, which changes on *every* batch from any unit — so one unit's ring
moving re-fit all six joints of every unit. Paired A/B, node-side, synthetic 10 Hz feed,
rings full, medians, ms per commit:

| | 8 units | 500 units |
| --- | --- | --- |
| Before (fleet re-fit) | 0.014 | 9.4 |
| After (per-unit memo + 1 s quantum + windowed reads) | **0.0013** | **0.024** |

Three changes bought it: **scope** (a reducer step for the one unit a batch carries,
pinned by `trendFitsForTests()`); **rate** (a unit re-fits at most once per second of
its own clock, per-unit so the work spreads rather than bursting fleet-wide);
**allocation** (`RingBuffer.copyTail` reads only the ~150 samples in the window rather
than copying all 600, and `slopePerMin` takes shared `Float64Array` scratch instead of
two boxed arrays per joint). The residual 500-unit cost is the roster walk itself, ~2.5
M compares/s.

**Lighthouse, `/unit/[id]`: the CLS/TBT fix.** `/unit/[id]` prerenders as a waiting
state and swaps in the instrument stack on the worker's first snapshot; a `layout-shift`
probe named one culprit, the **footer**, pushed off-screen as the page grew underneath
the one settled element the first viewport contained. Fix: the page now waits as itself
(every region already had an honest empty state), the battery gauge gained a no-reading
state, and the status timeline draws its empty band. Desktop CLS: 0.0602 → 0.0125 →
**0.0007**; TBT fell from **370 ms to 40 ms** as a side effect — hydrating the waiting
state and re-rendering the whole stack was two renders, and hydrating once is one:

| | Perf | A11y | BP | SEO | FCP | LCP | TBT | CLS | SI |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| desktop — before | 82 | 100 | 100 | 100 | 0.3 s | 1.0 s | 370 ms | 0.06 | 0.3 s |
| **desktop — after** | **99** | **100** | **100** | **100** | 0.3 s | 1.0 s | **40 ms** | **0.001** | 0.3 s |
| mobile — uncompressed | 76 | 100 | 100 | 100 | 1.2 s | 6.7 s | 90 ms | 0.002 | 1.2 s |
| **mobile — compressed** | **97** | **100** | **100** | **100** | 0.8 s | **2.6 s** | 90 ms | 0.002 | 0.8 s |

Two mobile rows because the 1.6 Mbps preset was run both uncompressed and gzip'd
(`--gzip`, matching Cloudflare Pages) — 97 is what the real, compressed 175.1 KB gz
costs on a throttled phone.
