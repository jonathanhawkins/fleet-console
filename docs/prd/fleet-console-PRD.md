# Fleet Console, PRD

> **This is the plan as it was written before the build, kept unedited.** It is
> here because the interesting thing about a spec is where it turned out to be
> wrong, and that is only legible if it still says what it said. What actually
> shipped is in [the README](../../README.md); the gap is summarised under
> [§6](#6-phases). Phase numbering is this document's own and appears nowhere
> in the code.

A demo fleet-operations platform for home humanoid robots, built as a design and engineering showcase. An original, fictional product inspired by consumer home-robot design. No company names and no third-party logos, renders, or assets anywhere in the shipped app; our robot is our own stylized silhouette, units are named "N-07" style.

Every phase maps to one of four outcomes: real-time visibility and control of robots (individual and fleets), intuitive dashboards and workflows, performance and reliability, and a component library built on engineering best practices.

## 1. Design thesis (read this first, it governs everything)

The product has two visual worlds, and the transition between them is the signature of the entire demo. Spend the boldness there and nowhere else.

**Operator space (light).** The default UI. Calm, warm white, consumer-grade. This is the house-and-family world consumer robotics sells: an operator glances at it the way you glance at a thermostat. Reference: the operator-space notes in [docs/images/REFERENCES.md](../images/REFERENCES.md) (the captures themselves are third-party material and stay local).

**Machine space (dark).** What the robot itself reports when something is wrong. Entering diagnostics is a descent: the page dims, a black surface wipes up, and the type switches to phosphor mono. This is the Evangelion language: per-component OPERATING/DAMAGED boards, waveform strips, a program-walk log. Reference: the machine-space notes in [docs/images/REFERENCES.md](../images/REFERENCES.md).

The UX meaning of the contrast: crossing from monitoring into diagnosis. The operator always knows which world they are in. Everything outside the descent stays quiet and disciplined; no neon leaks into operator space, no rounded pills leak into machine space.

One scripted golden path, rock solid, demoable in 90 seconds:

fleet map -> alert appears -> click unit -> live telemetry drill-in -> Run diagnostic -> descent into machine space -> scan walks subsystems with waveforms -> verdict: LEFT KNEE ACTUATOR A-07, GAIN ANOMALY -> recommendation card -> back to operator space with incident logged.

## 2. Scope guardrails

- One incident, fully choreographed, beats ten half-features. Everything in Phase 5 is cut without guilt if the week runs short.
- All data is simulated and labeled as such. Nothing pretends to be telemetry from a real product.
- Footer on every page: "A design and engineering demo. All data is simulated." (amended 2026-08-24/2026-08-30: no company naming anywhere)
- The eva-* reference images inform the aesthetic; no copied frames ship in the UI.
- Timebox: seven evenings plus one weekend day. Ship whatever exists at day seven.

## 3. Stack and packages

Framework and language:

```
next@15            App Router, static export capable for deploy
react@19
typescript@5       strict mode everywhere
tailwindcss@4      token-driven theming via CSS variables
```

Component strategy, the answer to "shadcn or our own": **shadcn/ui as primitives, heavily themed, wrapped in our own layer.** shadcn gives accessible Radix behavior (dialogs, popovers, tabs) in an afternoon; rebuilding those is a week of undifferentiated work. But nothing ships looking like stock shadcn. All color, radius, type, and spacing flow from our token layer, and app code never imports shadcn directly; it imports from `@/components/console` (our library: StatusChip, UnitCard, AlertRail, TelemetryStrip, DescentOverlay, ScanLog, WaveformStrip, VerdictCard). That wrapper library IS the "component libraries and engineering best practices" deliverable, and the README documents it as such.

```
shadcn/ui (Radix primitives), class-variance-authority, tailwind-merge, clsx
lucide-react                   operator-space icons only, thin stroke
framer-motion                  the descent transition and micro-interactions
zustand                        client state (fleet store, incident store)
zod                            runtime validation of every telemetry message
@tanstack/react-virtual        fleet list virtualization (perf receipt)
maplibre-gl                    fleet map (custom monochrome style, free tiles)
three, @react-three/fiber, @react-three/drei    Phase 4 component view
d3-scale                       scales only; all waveform drawing is raw canvas
```

Dev, test, tooling:

```
vitest + @testing-library/react    unit tests on console components and stores
playwright                         one e2e: the full golden path
eslint + prettier                  zero-warning CI bar
ws                                 dev sim server
```

Deliberate exclusions: no chart library (waveforms and sparklines are hand-drawn canvas/SVG, it is the perf story and the look demands it), no Google Maps (API keys in a public repo, generic cartography that fights the aesthetic), no CSS-in-JS runtime.

## 4. Architecture

```
/app                    Next.js routes: / (fleet), /unit/[id], /system (design system gallery)
/components/console     our component library (the deliverable)
/components/machine     machine-space components (canvas-heavy, mono)
/lib/transport          TelemetryTransport interface + two impls
/lib/stores             zustand stores, message reducers
/lib/schema             zod message schemas (shared with sim)
/sim                    the simulator (runs as ws server in dev, Web Worker in prod)
/public/models          chassis-silhouette.glb, decimated point cloud (stretch)
```

**Transport abstraction, the key architectural move.** One interface, two implementations:

```ts
interface TelemetryTransport {
  connect(onMessage: (msg: FleetMessage) => void): void;
  send(cmd: OperatorCommand): void; // e.g. RUN_DIAGNOSTIC
  disconnect(): void;
}
```

`WsTransport` connects to the local `ws` sim server in dev. `WorkerTransport` runs the identical simulator inside a Web Worker for the deployed build, so the public demo is fully static (Vercel or Cloudflare Pages), needs no backend, and never dies from a sleeping server during someone's review. Same message contract, same zod schemas, swap by env flag. The README calls this out; it demonstrates system boundaries without a single line of backend infra.

**Message contract (zod-validated, batched):**

```ts
type FleetMessage =
  | { t: "fleet_snapshot"; units: UnitSummary[] } // on connect
  | { t: "telemetry"; unitId: string; ts: number; batch: TelemetryPoint[] } // 10 Hz, batched
  | { t: "alert"; alert: Alert }
  | { t: "diag_event"; unitId: string; ev: DiagEvent }; // scan choreography

type TelemetryPoint = {
  joint: string;
  tempC: number;
  torqueNm: number;
  currentA: number;
  battery: number;
};

type DiagEvent =
  | { k: "scan_start" }
  | { k: "walk"; path: string } // file-walk lines
  | { k: "channel"; joint: string; wave: number[]; ref: number[] } // waveform vs expected
  | { k: "flag"; joint: "knee_L"; component: "actuator_A07"; anomaly: "gain" }
  | { k: "verdict"; report: VerdictReport };
```

**The scripted incident (the sim's storyline).** Eight units live on the map. Unit N-07, "Elm House," runs nominal for ~15 s, then its left-knee actuator begins a temperature climb and torque ripple. The sim raises an amber alert, then red. When the operator sends RUN_DIAGNOSTIC, the sim streams the diag_event sequence: scan_start, ~20 walk lines, six channel events (healthy joints match their reference waveform; knee_L visibly diverges), flag, verdict. The verdict recommends: disable joint, command safe sit, dispatch service. The incident is then listed in the unit's history with a replay entry (stretch). Loop resets on command so the demo is re-runnable.

## 5. Design system (Phase 0 deliverable, aesthetics before features)

Tokens as CSS variables, two themes on `[data-space="operator" | "machine"]`.

**Operator space.** Palette: `--bg #FAFAF9` warm white, `--surface #F2F1ED` greige, `--ink #171715`, `--muted #8B8A84`, `--line #E4E2DC`, status: sage `#5E7D5A`, amber `#B8862F`, clay alert `#B5473A` (muted, never neon). Type: Geist Sans; small-caps labels with wide tracking (the careers-page move from the reference set); generous whitespace; large radius, pill buttons; soft single-direction shadows. Map style: near-monochrome light basemap, fine gray line work, isometric SVG house glyphs as markers echoing the factory diagram.

**Machine space.** Palette: `--bg #060606`, phosphor `#3BFF6F`, amber `#FFB000`, alert `#FF3B30`, magenta accent `#FF3E9A` used sparingly (per the EVA panels), grid line `#1C1C1C`. Type: JetBrains Mono everywhere, uppercase section labels, dense leading. Radius 0. No shadows; hierarchy comes from luminance and rules. A faint 1px horizontal scan texture is permitted at under 4 percent opacity; anything stronger is costume.

**Motion.** One orchestrated moment: the descent. Operator page desaturates and dims (200 ms), black panel wipes bottom-to-top (350 ms, custom ease), mono type "boots" with staggered line reveals. Return ascends in reverse, faster. Everything else: 120 to 180 ms micro-transitions only. `prefers-reduced-motion` swaps the descent for a crossfade.

**Copy.** Operator space in plain verbs and sentence case: "Run diagnostic," "Dispatch service," "All units nominal." Machine space in terse uppercase system voice: "SCANNING ACTUATOR BUS," "CHANNEL 06 DIVERGENCE." Errors say what happened and what to do; no apologies, no filler.

**Quality floor, unannounced:** responsive to tablet width (fleet ops on an iPad is a real use case), visible keyboard focus in both themes, AA contrast in operator space (machine space phosphor-on-black passes trivially).

`/system` route renders the whole library in both themes: the design-system gallery is itself a demo artifact and a screenshot source.

## 6. Phases

**Phase 0, Foundation and tokens (evening 1).** Scaffold, strict TS, tokens, both themes, Geist and JetBrains Mono, the `/system` gallery with StatusChip, buttons, cards in both spaces. DoD: a screenshot of the gallery already looks unmistakably like the two reference worlds.

**Phase 1, Operator shell and fleet map (evenings 2 to 3).** MapLibre custom light style, eight unit markers with live status, virtualized fleet rail, alert feed over the transport (sim streaming), header with fleet KPIs (units nominal, alerts, avg battery). DoD: alert fires on N-07 and the map marker, rail, and feed all react within one frame batch.

**Phase 2, Unit drill-in (evening 4).** `/unit/N-07`: live canvas sparklines per joint (temp, torque, current), battery, status timeline, incident banner with "Run diagnostic" as the single primary action. DoD: 10 Hz batched telemetry renders at 60 fps with charts as canvas, not DOM.

**Phase 3, The descent (evenings 5 to 6, protect this time, it is the money shot).** DescentOverlay transition; ScanLog (the MAGI-style program walk, virtualized lines); six WaveformStrip channels drawing live from `channel` events, reference trace in dim green, live trace over it, knee_L diverging in amber then red; the OPERATING/DAMAGED component board straight from the EVA parts-status reference; flag beat with a red rule sweep; VerdictCard with the anomaly, evidence thumbnails, and three recommended actions; ascend back with the incident now in history. DoD: the full descent runs off streamed diag_events, not setTimeout theater, and survives a mid-scan disconnect gracefully.

**Phase 4, Component view in 3D (evening 7).** Flat-shaded original silhouette (own Blender model, under 15k tris, no rig), eight clickable named components, knee actuator emissive-highlighted during and after the incident, gentle orbit, drei stage lighting to match whichever space it renders in. DoD: loads under 500 KB gzipped, interactive at 60 fps, and is a garnish, cut to a 2D schematic if it threatens the schedule.

**Phase 5, Stretch (weekend, only if 0 to 4 are done and solid).** In order: (a) point-cloud room view, one open indoor scan decimated to under 400k points, robot position marker; (b) incident replay, a canned clip labeled INCIDENT REPLAY on the verdict card; (c) a ninth unit backed by the real ESP32 recorder streaming true device telemetry through the same transport, one physical device on a simulated fleet.

**Phase 6, Hardening and ship (final evening).** Perf pass with numbers in the README (bundle sizes, fps under load, message throughput), Lighthouse run, Playwright golden-path e2e green, deploy static build with WorkerTransport, record the 90-second demo video following the golden path, README with architecture diagram, design thesis, perf notes, and the simulated-data disclaimer.

### What shipped against this, and what did not

Phases 0 to 4 and 6 shipped, and the storyline grew past them: the plan had one
incident, and the sim now runs four on one clock (a self-recovering navigation
fault, a firmware cohort with a fleet-wide rollback, and the encoder offset a
recalibration actually fixes — the counterweight to the knee's `PARTIAL`).
Commands, an audit trail, an incident report, and the design-system gallery as
real documentation were all beyond the plan.

**Phase 5 was cut in full, on the guardrail in §2**, and none of it is in the
app: no point-cloud room view, no incident replay, and no ESP32-backed ninth
unit. The fleet is eight simulated robots and says so on every page.

The estimates were the least accurate part of this document. Nothing here
costed the hardening — accessibility across two colour spaces, reduced motion,
the failure paths, the budget work — which took longer than the features did.

## 7. Performance requirements (claims need receipts)

- Waveforms and sparklines on canvas with a single rAF loop; zero chart DOM nodes.
- Telemetry batched at the transport (10 Hz batches, one store commit per batch, one render per commit).
- Fleet rail virtualized; map markers updated imperatively, not re-rendered through React.
- Route-level code splitting: three.js loads only on the component view; machine-space bundle lazy-loads on first descent.
- Budgets: initial JS under 200 KB gzipped for the fleet page; interaction latency under 100 ms; steady 60 fps during the descent on an M-series laptop.
- README documents each of these with measured numbers, not claims.

## 8. Success criteria

The 90-second recording shows: a calm light fleet at a glance, an alert arriving, a two-click path to the failing unit, one button into a descent that feels like crossing into the machine, a diagnosis a non-engineer can follow to a single failed actuator, and a recommendation that resolves it. A viewer should finish it thinking two things at once: whoever built this has taste, and they ship. Repo public, demo deployed.
