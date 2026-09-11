# The calm diagnostic — operator-space specification

The diagnostic flow gets a new default rendering in operator space. The dark
machine space stays, behind a toggle, off by default. This document is what an
engineer builds the default from.

Scope: **same capabilities, less theatre.** Every fact the machine board
carries survives. The spectacle does not.

Everything below names real tokens from `app/styles/tokens.css`, real exports
from `@/components/console`, and real strings from the sim. Where a value is a
judgement call rather than a derivation, it says so.

---

## 1. What the machine board gets right

Read this before deleting anything. Several of these look like decoration and
are not.

**1.1 The trace changes colour along its own length.** `writeSampleTones`
(`lib/diagnostics/waveform-math.ts`) walks a 20-sample window, normalises
the local deviation by the local reference energy, and writes a per-sample tone
into a `Uint8Array`. The knee's fault ramps 1.35× → 1.8× across the window, so
the trace *leaves* nominal, crosses warn, and arrives alert. A non-engineer
reads that gradient as "this got worse", which is what happened. A flat colour
would state a conclusion; the gradient shows a process. **Keep this. It is the
single best piece of information design in the dark version and it costs
nothing to carry over** — the function is pure, array-based, and already
computes once per channel on arrival.

**1.2 The reference is on screen before the live trace is.** The factory table
is drawn whole and immediately; the measurement is drawn against it. That
ordering is the argument. A design that faded both in together would be showing
a picture; this is showing a comparison.

**1.3 Missing channels print `—`, never `0.000`.** `channel-readout.tsx` renders
all seven rows from the first frame and dashes what has not arrived. This is
both an honesty rule and a layout rule, and the calm version depends on it even
more than the dark one does (§4.1).

**1.4 The flag is 600 ms after its channel.** `flagDelayMs: 600`. The
measurement lands, *then* the console names it. That gap is the epistemics of
the whole product rendered as timing, and it is free. Do not collapse it.

**1.5 Density is doing real work in the parts manifest.** Fifteen rows, four
status words, one inverted block. The board's claim is not "the knee is
broken" — it is "fourteen things were checked and found fine, and this one was
not". A calm version that shows only the finding makes a weaker claim with the
same words. **The count is the evidence for the diagnosis.**

**1.6 Gating is written on the control, not hidden behind it.** `Recalibrate
joint · REQUIRES SEATED POSTURE` is the label, not a tooltip. A screen reader
and the eye get the same fact. Carry the pattern exactly.

**1.7 The confirmation is inline and modal at the same time.**
`ExecuteConfirm` is pinned in the flow with `role="alertdialog"`,
`aria-modal="true"`, a two-element tab trap, Abort focused with
`preventScroll`, and Escape both handled and `stopPropagation`'d so the
surface's own Escape does not also fire. It has no animation, deliberately: "a
safety gate that fades in has a window in which it is visible and not yet
real." All of that transfers unchanged.

**1.8 Narration is one line and one rule, not a log.** `SAFE SIT · 45% ·
CROUCH PHASE` over a `role="progressbar"` hairline. Already calm. The register
changes; the shape does not.

**1.9 The `sr-only` announce fires on coarse beats, not per event.** Scan
start, a change of top-level subsystem, sweep open, divergence, verdict, hold —
never per walked node. That restraint is invisible and expensive to rediscover.
Carry the trigger list verbatim.

**What is genuinely theatre and goes:** the boot stagger, the wipe, the page
dim, the 1400 ms per-channel reveal sweep, the red cursor rule, `FlagBeat`'s
travelling bloom, the draggable dividers, the drag-to-dismiss sheet, the
`VerdictStrip` minimize, and the full-screen takeover.

---

## 2. Where the diagnostic lives

### 2.1 The recommendation

**A new `ConsoleCard`, labelled `Diagnostic`, inserted in the unit page's
column directly after `IncidentBanner` and before the incident-history card.**
It is one card in a page that is already a column of labelled cards. It grows
in, it never covers anything, and it can be scrolled past.

`app/unit/[id]/unit-detail.tsx` gains one line:

```
UnitIdentity
IncidentBanner
DiagnosticPanel        ← new
UnitIncidentLog
SessionLog
Status timeline card
Joint telemetry card   (18 instruments)
ComponentView
DescentOverlay         (now opt-in)
IncidentReport
```

### 2.2 Why not the alternatives

**Not a modal.** A modal is the machine takeover with the lights on. It has
the same defect the owner rejected: it hides the page that motivated the scan.

**Not a side panel.** The unit column is 832 px of content at 1024 px and
1208 px at 1400 px (`max-w-[1400px]` with `lg:px-24`). A side panel forces the
joint grid from `lg:grid-cols-3` to two columns, and the grid's entire layout
argument dies with it — `JOINT_GRID_ORDER` exists so that at three columns each
row is a leg and each *column* is a pair, hips above hips, knees above knees.
Asymmetry between a pair is the first thing anyone looks for in a walking
machine, and a side panel throws it away to make room for a scan. Reject.

**Not a dedicated route.** It displaces all eighteen instruments, adds
back/forward semantics to a fifteen-second event, and makes "leave the scan and
come back" (which the `watching` flag already models correctly) into a
navigation problem.

**Not a metamorphosis of the banner.** Tempting — press the pill and the object
under your finger becomes the thing you asked for. But the banner's tinted
ground (`--warn-tint` / `--alert-tint`) is the wrong surface for six traces and
a table, and untinting it mid-transition throws away the one thing the banner
is for. Two honest objects: *here is the problem*, *here is the investigation*.

### 2.3 What it displaces, and the mitigation

The panel is ~470 px tall during the scan and ~1050 px after the verdict
(§3.4). It pushes the status timeline and the joint grid below the fold on a
900 px viewport. That is correct for the fifteen seconds of the scan — the
operator is watching the scan — and it is a real cost afterwards.

Three mitigations, all reusing machinery that already exists:

1. **The banner stays above the panel and keeps carrying the unit's status
   colour.** The operator never loses the reason they came.
2. **The verdict's subject joint cross-highlights the joint grid.** On verdict,
   call `setSelectedPart(unitId, part)` (`part-selection.ts`) with the flagged joint's part
   (`knee_L` → the knee actuator part id). `JointGrid` already subscribes and
   answers with six `data-emphasis` attribute writes and zero renders, and its
   `reveal()` already refuses to scroll a cell that is off screen entirely — "a
   cross-highlight is a *find*, not a navigation". So the eighteen instruments
   are already dressed for the operator when they scroll down, and
   `ComponentView` lights the same actuator on the chassis. **No new
   machinery.**
3. **The panel collapses to a summary line once the operator ascends.** After
   `completeAscent()` the card is replaced by the existing incident-history row.

---

## 3. Layout

Page column: content width is `min(1400px, 100vw) − 2 × gutter`; gutter is
`px-24` (96) at ≥1024, `px-16` (64) at 768–1023. So **832 px at 1024**,
**1208 px at 1400**, **640 px at 768**. Card padding is `p-6` (24), so the
panel's inner measure is 784 / 1160 / 592.

### 3.1 Desktop (≥1024 px) — during the scan

```
┌─ IncidentBanner ─ rounded-xl border, bg = --warn-tint / --alert-tint ─────────┐
│ DIAGNOSTIC                                                                    │
│ Diagnostic in progress                                          (no button)   │
│ Left knee actuator trending hot, projected to overheat within 6 hours         │
└───────────────────────────────────────────────────── .diag-sweep hairline ────┘
                                                        ↑ 24px column gap (gap-6/8/10)
┌─ ConsoleCard variant="outlined" label="Diagnostic" labelAs="h2" ──────────────┐
│ DIAGNOSTIC                        Session 4F2A-91C0 · T+00:07  [Machine view] │  ← card header row
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Measuring actuator channels                            3 of 6 channels     │  ← stage line + count
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓─────────────────────────────────────────   │  ← ProgressRule, 2px
│                                                                               │
│  STRUCTURE AND FIRMWARE                                    ⌄ Subsystem walk   │
│  ┌──────────────────┬──────────────────┬──────────────────┐                   │
│  │ Heartbeat      ✓ │ Park pose      ✓ │ Gain tables 6/6✓ │                   │
│  │ Power rail 48V ✓ │ Walk cycle     ✓ │ IMU fusion     · │                   │
│  │ Thermal map    ✓ │ Balance reflex ✓ │                  │                   │
│  │ Spine bus      ✓ │                  │                  │                   │
│  └──────────────────┴──────────────────┴──────────────────┘                   │
│                                                                               │
│  ACTUATOR CHANNELS                          LIVE AGAINST FACTORY REFERENCE    │
│  ─────────────────────────────────────────────────────────────────────────    │
│   JOINT                                              RMS Δ           GAIN     │  ← 11px label row
│  ─────────────────────────────────────────────────────────────────────────    │
│   Left hip      ╭──╮  ╭──╮  ╭──╮                     0.004          1.01×     │
│                ─╯  ╰──╯  ╰──╯  ╰─                                             │
│  ─────────────────────────────────────────────────────────────────────────    │
│   Right hip     ╭──╮  ╭──╮  ╭──╮                     0.006          0.99×     │
│                ─╯  ╰──╯  ╰──╯  ╰─                                             │
│  ─────────────────────────────────────────────────────────────────────────    │
│   Left knee    ╭────╮╭────╮╭────╮                    0.183          1.62×     │  ← taller, tone-graded
│   SUBJECT     ─╯    ╰╯    ╰╯    ╰─                   (clay)         (clay)    │
│  ─────────────────────────────────────────────────────────────────────────    │
│   Right knee    ╭──╮  ╭──╮  ╭──╮                     0.005          1.00×     │
│                ─╯  ╰──╯  ╰──╯  ╰─                                             │
│  ─────────────────────────────────────────────────────────────────────────    │
│   Left ankle    —                                        —              —     │  ← not yet reported
│  ─────────────────────────────────────────────────────────────────────────    │
│   Right ankle   —                                        —              —     │
│  ─────────────────────────────────────────────────────────────────────────    │
│   Six channels against the factory calibration table, 120 samples each.       │  ← caption
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

Column widths inside the channel table at 784 px inner measure:

| column | width | alignment |
| --- | --- | --- |
| Joint (+ `SUBJECT` label under it) | `w-[9.5rem]` (152) | left |
| Trace | `flex-1` (≈ 428) | — |
| RMS Δ | `w-[5rem]` (80) | right, `tnum` |
| Gain | `w-[5rem]` (80) | right, `tnum` |
| gutters | `gap-6` ×3 = 72 | — |

Trace box is **56 px** tall (`TELEMETRY_STRIP_HEIGHT`, so the diagnostic's
instrument and the page's instruments are the same height). Row height is
`56 + py-3×2` = 80 px. Six rows = 480 px including rules.

### 3.2 Desktop (≥1024 px) — after the verdict

The card grows one region. Everything above stays exactly where it is; the
channel table does not move.

```
│  ─────────────────────────────────────────────────────────────────────────    │
│                                                                               │
│  FINDING ──────────────────────────────────────────────────────────────────   │  SectionLabel rule
│                                                                               │
│  Left knee actuator A-07                                                      │  text-title, --ink
│  Gain anomaly                                                                 │  text-heading, --alert-ink
│                                                                               │
│  Gain 1.62× envelope, five joints within tolerance.                           │  text-small, --ink-soft
│                                                                               │
│  │ LEFT KNEE ACTUATOR A-07: GAIN ANOMALY. LIVE TRACE 1.4-1.8x                 │  font-mono, --ink
│  │ REFERENCE ENVELOPE.                                                        │
│  │ RECORDED BY THE DIAGNOSTIC SCAN                                            │  SectionLabel
│                                                                               │
│  Consistent with control-gain drift, tendon wear, actuator degradation.       │  text-small --ink-soft
│  Try unloaded recalibration before module replacement.                        │
│                                                                               │
│  RECOMMENDED ACTIONS ──────────────────────────────────────────────────────   │
│                                                                               │
│  OVER THE LINK                                             REMOTE OPERATIONS  │  group head + tier
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │ 1   Command safe sit                             [  Command safe sit  ] │  │  ← the black pill
│  │     Brings the unit to a seated hold. Torque drops to a residual;       │  │
│  │     the fault stays. Required before either step below.                 │  │
│  ├─────────────────────────────────────────────────────────────────────────┤  │
│  │ 2   Recalibrate joint                            [ Recalibrate joint ] │  │  ← disabled
│  │     Drives the joint through its unloaded range and rewrites its gain   │  │
│  │     table.  Requires a seated posture.                                  │  │  ← reason, --warn-ink
│  └─────────────────────────────────────────────────────────────────────────┘  │
│  Executes on the unit · confirmation required                                 │
│                                                                               │
│  RECORDED TO THE INCIDENT                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │     Disable joint                                [   Disable joint   ] │  │  ← danger, disabled
│  │     Takes the knee out of the gait.  Requires a seated posture — the    │  │
│  │     knee is load-bearing.                          FIELD SERVICE        │  │
│  ├─────────────────────────────────────────────────────────────────────────┤  │
│  │     Dispatch service                             [ Dispatch service  ] │  │  ← secondary
│  │     Enters the incident record.                    FIELD SERVICE        │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│  Records to the incident on return · no command is sent                       │
│                                                                               │
│  ─────────────────────────────────────────────────────────────────────────    │
│  Incident INC-N07-4F2A logged.                      [ Open report ]           │
└───────────────────────────────────────────────────────────────────────────────┘
```

Height budget after verdict: head 96 + structure 130 + channels 520 + finding
240 + actions 300 + footer 56 ≈ **1050 px**. That is the moment the operator is
reading it, and it is one card in a scrolling column, not a takeover.

### 3.3 Tablet (768 px) — 592 px inner measure

Two changes, no reflow of the model:

- The structure grid drops to **two columns** (`sm:grid-cols-2
  lg:grid-cols-3`), 5 + 4.
- The channel row keeps its shape; the readings columns narrow to `w-[4.25rem]`
  and the joint column to `w-[7.5rem]`, leaving ≈ 380 px of trace. Trace height
  drops to **48 px**.
- The action rows stack: label and description on one block, control below it,
  full width (`max-[30rem]:w-full`, the banner's own breakpoint).

```
┌─ ConsoleCard label="Diagnostic" ────────────────────────────────┐
│ DIAGNOSTIC                            T+00:07   [Machine view]  │
├─────────────────────────────────────────────────────────────────┤
│  Measuring actuator channels                3 of 6 channels   │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓─────────────────────────────────────    │
│                                                                 │
│  STRUCTURE AND FIRMWARE                        ⌄ Subsystem walk │
│  ┌────────────────────────┬────────────────────────┐            │
│  │ Heartbeat            ✓ │ Balance reflex       ✓ │            │
│  │ Power rail 48 V      ✓ │ Gain tables      6/6 ✓ │            │
│  │ Thermal map          ✓ │ IMU fusion           · │            │
│  │ Spine bus            ✓ │                        │            │
│  │ Park pose            ✓ │                        │            │
│  │ Walk cycle           ✓ │                        │            │
│  └────────────────────────┴────────────────────────┘            │
│                                                                 │
│  ACTUATOR CHANNELS                 LIVE VS REFERENCE            │
│  ───────────────────────────────────────────────────────────    │
│   JOINT                              RMS Δ        GAIN          │
│  ───────────────────────────────────────────────────────────    │
│   Left knee   ╭──╮╭──╮╭──╮           0.183       1.62×          │
│   SUBJECT    ─╯  ╰╯  ╰╯  ╰─                                     │
│  ───────────────────────────────────────────────────────────    │
│                                                                 │
│  RECOMMENDED ACTIONS ───────────────────────────────────────    │
│  OVER THE LINK                            REMOTE OPERATIONS     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 1  Command safe sit                                       │  │
│  │    Brings the unit to a seated hold. Torque drops to a     │ │
│  │    residual; the fault stays. Required before step 2.      │ │
│  │    [        Command safe sit        ]                      │ │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

Below 768 the page is already a single narrow column; the same tablet shape
holds, with the trace at 40 px and the joint column collapsing to a line above
the trace rather than beside it.

### 3.4 Zero layout shift is a requirement, not a nicety

**Every row of both lists is rendered from the moment the panel opens.** Nine
structure entries in their pending state, six channel rows with `—` in every
column. Channels fill in place. This is `channel-readout.tsx`'s own rule ("Always
7 rows, whether or not the channels have arrived") and it is what makes the
calm version calm: nothing on the page moves for fifteen seconds except a
hairline and six traces appearing inside boxes that were already there.

The only growth in the whole flow is the verdict region at t+15 s, and that
growth is the payoff.

---

## 4. The nine facts, mapped

### Fact 1 — the scan is running, on which unit, how far along

**Where:** the card header row and the progress head.

- **Subject.** The card is inside the unit page; the `h1` twelve inches above
  it is `N-07`. Restating the unit inside the card would be the panel not
  trusting the page. What the header *does* carry is the session handle and the
  elapsed clock, both already computed by `scan-header.tsx`:
  `Session 4F2A-91C0 · T+00:07`, `text-label` `tnum` in `--ink-soft`, on the
  `ConsoleCard` `action` slot. The clock runs off the shared 1 Hz `useNow`.
- **Progress.** `ProgressRule` (new console primitive, §8), 2 px tall,
  full width, `--line` track, `--ink` fill, `transition-[width]` over
  `--dur-enter` with `--ease-console`.

  **Use `scanProgress()` from `lib/diagnostics/scan-progress.ts`.** It already
  exists, it is already pinned by a test against the simulator's own arrays,
  and its model is better than the one this spec first proposed. The fill is
  counted, never timed: `(walks + channels) / 26`, clamped, with the verdict
  settling it to 1. `role="progressbar"`, `aria-valuemin=0`,
  `aria-valuemax={total}`, `aria-valuenow={completed}`, `aria-labelledby` the
  stage line.

  > *Superseded.* An earlier draft of this spec counted cleared manifest parts
  > (`n / 15`) instead, and flagged a dead spot: six of the twenty walk paths
  > clear no manifest row, so that bar would stall from ≈ t+2.0 s to t+3.5 s.
  > Counting wire events instead of parts removes the gap entirely — all
  > twenty walks are units of work. Use the shipped module.

- **Stage line.** `text-body` in `--ink`, left of the count. Driven by
  `progress.stage` (`starting | subsystems | channels | complete`), with one
  refinement inside `subsystems`: name the subsystem currently underfoot,
  read off the top-level segment of the newest walk path. That is the same
  signal `scan-copy.ts` already uses to decide when to push the `sr-only`
  announce, so the two cannot disagree.

  | `stage` | condition | copy |
  | --- | --- | --- |
  | `starting` | — | `Starting scan` |
  | `subsystems` | newest path under `/sys` | `Checking core systems` |
  | `subsystems` | `/firmware` | `Checking gait firmware` |
  | `subsystems` | `/calib` | `Reading calibration tables` |
  | `subsystems` | `/proprio` | `Checking proprioception` |
  | `channels` | — | `Measuring actuator channels` |
  | `channels` | all six in, no verdict | `Concluding` |
  | any | link not open | `Link lost — scan held` (`--alert-ink`) |

  **The count to its right is stage-specific, not the raw fraction.**
  `17 of 26` is honest and means nothing to a reader; the bar already carries
  the proportion. So: `12 of 20 systems` during `subsystems`, `3 of 6
  channels` during `channels`, from `session.walkLines.length` and
  `session.channels.length` directly. `text-small` `tnum` `--ink-soft`.
- **Live region.** One `sr-only` `aria-live="polite" aria-atomic="true"` span
  carrying the same sentence, refreshed **only** on the coarse beats
  `scan-copy.ts` already enumerates: scan start, change of top-level subsystem,
  first channel, divergence, verdict, hold. Never per node, never per count.
- **Link loss.** When the transport drops, the stage line goes
  `--alert-ink`, the rule stops (fill holds at its last counted value; it must
  not animate to zero), and a `ConsoleButton variant="secondary" size="sm"`
  reading `Leave scan` appears in the card header calling `abortSession()`.
  This is `showReturn` in `scan-header.tsx`, translated. **It is easy to forget
  and it is a required state.**

### Fact 2 — progression through subsystems

**Where:** the `STRUCTURE AND FIRMWARE` grid, plus a disclosure.

The dark version shows this twice: twenty streaming log lines *and* fifteen
manifest rows, six of which are the same six joints the waveform deck is
already drawing. The calm version merges the duplication:

- **Manifest rows 0001–0006 are the six channel rows** (§4.3). They are not
  listed twice.
- **Manifest rows 0007–0015 are the structure grid** — nine entries, in
  operator names:

  | wire id | operator label | clears on |
  | --- | --- | --- |
  | `HEARTBEAT_SVC` | Heartbeat | `/sys/core/heartbeat.svc` |
  | `POWER_RAIL_48V` | Power rail 48 V | `/sys/core/power_rail/v48_main` |
  | `THERMAL_MAP` | Thermal map | `/sys/core/thermal/zone_map.cfg` |
  | `SPINE_BUS` | Spine bus | `/sys/actuator_bus/enumerate` |
  | `PELVIS_PARK` | Park pose | `/firmware/gait/park_pose.ko` |
  | `GAIT_CYCLE` | Walk cycle | `/firmware/gait/walk_cycle.ko` |
  | `BALANCE_REFLEX` | Balance reflex | `/firmware/gait/balance_reflex.ko` |
  | `GAIN_TABLES` | Gain tables | six `/calib/…` paths, shows `n/6` |
  | `IMU_FUSION` | IMU fusion | `/proprio/imu/fusion_state` |

  Reading order is the order they clear, so the grid fills top-to-bottom,
  column by column, and never skips around.

**Treatment.** A `grid sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-2.5` of
rows. Each row: label at `text-small` in `--ink-soft`, a dot leader
(`border-b border-dotted border-line` on a `flex-1` span — the manifest's own
dot leader, without the radial gradient), then the state mark:

- pending: `·` (middot), `--muted`, `aria-hidden`, with `sr-only` "not yet
  checked". No chip, no ghost box, no skeleton — a pending row is quiet.
- checked: `✓` drawn as a 10 px inline `<svg>` stroke in `--nominal`,
  `aria-hidden`, `sr-only` "checked". **Not** a `StatusChip`: nine sage pills
  reading OPERATING out-shout the one thing on the page that matters, which is
  the `tone="bare"` argument written on `status-chip.tsx` verbatim.
- `Gain tables` additionally prints `6/6` in `tnum text-label --ink-soft`
  before its mark, live from 0/6.

Transition on arrival: `opacity` and `color` over `--dur-micro`. Nothing moves.

**The twenty paths survive in a disclosure.** A `ConsoleButton variant="ghost"
size="sm"` in the group's label row reading `Subsystem walk`, with a caret,
`aria-expanded`, opening a `Disclosure` (already exported) holding the walked
paths **verbatim**, `font-mono text-small` in `--ink-soft`, one per line,
`max-h-[15rem] overflow-y-auto`, ordinal `0001`–`0020` in `--muted` `tnum`.

Mono in operator space is not machine space leaking. `report-surface/quoting.tsx`
already establishes the rule and states it: *"operator space translates the
machine's voice everywhere else, and a report cites — so the wire's own
sentence appears verbatim… The mono is the machine's own, on the page's warm
white, in the page's ink — a transcript in daylight rather than a screenshot of
a terminal. No ground, no box, no phosphor."* Follow that exactly: no ground,
no box, no colour.

### Fact 3 — six channels against their reference

Section 5. This is the hardest problem and gets its own treatment.

### Fact 4 — the moment the fault is flagged

**Where:** the flagged channel row, 600 ms after its channel lands.

The row arrives **neutral**, with its trace already visibly outside its
reference — the evidence precedes the judgment, which is correct. 600 ms later
the `flag` event arrives and three things change, all in one 180 ms
`transition-[color,opacity]`:

1. The joint name gains a `SectionLabel tone="alert"` reading `SUBJECT`
   beneath it. This is the incident report's own move (`channel-table.tsx`
   renders exactly this label on the flagged row) and it is why the live
   surface and the filed document read as one object.
2. The two readings ink from `--ink` to `--alert-ink`.
3. The row gains `shadow-[inset_0_0_0_1px_var(--line-strong)]` — the joint
   grid's `data-[emphasis=on]` treatment, verbatim. An inset hairline one step
   up from the table's own rules; it adds no pixel to a row that shares edges
   with five others.

And the stage line changes to `Anomaly flagged — left knee`, which pushes the
`sr-only` announce.

**No sweep, no flash, no bloom.** `FlagBeat`'s travelling rule is the one glow
in the product and it belongs to the dark. The 600 ms gap plus three
simultaneous quiet changes is the beat. Under `prefers-reduced-motion` the
three changes are instant (the global clamp handles it) and the beat is still
there, because the beat was always timing rather than motion.

### Fact 5 — the verdict and its evidence

**Where:** the `FINDING` region, revealed at t+15 s.

Four blocks, in this order:

1. **The finding, translated.** `text-title` `--ink`: `Left knee actuator
   A-07` — from `verdictLine()`'s existing component de-underscoring and
   `A07 → A-07` regex, split so the anomaly gets its own line.
   `text-heading` `--alert-ink`: `Gain anomaly`. On a clean scan:
   `No anomaly detected` in `--nominal-ink`, and no action rail at all.
   On a cleared calibration the whole pair goes `--nominal-ink` and the anomaly
   line reads `Gain anomaly · cleared`.
2. **The measured sentence, derived not written.** `confirmedSignal(report,
   channels)` already exists in `incident-report-surface/channel-table.tsx` and
   produces `Gain 1.62× envelope, five joints within tolerance.` for a gain
   fault and `Trace displaced 0.211 from datum, envelope intact, five joints
   within tolerance.` for an offset. **Import it; do not restate it.** It is
   derived from the channels so it cannot drift from the table above it, and it
   names its own measure — an offset stated as an amplitude ratio would be a
   true number in the wrong units.
3. **The machine's own sentence, quoted.** `ReportQuote` shape:
   `border-l-2 border-line pl-4`, `font-mono leading-[1.55]` `--ink`, with a
   `SectionLabel` caption reading `Recorded by the diagnostic scan`. Content is
   `report.summary` verbatim, unedited — `LEFT KNEE ACTUATOR A-07: GAIN
   ANOMALY. LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE.` A quotation an operator
   might argue with in a dispute is reproduced whole or not at all.
4. **The differential.** `DIFFERENTIAL[report.anomaly]` from
   `incident-report-surface/differential.ts`. Two `text-small` `--ink-soft`
   lines: `Consistent with control-gain drift, tendon wear, actuator
   degradation.` / `Try unloaded recalibration before module replacement.`
   An anomaly with no entry renders nothing rather than the wrong entry.

**Evidence.** The channel table is directly above, still on screen, with the
subject row marked and the control row (`knee_R`) three rows away. **That is
the evidence, and it is already drawn.** Do not add a second subject/control
figure pair; the dark card needs one because its deck is in a different column
from its verdict, and inline it would be the same picture twice.

The one addition worth making: the finding block's headline is a
`<button variant="ghost">` that calls `part-selection.ts` with the flagged
part, so pressing the finding lights the joint grid and the chassis (§2.3).

### Fact 6 — four actions of different weight

Section 6.

### Fact 7 — the destructive confirmation

**Carry `ExecuteConfirm` over intact**, in operator dress. It is already inline
rather than floating, already correct, and the behaviour is not up for
redesign:

- `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby` the title,
  `aria-describedby` the impact list.
- Opens with the **non-destructive** control focused, `preventScroll: true`,
  explicitly so a doubled Return keystroke cannot confirm.
- Two-element Tab trap over `button:not([disabled])`.
- Escape → `preventDefault()` + `stopPropagation()` → abort. The propagation
  stop still matters: the joint grid binds a window-level Escape while a strip
  is expanded.
- The trigger stays mounted and `disabled` while confirming, so nothing moves.
- On every exit, focus returns to the trigger if enabled, else to a
  `tabIndex={-1}` region wrapper. Focus that has legitimately moved elsewhere
  is not stolen back; only `<body>` counts as a failure.
- A gate closing underneath an open confirmation closes the confirmation.

**Operator dress.** `rounded-lg border border-line-strong bg-surface p-4`
(machine space's `border … bg-surface p-3` with the operator radius). Still
**no entrance animation** — a safety gate that fades in has a window in which
it is visible and not yet real.

Title: `Confirm safe sit · Unit N-07`, `text-heading` `--ink`, sentence case.

Impact list, `text-small`, 4 px square bullets `aria-hidden` in `--line-strong`:

*Safe sit*
- Torque drops to a residual hold. `--ink-soft`
- The unit stays monitored. `--ink-soft`
- Service is still required. **`--warn-ink`** ← the only colour in the box

*Recalibrate*
- The joint is driven through its range, unloaded. `--ink-soft`
- The unit holds its seated posture throughout. `--ink-soft`
- Calibration corrects gain, not wear. **`--warn-ink`**
  (offset: `Calibration corrects the datum, not the mounting.`;
  unknown: `Calibration rewrites a table, not a mechanism.`)

Controls, in DOM order: `Command safe sit` then `Cancel`, both
`ConsoleButton size="md" variant="secondary"` — **identical weight, no primary,
no colour**, which is the existing design and is right: a confirmation that
makes one option prettier is a confirmation with an opinion. Hint beside them:
`Esc · cancel`, `text-label` `--ink-soft`, hidden below `md`.

> **Copy decision, flagged for the owner.** The machine word is `ABORT`. In
> operator space the word is `Cancel`, because CLAUDE.md's copy rule is
> explicit — "operator space in plain verbs and sentence case". The
> *behaviour* the brief requires (destructive confirm; the non-destructive
> control takes initial focus) is preserved exactly. It is one string if the
> owner wants `Abort` back.

**Disable joint gets no confirmation.** It records to the incident and sends
nothing; it is already gated on seated posture. Adding a confirm would give a
record-only action executed weight, which is the exact dishonesty the two
groups exist to prevent.

### Fact 8 — wire-driven maneuver narration

**Where:** in the acting row, replacing its control.

One line and one rule. Not a log, not a stepper — the dark version already got
this right.

- **Line:** `commandLine(state)` from `safe-sit-copy.ts`, kept **verbatim and
  in mono**, `font-mono text-small tnum` `--ink`: `SAFE SIT · ACCEPTED` →
  `SAFE SIT · 45% · CROUCH PHASE` → `SAFE SIT COMPLETE`. Refusals go
  `--alert-ink`: `REFUSED · REQUIRES SEATED POSTURE`.

  This is a quotation (the same rule as §4.2 and the report's `ReportQuote`),
  and it matters that it is: the four phase strings are the robot's words about
  its own body, and paraphrasing `TORQUE RAMP-DOWN` into "reducing torque"
  would put the console's voice on the machine's report.
- **Rule:** `ProgressRule` at `commandFill(state)` — `failed → 0`,
  `complete → 100`, else `state.pct`. `role="progressbar"` with min/max/now and
  `aria-labelledby` the line. `transition-[width]` over `--dur-micro`.
  Never interpolate toward a value the unit has not sent.
- **Phase ticks.** Four 1 px ticks under the rule at 20 / 45 / 70 / 90 %, in
  `--line-strong`, inking to `--ink` as each note arrives. This is the status
  timeline's own vocabulary (band + ticks: "the band carries state and the
  ticks carry moments") and it preserves "four phases happened" without a
  four-line log for a four-second maneuver. **First thing on the cut list.**
- **Terminal.** On `complete` or `failed`, a `ConsoleButton variant="ghost"
  size="sm"` reading `Dismiss`, `aria-describedby` the status line; it clears
  the store slot and the trigger returns in its place.
- **Second copy.** `CommandStatusLine` must still be mounted somewhere with
  `aria-live="polite"` and empty when idle. Inline there is no minimize to
  survive, so it lives in the panel's footer rule. A live region born with text
  in it is ignorable — mount it empty.

Timings and strings, unchanged, from `sim/engine/`:

| | 20 % | 45 % | 70 % | 90 % | complete |
| --- | --- | --- | --- | --- | --- |
| safe sit | `GAIT ARRESTED` 0.5 s | `CROUCH PHASE` 1.0 s | `TORQUE RAMP-DOWN` 1.5 s | `POSTURE SETTLED` 2.0 s | 4.0 s |
| recalibrate | `JOINT UNLOADED` 0.5 s (15 %) | `RANGE SWEEP 1/2` 1.125 s (40 %) | `RANGE SWEEP 2/2` 1.75 s (65 %) | `GAIN TABLE WRITTEN` 2.5 s (85 %) | 4.5 s |

`POSTURE SETTLED` is the beat that flips posture and lifts the gates on
recalibrate and disable — **in place, without a remount**, so the two disabled
rows come alive under the operator's eye while the sit is still narrating.
That is the best moment in the flow and it is free.

**Post-recalibration outcomes.** The re-measured channel arrives as a
`recalibration` diag event and redraws the subject row's trace in place: the
pre-calibration wave becomes a ghost (`--alert` at `strokeOpacity 0.3`) and the
re-measure draws over it at full weight. The readings become
`RMS Δ 0.183 → 0.121` and `1.62× → 1.32× reference`, and the caption gains
`Before · After`. This is `evidence-trace.tsx`'s own before/after handling and
`report-surface`'s `ReportTrace`; both already do it.

- N-07 (gain) → `partial`. Finding line becomes `Gain anomaly · partial`,
  anomaly in `--alert-ink` and `· partial` in `--warn-ink`. Amendment line,
  `--warn-ink`: `Residual 1.32× reference — mechanical wear indicated.`
  Residual differential: `Gain drift excluded. Remaining: tendon wear,
  actuator degradation.` `Disable joint` and `Dispatch service` stay live.
- N-01 (offset) → `cleared`. Finding pair flips to `--nominal-ink`, anomaly
  line reads `Offset anomaly · cleared`, amendment in `--ink` (no colour):
  `Channel restored — residual 0.013 from datum.` Both recorded actions go
  inert with `Channel restored — escalation is no longer indicated.`

### Fact 9 — incident logged and retrievable

The panel's footer rule, after the actions:
`Incident INC-N07-4F2A logged.` `text-small` `--ink-soft`, with the reference
as a `ConsoleButton variant="ghost" size="sm"` calling
`openIncidentReport(id)` — the existing module signal, already wired to
`IncidentReport`. On leaving the panel (`completeAscent()`), the panel
collapses and `IncidentHistory` picks the record up. **All existing.**

---

## 5. The six-channel comparison

### 5.1 The answer

**A single column of six rows** — joint name, one trace box holding reference
and live together, `RMS Δ`, `Gain` — laid out as a table with hairline rules
between rows and no vertical rules at all.

### 5.2 Why a column and not a 3×2 grid of small multiples

1. **The comparison that decides the case is between channels, not within
   one.** A column puts all six RMS values in a single vertical line of
   `tnum` digits: `0.004 / 0.006 / 0.183 / 0.005 / 0.007 / 0.005`. The outlier
   is found by digit count before any colour is read. A 3×2 grid scatters those
   six numbers across two rows and three columns and destroys the scan.
   `report-surface/quoting.tsx` already makes this argument for the report's
   own table and calls the shape a *comparison*: "two or three columns of very
   short values whose whole job is to be read across."
2. **A shared baseline makes amplitude comparable for free.** Six traces
   left-aligned at identical scale, stacked, means the knee's 1.6× envelope is
   visibly *taller than its neighbours* — a pre-attentive size judgement that
   needs no colour and no drawn boundary. In a grid the neighbours are beside
   it at a different x-offset and the comparison becomes work.
3. **It fills downward, one row every 1.3 s.** A list completing itself is the
   calmest available expression of "the scan is progressing", and it is the
   same fact the progress rule states numerically.
4. **It is the incident report, live.** `incident-report-surface/channel-table.tsx`
   already renders `Joint | RMS Δ | Gain vs reference` with a `Subject` label on
   the flagged row. The panel is that table with a trace column added. *The
   report an operator files is the screen they watched.* That is worth more
   than any layout cleverness, and it deletes a whole class of drift.
5. It survives 768 px without reflowing into a different diagram.

### 5.3 How the divergent one earns attention without neon

Four signals, in increasing loudness, only the last of which is colour:

1. **Coincidence, or its absence.** Five live traces sit on top of their
   reference and you cannot see two lines. The knee's does not. "Tracks its
   reference" is best said by a picture in which the comparison has vanished.
2. **Height.** The knee's trace is 1.4–1.8× the amplitude of the five above and
   below it, at a shared baseline. At a 56 px box the reference peak is ~14 px
   and the faulty peak ~26 px — a near-2× difference, read without instruction.
3. **The digit column.** `0.183` against five `0.00x`. `tnum` guarantees the
   columns line up.
4. **One colour, spent once.** The live trace is tone-graded per sample by
   `writeSampleTones`, and the two readings go `--alert-ink`. Nothing else on
   the panel is clay. This is the report's own rule, quoted from
   `channel-table.tsx`: *"Clay is spent once on this page, on the readings,
   because the reading is what is out of envelope; a red tag beside a joint's
   name says 'this row errored', which is a different and untrue claim."*

Plus, at the flag and not before, the `SUBJECT` label and the inset hairline
(§4.4).

### 5.4 Rejected alternative, and why

**A drawn tolerance corridor** (`ref ± RMS_HEALTHY` filled in `--line`, so a
healthy trace sits inside a visible band and the knee escapes it) is the
strongest non-colour signal available and I considered it seriously. Rejected
for two reasons. First, it puts a third object in a 56 px box that already has
two lines, and in a column of six that is eighteen objects where twelve will
do. Second, it is a category error dressed as a fact: `RMS_HEALTHY = 0.05` is
an RMS threshold over 120 samples, not a pointwise envelope, and a band drawn
at ±0.05 would be an invented boundary a channel can legally cross. This
console does not draw lines the machine did not measure.

*(It would have worked numerically — healthy channels deviate by at most
≈ 0.042 pointwise, the knee by 0.22–0.44 — which is exactly why it is
tempting and exactly why the reason to reject it has to be the honest one.)*

**A residual plot** (`wave − ref` against zero) renders the comparison for the
reader and would separate the two fault kinds beautifully — a gain fault's
residual oscillates and grows, an offset's is flat DC. Rejected because it
throws away *shape*, and shape is what a technician reads: "right shape, wrong
amplitude" versus "right shape, wrong datum" is the difference between the
knee's story and the ankle's. It is also a derived quantity a non-engineer
cannot map back to a robot's leg, and this demo's first reader is not an
engineer.

### 5.5 Drawing: canvas, one per row, one frame subscription

Follow `components/machine/waveform-deck.tsx`'s proven architecture exactly.

- One `<canvas aria-hidden className="absolute inset-0 block size-full">` per
  row, inside a `relative overflow-hidden` box with an explicit height
  (`h-14` = 56 px desktop, `h-12` = 48 px tablet). The `inset-0`-against-a-
  definite-box pattern is load-bearing: it defeats the canvas 300×150 intrinsic
  ratio.
- **Exactly one `registerFrame` subscription for the whole deck**, created in a
  mount-only effect beside the `ResizeObserver`. Per frame it compares each
  row's `drawnVersion` against its channel's arrival token and returns if
  unchanged. **A settled deck is six integer comparisons and no canvas work.**
- `ResizeObserver` per canvas: `canvas.width = round(cssW * dpr)`,
  `ctx.setTransform(dpr,0,0,dpr,0,0)`, force redraw with `drawnVersion = -1`.
- Palette sampled once at mount/resize with `readToken(getComputedStyle(el), …,
  "operator")` from `lib/tokens/fallback.ts`. **Never in a frame callback.**
- Tone buffer: `writeSampleTones(wave, ref, out)` once per channel on arrival,
  into a caller-owned `Uint8Array(120)`. Six buffers of 120 bytes for the life
  of the panel. Zero per-frame allocation.

**Per-cell draw order** (mirrors `strip-draw.ts`'s "strict order of who may be
loudest"):

1. Datum hairline across the full width at mid-height, `--line`, 1 px,
   `snap`ped to whole device rows.
2. Reference polyline: `--ink-soft`, `globalAlpha 0.45`, `lineWidth 1`.
   (0.45 is the report's value; keep parity so the two pictures match.)
3. Live polyline, `lineWidth 1.5`, `globalAlpha 1`, stroked in **up to three
   passes, one `beginPath`/`stroke` per tone run**, so one trace changes colour
   along its length. Tones map through `strip-tone.ts`'s existing
   `StripTone` union:

   | `writeSampleTones` | operator token | why |
   | --- | --- | --- |
   | `0` nominal | `--ink` | a healthy trace is *ink*, not sage — six sage lines saying "fine" out-shout the one that is not (`StatusChip` `tone="bare"`, same argument) |
   | `1` warn | `--warn` | |
   | `2` alert | `--alert` | |

   1.5 px, not the report's 1.25: `--warn` is 3.1:1 on `--bg` and a thin amber
   hairline has too little mass to carry the 3:1 non-text bar comfortably.
4. Post-recalibration only: the pre-calibration wave first, `--alert` at
   `globalAlpha 0.3`, then the re-measure on top at full weight.

`PAD_Y = 3`, y domain −1…1 (the wire's normalisation), so a 1.8× excursion
stays inside the box without clipping.

**No sweep.** The channel arrives as a complete 120-sample array; drawing it
left-to-right over 1400 ms is the console animating data it already has. The
row fades in over `--dur-enter` with a 4 px rise (`.alert-enter`, existing) and
is then **permanently static**. That is the whole reason six extra canvases are
affordable on a page with eighteen live ones.

**No cursor rule.** The dark deck's full-height `--alert` rule at the sweep
head is the sweep's furniture; with no sweep there is nothing to mark.

### 5.6 The alternative I rejected, stated for the record

SVG `<polyline>` stills would print, would scale, would need no DPR handling
and no rAF at all, and would let the panel and the report share one component
outright. `evidence-trace.tsx` and `report-surface/ReportTrace` already do
exactly this. **I still recommend canvas here**, because: the panel does not
print (the report does, and keeps its SVG); tone-graded traces mean 5–7
sub-polylines per channel, so ~35 nodes carrying ~8 KB of point strings through
layout; and CLAUDE.md's "zero chart DOM nodes" is part of the engineering claim
this portfolio is making, and the new *default* surface is the wrong place to
spend it.

Share the *geometry* instead: lift `tracePoints`'s sample→coordinate mapping
into a pure helper both the canvas and the report's SVG call, so the two
pictures cannot disagree.

---

## 6. The action rail

### 6.1 The problem

Four pills in a row read as four peers. They are not: two reach the robot, two
do not; one is destructive; two are gated, and one of those two is gated *by
the other one*.

### 6.2 The structure

**Not four buttons — two labelled groups of rows, and inside the first group,
a numbered sequence.** Keep the existing split from `verdict-actions.tsx`; it
is right. Make the sequence visible, which the existing design does not.

```
OVER THE LINK                                       REMOTE OPERATIONS
  1  Command safe sit      description        [control]
  2  Recalibrate joint     description + gate [control]
  ─────────────────────────────────────────────────────────────────
  Executes on the unit · confirmation required

RECORDED TO THE INCIDENT
     Disable joint         description + gate [control]  FIELD SERVICE
     Dispatch service      description        [control]  FIELD SERVICE
  ─────────────────────────────────────────────────────────────────
  Records to the incident on return · no command is sent
```

**The numbering is the whole idea.** Recalibrate's gate is not an arbitrary
disabled state; it is step 2 of a two-step procedure whose step 1 is directly
above it. Numbering turns an invisible precondition into a visible sequence,
and it is why `Command safe sit` reads as *enabling* rather than as *another
option*. Group 2 is not numbered, because its two rows are genuinely
alternatives.

Group order is fixed by group, never by the report's array; the report's own
order survives within a group. That is `executedKind()`'s existing rule and
`recoveryTier`'s reason for matching on words rather than position.

### 6.3 Row anatomy

`ActionItem` (new console primitive, §8):

```
┌──────────────────────────────────────────────────────────────────────┐
│  1   Command safe sit                            [ Command safe sit ]│  ← text-body --ink
│      Brings the unit to a seated hold. Torque drops to a residual;   │  ← text-small --ink-soft
│      the fault stays. Required before either step below.             │
│      Requires a seated posture.                                      │  ← text-small --warn-ink (gate)
└──────────────────────────────────────────────────────────────────────┘
```

- Ordinal: `text-label` `tnum` `--muted`, `w-5`, top-aligned to the first line.
- Label: `text-body` `--ink`. Grey to `--ink-soft` when the row is blocked.
- Description: `text-small` `--ink-soft`, `max-w-[56ch]`.
- Gate reason: its own line, `text-small` `--warn-ink`, present only when
  blocked, and **also appended to the button's visible label** so eye and
  screen reader get the same fact (§1.6). `aria-describedby` points the control
  at the reason's id.
- Tier tag: `SectionLabel` in the group's right rail (`REMOTE OPERATIONS`,
  `FIELD SERVICE`), from `recoveryTier(action)`. It is the honest answer to
  "how expensive did this get" and it already exists.
- Rows separated by `divide-y divide-line`, `py-4`, no borders on the group box
  itself at desktop; at tablet the group gets `rounded-lg border border-line
  p-4` so the stacked controls stay visibly grouped.

### 6.4 Weight, expressed four ways

| action | variant | why |
| --- | --- | --- |
| the one available cheapest step | `primary` (the black pill) | one per screen, always |
| the other executed step | `secondary` | |
| `Disable joint` | `danger` (`bg-alert-tint text-alert-ink`, `hover:bg-alert hover:text-bg`) | quiet at rest, loud under the finger |
| `Dispatch service` | `secondary` | |

**The black pill is a baton.** It belongs to `Run diagnostic` in the banner
until the verdict lands; the banner then stops offering it, and it passes to
the single cheapest *available* step in the ladder — `Command safe sit` before
seating, `Recalibrate joint` after `POSTURE SETTLED`. There is never more than
one on the page. A disabled row never holds it.

Size `md` throughout; `lg` is the banner's and stays the banner's.

### 6.5 Gating, exhaustive

Read posture as `useFleetStore(s => s.units[unitId]?.posture) === "sitting"` so
an unknown unit gates **closed**.

| action | disabled when | label suffix | reason line | re-enables |
| --- | --- | --- | --- | --- |
| Command safe sit | posture **is** `sitting` | `· already sitting` | `The unit is already in a seated hold.` | never in a session |
| Recalibrate joint | posture ≠ `sitting` | `· requires a seated posture` | `An unloaded sweep is permitted only while the unit is seated.` | `POSTURE SETTLED`, in place |
| Disable joint | posture ≠ `sitting` | `· requires a seated posture` | `The knee is load-bearing; disabling it is permitted only while the unit is seated.` | `POSTURE SETTLED`, in place |
| either recorded action | a calibration `cleared` | `· not indicated` | `The channel is restored; escalation is no longer indicated.` | never |
| either recorded action | already pressed | `· recorded 14:32:07` | — | never |

Precedence: `done` outranks everything; `restored` outranks the posture gate
and **replaces** its reason rather than stacking. All five strings live in
`diagnostic-copy.ts`, one place, tested.

**After confirm, before the wire answers:** the trigger goes
`Command safe sit · sent`, disabled, with `Awaiting the unit` beside it,
`text-label` `--ink-soft`. **No bar, no percentage, no spinner** in that window
— the machine has not said anything yet, so neither does the console. On
`failed` with no link: `Not sent — no link to the unit.` `--alert-ink`, the
trigger stays live, and **the incident acknowledgement is not written** (send
first, record second).

### 6.6 While a confirmation is open

The other rows go `opacity-45` (the joint grid's `data-[emphasis=off]` value)
and `inert`. That gives a modal's containment without a modal's layer, and it
is the answer to the obvious objection that an inline confirmation is weaker
than a dialog: nothing else on the panel is reachable, and the evidence the
decision rests on is still on screen above it.

---

## 7. Motion

Total budget: **one new motion primitive.** Everything else already exists.

| moment | property | duration | easing | reduced motion |
| --- | --- | --- | --- | --- |
| panel arrives | height, via `BannerReveal`'s critically damped spring | `response 0.22 s` (166 ms to 95 %) | spring | instant, no travel (`BannerReveal` already branches) |
| channel row lands | opacity 0→1, `translateY(-4px)→0` (`.alert-enter`, existing) | `--dur-enter` 180 ms | `--ease-console` | `animation-fill: both` under the clamp → appears, does not flicker |
| progress rule fills | `width` | `--dur-enter` 180 ms | `--ease-console` | clamp → snaps to each counted value |
| structure mark checks | `color`, `opacity` | `--dur-micro` 140 ms | `--ease-console` | instant |
| flag lands | `color` on two readings, `box-shadow` on the row, `opacity` on the `SUBJECT` label | `--dur-enter` 180 ms | `--ease-console` | instant — **the beat is the 600 ms wire gap, not the fade, so it survives intact** |
| verdict region opens | `grid-template-rows 0fr→1fr` + `opacity` (`Disclosure`, existing) | `--dur-enter` 180 ms | `--ease-console` | clamp → instant open |
| walk-log disclosure | same | `--dur-enter` | `--ease-console` | instant |
| confirmation opens | **none, deliberately** | 0 | — | — |
| rows dim behind a confirmation | `opacity` | `--dur-enter` 180 ms | `--ease-console` | instant |
| maneuver rule fills | `width` | `--dur-micro` 140 ms | `--ease-console` | clamp |
| button press | `transform: scale(0.97)` (existing, `motion.css`) | `--dur-press` 100 ms | `--ease-console` | clamp |
| trace redraw after recalibration | crossfade of two canvas passes over 1 frame | — | — | identical |

**Explicitly absent:** wipe, page dim, boot stagger, per-channel reveal sweep,
travelling flag rule, glow of any kind, drag gestures, and any transition on
the panel's own scroll position.

The `.diag-sweep` indeterminate hairline on the banner (existing, hidden under
reduced motion) stays while the scan runs — it is the banner's, not the
panel's, and it stops when the panel gets a determinate rule of its own.
Consider removing it once the panel ships; two progress indicators for one scan
is one too many. *(Judgement call — leaving it is defensible because the banner
may be the only part on screen when the operator has scrolled.)*

### 7.1 Frame budget

The panel adds **one** `registerFrame` subscriber (the deck) to a page that has
eighteen. During the scan, that subscriber does six integer comparisons per
frame and draws exactly six times in fifteen seconds — once per channel
arrival, each draw being ~360 `lineTo` calls across a 428×56 box. The panel's
DOM animations are CSS `width` / `opacity` / `color` transitions on
composited-or-cheap properties, and the reveal spring is the same one the
banner already runs. There is no per-frame React state anywhere in the panel.

---

## 8. Components

### 8.1 New primitives in `@/components/console`

Both are pure, take no `space` prop, import no store, and **need a specimen in
`app/system/specimens.tsx`** — `catalogue.test.tsx` fails the build otherwise.

**`progress-rule.tsx` (~80 lines)**

```ts
export interface ProgressRuleProps extends React.ComponentPropsWithoutRef<"div"> {
  /** 0…1. Clamped. */
  value: number;
  /** Accessible value pair; omit to fall back to percent. */
  now?: number;
  max?: number;
  /** Id of the element naming this rule. */
  labelledBy: string;
  /** Discrete beats drawn under the rule, as fractions. */
  ticks?: readonly number[];
  tone?: "ink" | "warn" | "alert";
  /** Hold the fill where it is: the source stopped reporting. */
  stalled?: boolean;
}
```

2 px tall, `bg-line` track, `bg-ink` fill (`bg-warn` / `bg-alert` by tone),
`rounded-pill` (flattens to 0 in machine space for free), `role="progressbar"`,
`transition-[width] duration-[var(--dur-enter)] ease-console`. Three callers
today (scan progress, maneuver narration, and the cohort card's rollback,
which currently rolls its own).

**`action-item.tsx` (~150 lines)**

```ts
export interface ActionItemProps {
  ordinal?: number;
  label: string;
  description: React.ReactNode;
  /** Printed in --warn-ink and wired to the control by aria-describedby. */
  blockedReason?: React.ReactNode;
  tier?: string;
  state: "available" | "blocked" | "sent" | "running" | "done" | "failed";
  /** The button. Caller owns variant and handler. */
  control: React.ReactNode;
  /** Narration + rule, rendered in place of the control. */
  readout?: React.ReactNode;
  /** The confirmation, rendered under the row when open. */
  confirm?: React.ReactNode;
  /** Set while another row's confirmation is open. */
  muted?: boolean;
}
```

Pure layout and `aria-describedby` plumbing; every decision about *whether* a
row is blocked stays in `components/fleet`. The cohort card's halt/rollback
pair has the same shape and should adopt it.

**Optional third — `reveal.tsx` (~90 lines).** Extract `BannerReveal` from
`incident-banner.tsx` so the panel can grow with the same spring. Worth doing,
but it edits a file another engineer may be in; the fallback is `Disclosure`,
already exported, which is CSS-only and interruptible for free. **Ship with
`Disclosure`; extract later.**

### 8.2 New region in `components/fleet/diagnostic/`

A folder, following `telemetry-strip/` and `incident-report-surface/`.

**Two modules this region depends on already exist — do not write them again:**
`lib/diagnostics/scan-progress.ts` (`scanProgress`, `ScanStage`,
`EXPECTED_WALKS`, `EXPECTED_CHANNELS`, with its pinning test against the
simulator's arrays) and `lib/prefs/diagnostic-view.ts` (`useDiagnosticView`,
`setDiagnosticView`, `DEFAULT_DIAGNOSTIC_VIEW`). Both are tested. The line
budgets below assume them.

| file | responsibility | lines |
| --- | --- | --- |
| `index.ts` | barrel; re-exported from `components/fleet/index.ts` | ~40 |
| `panel.tsx` | store-wired root. Reads phase, session, link, posture. Decides which regions exist. Owns the reveal and the `Machine view` toggle. No drawing. | ~190 |
| `progress-head.tsx` | stage line, counted `ProgressRule`, `sr-only` announce with the coarse-beat trigger list | ~150 |
| `structure-list.tsx` | the nine parts, their clear-conditions against `manifest-spec.ts`, `Gain tables n/6`, the walk-log `Disclosure` | ~130 |
| `channel-table.tsx` | the six rows, DOM half: names, `SUBJECT` label, readings, caption. Renders all six from mount. | ~170 |
| `channel-deck.tsx` | canvas hosts, the one `registerFrame`, `ResizeObserver`s, palette sampling | ~120 |
| `channel-draw.ts` | one cell's draw + the operator palette + tone-run splitting | ~140 |
| `finding.tsx` | headline, measured sentence, quoted summary, differential, amendment, cross-highlight button | ~160 |
| `action-ladder.tsx` | the two groups, gating derivation, baton logic for the primary pill | ~200 |
| `action-row.tsx` | one row's state machine: control ↔ confirmation ↔ narration ↔ terminal | ~210 |
| `confirm.tsx` | the operator-dress `ExecuteConfirm`: role, trap, focus, Escape, impact list | ~180 |
| `diagnostic-copy.ts` | every string in the panel, in one place: stage lines, descriptions, gate reasons, impact lists, outcome lines | ~180 |

Total ≈ 1870 lines across 12 files, every one comfortably under 500. Tests
alongside, matching the folder's conventions.

### 8.3 Bundle

**The panel must be a `next/dynamic` boundary.** The unit route is at
**192.2 KB gz against a 200 KB budget** (README, gated by
`scripts/check-budgets.mjs`); ~1900 lines of new region in its initial JS would
fail CI.

Mirror `descent-overlay.tsx` exactly:

```ts
const importPanel = () => import("./diagnostic/panel");
const DiagnosticPanel = dynamic(() => importPanel().then(m => m.DiagnosticPanel), { ssr: false });
export function preloadDiagnostic(): void { warmed ??= importPanel(); }
```

`IncidentBanner` already calls `preloadMachineSpace()` on mount for exactly this
reason ("the descent is the one moment in this product that must not wait on a
network round trip"). Add `preloadDiagnostic()` beside it, and — since machine
space is now opt-in and off by default — **move `preloadMachineSpace()` to the
`Machine view` button's `onPointerEnter`/`onFocus`**, which takes 56.1 KB gz of
eager fetch off every troubled unit page.

Reuse rather than re-implement: `scanProgress`, `confirmedSignal`,
`DIFFERENTIAL`, `calibrationOutcomeLine`, `rmsDelta`, `gainRatio`,
`channelTone`, `writeSampleTones`, `residualReading`, `recoveryTier`,
`verdictLine`, `commandLine`, `commandFill`, `COMMAND_LABELS`.

**`lib/diagnostics/` already exists** — `scan-progress.ts` landed there for
precisely this reason, and its header states the rule: *"Importing `sim/engine`
to count an array would pull the engine into the unit page's initial bundle to
learn the number 20."* The same argument applies one layer over. The pure maths
and copy modules that both surfaces need — `waveform-math.ts`,
`recalibrate-copy.ts`, `safe-sit-copy.ts` — currently live under
`components/machine/`, and importing them from the panel drags the machine
chunk into the panel's chunk, undoing the split the toggle exists to create.
**Move them to `lib/diagnostics/` and have both surfaces import from there.**
Nothing in any of the three touches React, canvas or a store, so the move is
mechanical.

Verify with `node scripts/check-budgets.mjs` before calling it done, and check
that the machine chunk is still absent from the unit route's initial payload —
not merely that the total is under 200 KB.

---

## 9. What I would cut, in order

1. **The phase ticks under the maneuver rule** (§4.8). Four ticks for a
   four-second bar. The line already names the phase.
2. **The walk-log disclosure** (§4.2). The grouped structure list carries the
   fact that twenty nodes were walked; the raw paths are for the curious. ~60
   lines.
3. **`ProgressRule`'s `ticks` and `stalled` props** — inline the two behaviours
   at their call sites and ship the primitive with `value` and `labelledBy`.
4. **The per-sample tone gradient.** Fall back to one tone per channel from
   `channelTone(rmsDelta(wave, ref))`. Loses "the failure developing" (§1.1);
   keeps the finding. Painful but survivable.
5. **The differential** (§4.5 block 4). It is the filed report's job and the
   report already does it.
6. **The structure list's nine named rows**, folded into one line: `Structure
   and firmware · 9 of 9 checked`. Loses which parts were checked. This is where
   the "same capabilities" promise starts genuinely bending.
7. **Tablet column tuning.** Let the rows wrap and accept it.

**Never cut:** the six-row channel column with both traces; the two readings;
the 600 ms flag gap; the visible gate reasons; the confirmation and its focus
discipline; the verbatim wire narration; the `sr-only` announce; the link-lost
state.

---

## 10. Risks to the "same capabilities" promise

**1. The wireframe elevation and its magenta leader line have no home.**
`status-board.tsx` draws the chassis beside the manifest and runs a
`--signal`-coloured elbow from the model to the damaged row. That is a real
capability — *where on the robot* — and there is no room for it in a panel that
is 470 px tall. **Mitigation:** the unit page already carries `ComponentView`
further down the column, which highlights the knee actuator on the chassis
after an incident, and §2.3's cross-highlight lights it from the finding. The
capability survives on the page; it does not survive *in the panel*. **This is
the largest genuine loss and the owner should agree to it explicitly.**

**2. Merging the manifest's six actuator rows into the channel rows changes
the count on screen, and the panel now counts a different thing entirely.** The
dark board says `07/15 CLEARED` — fifteen *parts*. The calm panel's bar counts
twenty-six *wire events* (`scanProgress`) and its label counts whichever of the
two lists is filling. Both are honest, neither is the other, and the parts
manifest's `n/15` no longer appears anywhere in the calm surface. If anyone is
attached to *fifteen rows in two groups* as the picture, or to `07/15 CLEARED`
as the phrase, this is a change of picture rather than of style. The
`GAIN_TABLES 6/6` sub-count is the one manifest detail carried over verbatim
(§4.2), because it is the only row whose progress is itself information.

**3. Mono in operator space, three times** (the walk log, the quoted summary,
the narration line). `ReportQuote` establishes the rule and it is sound, but
three mono blocks in one card is more machine voice than any single operator
surface has carried. Watch it in situ; if it reads as leakage, the narration
line is the one to translate first, and the quoted summary is the one that must
stay.

**4. The link-lost / `HOLD` state is easy to skip** and it is the state that
proves the surface is driven by a wire rather than by a timer. `scan-header.tsx`
carries `HOLD · LINK LOST · SESSION RETAINED`, `HOLD · LINK RESTORED · AWAITING
SEQUENCE`, and a conditional escape hatch. All three need calm equivalents
(§4.1) and none of them appears on the golden path, so none of them will be
noticed missing until a reviewer pulls the cable.

**5. The bundle.** §8.3. If the pure maths modules are not moved out of
`components/machine/`, importing `waveform-math.ts` from the panel drags the
machine chunk into the panel's chunk, and the two surfaces the toggle was meant
to separate ship together.

**6. The `SEEK_STORYLINE` / re-run path.** The scan must be re-runnable from
`Run diagnostic again` and from `Reset simulation`, and the panel must rebuild
itself from the store on re-entry, because the session is a store projection
and the panel is not allowed to keep any state the store does not have. The
dark stage got this right (`watching` is orthogonal to `phase`); the panel is
simpler — it has no watching state at all — but the "rebuild from the store,
hold nothing" discipline has to be kept, or a mid-scan navigation away and back
will show a half-drawn panel.

---

## 11. The machine-space toggle

**Already built.** `lib/prefs/diagnostic-view.ts` ships the preference:
`"calm" | "machine"`, default `calm`, held in `localStorage` under
`fleet-console.diagnostic-view`, read through `useSyncExternalStore` with a
`storage` listener so a second tab follows, and validated on read so a junk
value degrades to the default rather than to a third state nothing mounts.
Do not re-implement it. What remains is where the control sits and how the
panel behaves around it.

- **The control.** `ConsoleButton variant="ghost" size="sm"` in the panel
  card's `action` slot, reading `Machine view`. Not an icon, not a switch. It
  calls `setDiagnosticView("machine")`; the reverse control lives in machine
  space's own header, where `Close` already is.
- **It is a preference, not an action.** The toggle does not call
  `watchSession()`. `DescentOverlay`'s gate gains `view === "machine"` as a
  fourth condition alongside phase, session id and `watching`. The distinction
  matters: `watching` answers "is the operator in there right now" and survives
  leaving and re-entering one scan; the preference answers "which way should a
  scan render" and survives a reload.
- **Persistence is right, and my first instinct was wrong.** I initially argued
  the preference should not survive a reload, on the grounds that it would make
  the dark space the default again for anyone who pressed it once. The shipped
  module's reasoning is better and is written on it: *"this is a statement
  about how someone wants the interface to behave… Turning machine space on and
  reloading should not silently turn it back off."* Calm is the *default*, not
  a mode the app keeps re-asserting over an explicit choice.
- **The static-export consequence, which the panel must honour.** The server
  snapshot is always `calm`, because the prerendered HTML is one artifact
  served to everyone. So the panel is always what the first paint contains and
  the effect corrects it afterwards. That is invisible — nothing about the
  preference is on screen until the operator has interacted — **provided the
  panel never renders a loading state for the preference.** Render calm, let
  the correction happen.
- **Preload.** Warm the machine chunk from this button's `onPointerEnter` /
  `onFocus`, and from `readDiagnosticView() === "machine"` on mount. Take it
  off the banner's unconditional mount (§8.3): with machine space opt-in and
  off by default, 56.1 KB gz of eager fetch on every troubled unit page is
  paying for a surface most operators will never open.
- Escape from machine space returns here, to a panel that has been keeping up
  the whole time — because both surfaces are projections of one store, which is
  the architecture's own payoff and worth saying out loud in the README.
