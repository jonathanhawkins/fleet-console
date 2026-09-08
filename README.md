# Fleet Console

[![CI](https://github.com/jonathanhawkins/fleet-console/actions/workflows/ci.yml/badge.svg)](https://github.com/jonathanhawkins/fleet-console/actions/workflows/ci.yml)

A fleet-operations console for home humanoid robots. Eight units on a map,
joint telemetry at 10 Hz, and one incident that carries an operator from a
glance to a named failed part — then down into the robot's own diagnostic
space to prove it. A design and engineering demo; all data is simulated.

**[Live demo →](https://fleet-console.pages.dev)** — a static build with the
simulator in a Web Worker. Nothing to wake up.

![The golden path: the fleet page raises an alert on N-07, the unit page shows the left knee running hot, Run diagnostic descends into a dark mono diagnostic board that walks twenty subsystems and six live-versus-reference channels, and the verdict names the left knee actuator.](docs/evidence/golden-path.gif)

_[Watch it as video (54 s, MP4)](docs/evidence/golden-path.mp4)_

## What to watch for

Open the demo and leave it running. Timings are from page load.

**0:20** — N-07's row in the rail names its suspect (_left knee +18 °C/min_)
while the unit still reads nominal. That is a least-squares fit over fifteen
seconds of joint temperature, not a threshold. **0:28** it goes `ATTENTION`;
the map marker and the alert feed react in the same frame batch. **0:38** red.

**Click N-07, then Run diagnostic.** Eighteen canvas instruments, and the left
knee's three traces are the only warm thing on the page. The descent drains it,
a black surface wipes up, and the type boots in phosphor mono. Fifteen seconds
later the verdict reads `KNEE_L · ACTUATOR A-07 — GAIN ANOMALY`, with the
evidence under it.

**Command safe sit, then CONFIRM.** The narration arrives from the wire —
`GAIT ARRESTED` → `POSTURE SETTLED` — and N-07 stays red, because
broken-but-safe is the honest state. **ESC** returns to operator space with the
incident on file.

Three more storylines share the same clock: a blocked route that recovers
itself, four units raising the same firmware warning with a staged rollback,
and the one fault a recalibration genuinely fixes. _Jump to_ in the footer
replays the run and stops eight seconds short of any of them. Full script in
[docs/walkthrough.md](docs/walkthrough.md).

## Two worlds

**Operator space** is warm white, Geist Sans, wide-tracked small-caps labels,
pill buttons, muted sage and clay — the surface you glance at like a
thermostat. **Machine space** is what the robot says about itself: phosphor
mono on near-black, radius zero, hierarchy by luminance. Crossing between them
is the whole interaction.

No component takes a `space` prop. Both worlds are one semantic token layer
resolved twice under `[data-space]`, so a card has one implementation rather
than two that drift. [`/system`](https://fleet-console.pages.dev/system)
renders the library in both, from the same elements.

## What's actually hard here

- **10 Hz of telemetry costs the store nothing.** Samples never enter reactive
  state — they land in `Float64Array` rings beside a per-unit version counter,
  and only that unit's subscribers hear about it. The store commits when a fact
  an operator reads changes, not when a sample does.
- **Every chart is raw canvas on one shared rAF loop.** Eighteen instruments,
  zero chart DOM nodes, no charting library, and a draw that skips entirely
  when no sample arrived.
- **Playwright tests the artifact that ships.** One `TelemetryTransport`
  interface, two implementations — a `ws` server in dev, the identical engine
  in a Web Worker for the static deploy — and a test pins the two streams
  byte-identical.
- **The component boundary is enforced by lint, not by etiquette.**
  `@/components/console` is the only door to shadcn, and it may not import a
  store; app code that reaches past it fails the build.

More in [docs/architecture.md](docs/architecture.md).

### If you only read four files

- **[lib/transport/workerTransport.ts](lib/transport/workerTransport.ts)** —
  the boundary. Where zod validates, where "open" means the first message that
  parses rather than the first `postMessage`, and where a worker that never
  answers becomes a reported status instead of a hang.
- **[components/fleet/telemetry-strip/strip-draw.ts](components/fleet/telemetry-strip/strip-draw.ts)**
  — the hot path, and the reason the frame budget holds.
- **[components/machine/wireframe-elevation.tsx](components/machine/wireframe-elevation.tsx)**
  — the descent's hardest surface: the robot's own extracted edge set,
  projected and bucketed onto a luminance ladder by arithmetic, no three.js.
- **[app/styles/tokens.css](app/styles/tokens.css)** — the two worlds. Every
  colour resolves from here; nothing downstream knows which space it is in.

## Receipts

Measured on the static export, the exact artifact that deploys. The budget
check runs at the end of every `pnpm e2e`, and CI posts this table to the job
summary.

| Budget                                   | Measured                                 | Verdict |
| ---------------------------------------- | ---------------------------------------- | ------- |
| Fleet page initial JS < 200 KB gz        | **183.2 KB**                             | PASS    |
| Unit page initial JS < 200 KB gz         | **192.2 KB**                             | PASS    |
| 60 fps during the descent                | p95 frame 9.2 ms, 1 of 974 over 16.7 ms  | PASS    |
| Interaction latency < 100 ms             | Run-diagnostic press → feedback 1.3 ms   | PASS    |
| Component view (three + GLB) < 500 KB gz | 321.7 KB, lazy                           | PASS    |
| 500 units                                | ~5,000 batches/s, 13.4 µs/msg, p95 10 ms | PASS    |

Lighthouse is a gate, not a quote: `scripts/lighthouse.mjs` runs the desktop
preset against all three routes on that same export and fails under 100 on
accessibility, best practices and SEO — which they hold every run — or under 90
on performance, which is 100 on `/` and `/system` and moves between 98 and 100
on `/unit/N-01`, where eighteen live instruments put real work on the main
thread at load. Reports in [docs/evidence/lighthouse/](docs/evidence/lighthouse/),
method and hardware in [docs/perf.md](docs/perf.md).

Lazy bundles, measured on the CI build: maplibre (271.4 KB gz) on fleet-page
mount, machine space (56.1 KB gz) warmed by the incident banner,
three + R3F (250.5 KB gz) on scroll approach.

Two scripts keep this page honest, because a number a repo prints about itself
is the last place drift should be allowed. `check-budgets.mjs` gates the table
above. `check-receipts.mjs` reads the suite counts, these chunk weights and
every copy of the deploy URL back out of the build, and fails CI when the
prose and the artifact disagree.

## Testing

`pnpm test` runs 1,528 specs across 99 files: console components, both stores'
reducers and guard rails, the transports against injected sockets and workers,
the ordering gate under scripted disorder, and the sim engine's determinism.
`pnpm e2e` builds the static export and runs five Playwright projects against
it — the golden path, leave-and-return, the firmware cohort, the phone at
390 px, and reduced motion at both viewports — then checks the budgets.

Accessibility is tested twice, because the two methods reach different places.
Lighthouse gates the three routes at rest. `e2e/accessibility.spec.ts` reaches
what it cannot: axe (WCAG 2 A/AA) on every surface the golden path opens —
the descent mid-scan, the verdict, the confirm gate, the incident report — then
walks the same path on the keyboard alone, asserting a visible focus ring at
every stop in both spaces. A 100 that never opened a dialog is a number about
the easy part.

## What this demo is not

Each of these is a decision, not an oversight.

- **One operator, no identity.** Every audit row carries an actor — operator,
  unit, or system — but nothing authenticates them. A real deployment needs
  sign-in and a shift handover; the actor field is the seam where that goes.
- **Nothing durable past the tab.** A reload resumes the storyline and its
  incidents out of `sessionStorage`. That is one tab remembering one sitting,
  not persistence.
- **One third-party origin, and it is the pretty one.** Basemap tiles from
  `tiles.openfreemap.org`, the only external request the app makes. Blocked or
  slow, it degrades to a state that keeps every marker and says so — proven by
  `e2e/map-degraded.spec.ts` with the host blocked. It is not a _fallback_:
  there is no bundled basemap, so a strict proxy means a fleet on blank ground.
- **No fleet-scale write path**, except the firmware rollout — deliberately the
  exception that shows why fleet-scoped commands need their own confirmation
  and their own audit.

## On tooling

Built with Claude Code, and the commit trailers say so rather than leaving it
to be found. The judgment is mine — the two-space thesis, what to measure,
what to leave out, and when a fix turned out to cost more than the thing it
fixed. The numbers on this page are machine-checked for the same reason they
are here at all: a claim about your own work should be something a reader can
verify rather than take on trust.

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
