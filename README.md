# Fleet Console

A fleet-operations console for home humanoid robots. Eight units on a map,
joint telemetry at 10 Hz, and one incident that walks an operator from a
glance to a named failed part. A design and engineering demo; all data is
simulated.

**[Live demo →](https://fleet-console.pages.dev)** — a static build with the
simulator in a Web Worker. Nothing to wake up.

![The golden path: the fleet page raises an alert on N-07, the unit page shows the left knee running hot, Run diagnostic descends into a dark mono diagnostic board that walks twenty subsystems and six live-versus-reference channels, and the verdict names the left knee actuator.](docs/evidence/golden-path.gif)

[Watch it as video (54 s, MP4)](docs/evidence/golden-path.mp4)

## What to watch for

Open the demo and leave it running. Timings are from page load.

1. **0:20** — `TRENDING` ticks to 1. N-07's rail row names its suspect
   (_left knee +18 °C/min_) while the unit still reads nominal. That is a
   least-squares fit over fifteen seconds of joint temperature, not a
   threshold.
2. **0:28** — N-07 goes `ATTENTION`; the map marker and the alert feed
   react in the same frame batch. **0:38** — it goes red.
3. **Click N-07.** Eighteen canvas instruments; the left knee's three traces
   are the only warm thing on the page. **Press Run diagnostic.**
4. **The descent.** The page drains, a black surface wipes up, and the type
   boots in phosphor mono. Fifteen seconds later the verdict reads
   `KNEE_L · ACTUATOR A-07 — GAIN ANOMALY`, with the evidence underneath it.
5. **Press Command safe sit, then CONFIRM.** The narration arrives from the
   wire — `GAIT ARRESTED` → `POSTURE SETTLED` — and N-07 stays red, because
   broken-but-safe is the honest state.
6. **ESC.** Operator space returns with the incident on file. Press the
   `INC-N07-…` reference for the report a technician would be handed.

Three more storylines share the same clock: N-03 halts on a blocked route at
2:00 and recovers itself; from 3:00 four units raise the same warning on the
same firmware, with a rollout to halt and a cohort to roll back; and at 5:30
N-01 reports the one fault a recalibration genuinely fixes, so the same
command that came back `PARTIAL` on the knee clears it. They are described
in [docs/walkthrough.md](docs/walkthrough.md). _Reset simulation_
in the footer replays everything from the same seed.

## Two worlds

**Operator space** is warm white, Geist Sans, wide-tracked small-caps labels,
pill buttons, muted sage/amber/clay. The surface you glance at like a
thermostat. **Machine space** is what the robot says about itself: phosphor
mono on near-black, radius zero, hierarchy by luminance. Crossing between them
is the whole interaction, and no component takes a `space` prop — both worlds
are one semantic token layer resolved twice, under `[data-space]`.
[`/system`](https://fleet-console.pages.dev/system) renders the library in
both.

## Architecture

```mermaid
flowchart TD
  E["sim/engine/<br/>pure · seeded · injectable clock"]
  S["sim/server.ts<br/>ws host (dev)"]
  H["sim/worker-host.ts<br/>Web Worker host (deploy)"]
  T["TelemetryTransport<br/>connect · send · disconnect"]
  Z["zod boundary + ordering gate"]
  P["telemetryChannel<br/>rings + per-unit versions, outside React"]
  L["one shared rAF loop"]
  N["canvas instruments<br/>zero chart DOM nodes"]
  F["fleetStore<br/>status · alerts · incidents"]
  C["React tree<br/>narrow selectors"]

  E --> S --> T
  E --> H --> T
  T --> Z
  Z -- telemetry --> P
  Z -- "status · alerts · commands" --> F
  P --> L --> N
  P -. "useSyncExternalStore per unit" .-> C
  F --> C
  C -. "send(OperatorCommand)" .-> T
```

- **One transport interface, two implementations.** `WsTransport` speaks to
  a `ws` server in development; `WorkerTransport` runs the identical engine in
  a Web Worker for the static deploy. A test pins the two streams
  byte-identical, which is what lets Playwright test the artifact that ships.
- **10 Hz of telemetry costs the store nothing.** Samples never enter
  reactive state: they land in `Float64Array` rings beside a per-unit version
  counter, and only that unit's subscribers are notified. Canvas hosts read the
  rings in the frame loop and skip the draw when nothing arrived. The store
  commits when a fact an operator reads changes, not when a sample does.
- **Delivery is treated as hostile at the boundary that already validates.**
  Stale telemetry is dropped whole, command events order by an engine
  sequence, and a snapshot resets every gate.
- **The console never animates a maneuver the robot has not agreed to.**
  Recommendations are split by data: one executes, the others record, and
  `Disable joint` is inert until the unit is seated. Confirmations open with
  ABORT focused; refusals print in the machine's own words.
- **Privacy is modelled, not mentioned.** Home positions are quantized to a
  ~500 m grid and the map zoom is capped below street level.
- **The component boundary is enforced by lint.** `@/components/console` is
  the only door to shadcn; a `no-restricted-imports` rule fails the build if
  app code reaches past it.

## Receipts

Measured on the static export, the exact artifact that deploys. The budget
check runs at the end of every `pnpm e2e` and CI posts the table to the job
summary; the numbers below are copied from that output.

| Budget                                   | Measured                                 | Verdict |
| ---------------------------------------- | ---------------------------------------- | ------- |
| Fleet page initial JS < 200 KB gz        | **180.5 KB**                             | PASS    |
| Unit page initial JS < 200 KB gz         | **188.7 KB**                             | PASS    |
| 60 fps during the descent                | p95 frame 9.2 ms, 1 of 974 over 16.7 ms  | PASS    |
| Interaction latency < 100 ms             | Run-diagnostic press → feedback 1.3 ms   | PASS    |
| Component view (three + GLB) < 500 KB gz | 321.7 KB, lazy                           | PASS    |
| 500 units                                | ~5,000 batches/s, 13.4 µs/msg, p95 10 ms | PASS    |

Lighthouse is a gate, not a quote: `node scripts/lighthouse.mjs` runs the
desktop preset against `/` and `/unit/N-01` on the same export and fails under
performance 90 or any other category under 100. CI runs it after the budgets
on every push, gating the three deterministic categories and reporting
performance, which on a shared runner measures the runner more than the page.
The full reports, cut on the hardware documented in docs/perf.md, are the
receipt —
[docs/evidence/lighthouse/index.json](docs/evidence/lighthouse/index.json)
and [docs/evidence/lighthouse/unit-N-01.json](docs/evidence/lighthouse/unit-N-01.json)
(load either in the Lighthouse Viewer).

Lazy bundles: maplibre (268.6 KB gz) on fleet-page mount, machine space
(56.1 KB gz) warmed by the incident banner, three + R3F (249.4 KB gz) on
scroll approach. Details and method in [docs/perf.md](docs/perf.md).

## Component library

Two folders, one direction of dependency. `@/components/console` is the
library: pure primitives and hooks that import nothing from the stores, wrap
shadcn's Radix behaviour, and render in both spaces without being told which
one they are in. `@/components/fleet` is this app: the store-wired regions built
out of those primitives. A lint rule enforces the direction — `console` may not
import `lib/stores` or `components/fleet` — so a primitive that grew a
subscription would fail the build rather than quietly become a region.

| Console primitive                 | What it is                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `StatusChip`                      | A quiet tinted pill in operator space, an inverted `OPERATING`/`DAMAGED` block in machine space. Same element. |
| `ConsoleButton`                   | The one black pill per screen, and its quieter siblings; square and mono below the descent.                    |
| `ConsoleCard`                     | A surface separated by warmth and a hairline, never by weight.                                                 |
| `UnitCard`                        | One home in the fleet as a fixed-height row; pure, so the rail subscribes per row.                             |
| `BatteryMeter`                    | A charge level as a bar, not a gauge.                                                                          |
| `StatGroup`                       | A labelled figure that renders an em-dash, never an invented number, while pending.                            |
| `SectionLabel`                    | The wide-tracked small-caps label that names every region.                                                     |
| `ConsoleHeader` / `ConsoleFooter` | The shell: the typographic mark, and the disclaimer on every page.                                             |
| `registerFrame`                   | The one shared rAF loop every canvas instrument draws on.                                                      |

| Fleet region     | What it is                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `FleetRail`      | The virtualized unit list. Eight units today, the same code at eight hundred.               |
| `AlertRail`      | The feed. Newest first, deduped, capped, and the only region allowed to raise its voice.    |
| `FleetMap`       | MapLibre behind a dynamic boundary; marker DOM is mutated imperatively, never reconciled.   |
| `TelemetryStrip` | One joint, one measure, as a canvas instrument on the shared frame loop.                    |
| `StatusTimeline` | The session as one band: has this unit been fine, and when did that stop.                   |
| `IncidentBanner` | The one loud object in operator space. Holds the single primary action.                     |
| `DescentOverlay` | The gate: decides when the descent may begin, drains the page, mounts machine space lazily. |
| `ComponentView`  | The 3D chassis behind its own dynamic boundary.                                             |
| `CohortCard`     | The fleet incident: four robots on one build, the halt, the staged rollback.                |

Machine space lives in `components/machine` and is not re-exported from either
barrel, so it never rides in the unit page's initial JS: `ScanLog`,
`WaveformDeck`, `StatusBoard` + `PartsManifest`, and `VerdictCard`.

## Testing

`pnpm test` runs the vitest suite: console components, both stores' reducers
and guard rails, the transports against injected sockets and workers, the
ordering gate under scripted disorder, and the sim engine's determinism and
choreography. `pnpm e2e` builds the static export and runs five Playwright
projects against it — the golden path, leave-and-return, the firmware cohort,
the phone at 390 px, and reduced motion at both viewports — then checks the
bundle budgets. CI runs lint, typecheck, unit, e2e and budgets on every push.

## What this demo is not

Worth saying plainly, because each of these is a decision rather than an
oversight:

- **One operator, no identity.** Actions are attributed to "Operator" and the
  audit trail has no actor field. A real deployment needs authentication,
  per-user attribution, and a handover between shifts, because the audit
  trail's whole value is who did what.
- **Nothing is durable.** Every store is in memory, so a reload loses the
  incident record and the acknowledgements. The incident report exists to be
  printed and handed on; behind it a real console needs a server that keeps it.
- **No fleet-scale write path.** Commands go to one unit at a time, except the
  firmware rollout, which is deliberately the exception that shows why
  fleet-scoped commands need their own confirmation and their own audit.

## Run it

```bash
pnpm install
pnpm sim      # ws simulator on :8791
pnpm dev      # http://localhost:3000
```

`pnpm build:static` emits `out/` with the simulator in a Web Worker; that is
what the live demo serves.

---

A design and engineering demo. All data is simulated. MIT licensed.
