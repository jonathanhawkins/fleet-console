# `@/components/console`

The console library: the primitives both spaces are built from, and the only
component module the app is allowed to import from directly.

Everything here renders correctly in **operator space** (warm white, Geist Sans,
pill buttons) and in **machine space** (phosphor mono on near-black, radius 0)
without being told which one it is in. `/system` is the proof — it draws every
export below twice, from the same element, under `data-space="operator"` and
`data-space="machine"`.

## The four rules

**1. No component takes a `space` prop.** A component asks for a token; the
token resolves differently under each `[data-space]`. This is the whole design:
a card that branches on which world it is in has two implementations to keep in
step, and they drift. If a component needs to look different in machine space,
that difference belongs in the token layer or in a `machine:` variant — never in
a prop, and never in a conditional.

**2. No hardcoded colour, ever.** Every value comes from a CSS variable
(`app/styles/tokens.css`). Canvas is the one place that cannot read a variable
directly, so it reads through `lib/tokens/fallback.ts` — which is drift-tested
against the stylesheet, so a token changed in CSS and forgotten in the fallback
fails a test rather than a screenshot.

**3. Nothing here imports a store.** These are pure components and hooks: props
in, markup out. The store-wired regions live in `@/components/fleet`, which is
built _from_ this library. The split is what makes the library a library — you
can lift any file here into another project without bringing a zustand store
with it. It is lint-fenced, not just documented.

**4. Everything is documented in `/system`.** `app/system/specimens.tsx` holds
one entry per export, and `app/system/catalogue.test.tsx` fails the build if the
barrel gains a component that is not documented there. Adding a component means
adding a specimen.

## What is in here

**Components** — `ConsoleButton`, `ConsoleCard`, `ConsoleHeader`,
`ConsoleFooter`, `SectionLabel`, `StatusChip`, `StatGroup`, `BatteryMeter`,
`UnitCard`, `Disclosure`, `RegionNote`, `PostureTag`, `ConnectionStatus`.

**Hooks and helpers** — `registerFrame` (the one shared rAF loop every canvas in
the app draws on: one loop, not one per instrument), `usePrefersReducedMotion`
and `useMediaQuery`, `stripScales` with the joint and metric specs (`JOINTS`,
`METRIC_SPEC`, `envelope`, `jointLabel`), status and severity mapping
(`unitStatusChip`, `alertSeverityChip`, `needsAttention`), relative time
(`useNow`, `formatRecency`, `isoTime`), and the descent's motion and occlusion
helpers (`descentTimeline`, `isDescentOccluded`).

A handful of modules here are deliberately _not_ in the barrel — `trend-watch`,
`product-mark` — because they are internals of exactly one component. The
barrel is the library's surface; the folder is its implementation.

## Using one

```tsx
import { ConsoleCard, SectionLabel, StatusChip } from "@/components/console";

<ConsoleCard label="Units" labelAs="h2" action={<Controls />}>
  <SectionLabel as="h3">Left knee</SectionLabel>
  <StatusChip status="warn">Attention</StatusChip>
</ConsoleCard>;
```

There is no theme provider and no context to wrap. Put the subtree under
`data-space="machine"` and every component inside it is already in machine
space.

## Adding one

1. Write it here, pure, with no store import and no `space` prop.
2. Export it from `index.ts`.
3. Add a specimen to `app/system/specimens.tsx` — `catalogue.test.tsx` will fail
   until you do.
4. Check it in both spaces on `/system`, not just the one you were building for.
