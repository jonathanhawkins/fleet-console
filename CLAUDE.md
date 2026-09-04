# Fleet Console

A fleet-operations console for home humanoid robots: a design and engineering demo with a simulated fleet. An original, fictional product inspired by consumer home-robot design — **no company names and no third-party logos, renders, or assets anywhere in the repo or the shipped app.**

**Read first:** `docs/prd/fleet-console-PRD.md` (the contract) and `docs/images/REFERENCES.md` (the visual targets, described in words).

## The design thesis (governs everything)

Two visual worlds; the transition between them is the whole demo:

- **Operator space (light, default):** calm warm white, consumer-grade, thermostat energy. Geist Sans, small-caps wide-tracked labels, pill buttons, soft shadows, muted status colors. No neon. Ever.
- **Machine space (dark, diagnostics):** what the robot itself reports. Phosphor green mono on near-black, JetBrains Mono, radius 0, no shadows, hierarchy by luminance. Evangelion diagnostic-board language. No rounded pills. Ever.

The golden path (90 s, rock solid): fleet map → alert → click N-07 → telemetry drill-in → Run diagnostic → **descent** into machine space → scan walks subsystems with waveforms → verdict: LEFT KNEE ACTUATOR A-07, GAIN ANOMALY → recommendation → ascend, incident logged.

## Non-negotiables

1. All tokens are CSS variables on `[data-space="operator" | "machine"]`. No hardcoded colors in components.
2. App code never imports shadcn directly — only `@/components/console` (wrapped, themed). The wrapper library is a first-class deliverable.
3. Charts/waveforms are raw canvas driven by one shared rAF loop. Zero chart DOM nodes, no chart libraries.
4. Telemetry is zod-validated at the transport, batched 10 Hz: one store commit per batch, one render per commit.
5. Footer on every page: "A design and engineering demo. All data is simulated." No company naming anywhere — UI, README, docs, or repo description.
6. All data simulated and labeled as such. The scripted incident must be re-runnable (sim reset).
7. Budgets: fleet page initial JS < 200 KB gz; 60 fps during the descent; interaction < 100 ms. `prefers-reduced-motion` respected (descent → crossfade).
8. Not the generic AI-SaaS look: no purple gradients, no glassmorphism, no emoji in UI, no stock-shadcn styling.
9. Quality floor: strict TS, zero-warning lint, AA contrast in operator space, visible keyboard focus in both themes, responsive to tablet (768 px+).

## Stack

Next 15 (App Router, static-export capable) · React 19 · TS 5 strict · Tailwind 4 (token-driven) · shadcn/ui as primitives · framer-motion (descent + micro only) · zustand · zod · @tanstack/react-virtual · maplibre-gl · three/R3F (component view route only) · vitest + RTL · playwright · pnpm.

## Layout

```
/app                  routes: / (fleet), /unit/[id], /system (design-system gallery)
/components/console   the component library (deliverable): pure primitives + hooks, no store
                      imports — StatusChip, ConsoleButton, ConsoleCard, UnitCard, BatteryMeter…
/components/fleet     this app's store-wired regions, built from console: FleetMap, FleetRail,
                      AlertRail, IncidentBanner, TelemetryStrip, DescentOverlay, ComponentView…
/components/machine   machine-space internals (canvas-heavy, mono)
/lib/transport        TelemetryTransport interface + WsTransport + WorkerTransport
/lib/stores           zustand stores, batched reducers
/lib/schema           zod message schemas (shared with sim)
/sim                  simulator engine (ws server in dev, Web Worker in prod)
/sim/engine           the engine as a module folder — one file per storyline and
                      per command; sim/engine.ts re-exports it (the stable import)
```

## Working in the tree

- Comments explain intent, not history: no issue ids, no review references, no "why the alternative was rejected" essays.
- Keep files under ~500 lines; split by responsibility before a file becomes a tour.
  Split on a seam that exists — the wireframe elevation came apart into a model,
  a painter and a component; the verdict card into the card, its readouts and
  its action rail. A handful of files sit over the line anyway, and stay there
  on purpose: `verdict-sheet.tsx` and `descent-stage.tsx` are single
  interactions whose callbacks all close over the same refs, and cutting them
  up would trade one long file for two coupled ones.
- Every change keeps `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm e2e` green; CI runs all four plus the bundle budgets.

## If this repo moves

The demo URL and the repo slug are baked into a handful of places. `SITE_URL`
(`lib/constants.ts`) is the only one code reads — `metadataBase` derives the
preview card's absolute URLs from it, and a stale value there fails silently by
serving a card that 404s. The rest are prose and have to be edited by hand:

- `README.md` — the CI badge (repo slug, twice in one line), the live-demo link,
  and the `/system` link.
- `docs/walkthrough.md` — the live-demo link in the opening paragraph.
- `.github/workflows/ci.yml` — the deploy job's two summary lines, and the
  `--project-name` passed to `wrangler pages deploy`.

`node scripts/check-receipts.mjs` will not catch these; they are URLs, not
numbers.

## Commands

```
pnpm dev          # next dev
pnpm sim          # dev ws sim server
pnpm build        # must stay green — runs isolated from dev's .next (scripts/build-isolated.mjs), safe with dev up
pnpm lint         # zero warnings
pnpm test         # vitest
```

Parallel builds: builds auto-claim their own scratch workdir (4 warm slots, then a one-shot).
`E2E_PORT_BASE=4290` moves e2e ports + artifacts under `.e2e-cohort/4290/` (budgets read `…/main`); `E2E_STRESS_PORT` likewise.
