# lib/stores — public API

Four zustand stores, one non-reactive telemetry channel, one wiring function.
Anything not listed here is internal and may change.

```
bindTransport(transport)   wire messages + connection status into the stores (call once)
useFleetStore              units, alerts + lifecycle, connection, KPIs, trend watch verdict
useIncidentStore           diag session state machine + incident history
useCommandStore            per-unit command lifecycles (SAFE SIT, RECALIBRATE) plus the
                           fleet slice (HALT_ROLLOUT / ROLLBACK_COHORT)
useAuditStore              append-only session log — the single source the UI renders
selectCohorts              derived fleet incident: the firmware cohort (cohortStore.ts is a
                           derivation over the fleet store, not a fifth store)
getUnitBuffers(unitId)     non-reactive telemetry ring buffers for canvas
useUnitTelemetryVersion(id) / useUnitBattery(id) / useUnitLastContact(id)
                           per-unit React subscriptions to the telemetry channel
```

## Wiring

`bindTransport(createTransport())` once in the app shell; the returned function
unbinds. Messages are zod-validated and order-checked in the transport. Routing:
`fleet_snapshot` / `telemetry` / `alert` / `unit_update` → fleet store;
`diag_event` → incident store; `command_event` → command store;
`fleet_command_event` → its fleet slice; `alert_clear` → `resolveAlert(...)`.

Outbound commands do not go through the stores. `RUN_DIAGNOSTIC` pairs with
`beginDescent(unitId)`; every other command pairs with **nothing** — the sim
answers synchronously with `accepted`/`failed` and the store carries the
lifecycle. A confirm dialog's `idle`/`confirming` is component state.

## Telemetry channel (`telemetryChannel.ts`)

Everything a 10 Hz batch writes lives here, outside zustand: the ring buffers
(600 samples ≈ 60 s per series), a per-unit **version** (+1 per batch), and
two quantized primitives — **battery** at 0.1 % and **last contact** at 1 s.
A batch for N-03 notifies N-03's subscribers and nobody else; the fleet store
never commits for it. Reads:

| read                             | notes                                                        |
| -------------------------------- | ------------------------------------------------------------ |
| `getUnitBuffers(id)`             | rings; read inside the rAF loop, never snapshot them         |
| `getUnitTelemetryVersion(id)`    | canvas hosts poll this from the frame callback               |
| `getUnitBattery(id)`             | 0.1 %, undefined until the first batch of the run            |
| `getUnitLastContact(id)`         | 1 s, undefined until the first batch of the run              |
| `telemetryBatchCount()`          | admitted batches since reset, any unit — receipts and tests  |
| `subscribeUnitTelemetry(id, fn)` | `fn` runs once per batch for `id`, once per restatement      |
| `useUnitTelemetryVersion(id)`    | `useSyncExternalStore`; re-renders per batch — canvas only   |
| `useUnitBattery(id)`             | live 0.1 % ?? snapshot battery ?? 0 (exported by fleetStore) |
| `useUnitLastContact(id)`         | re-renders at most once a second per unit                    |

**Invariants:** a pure-telemetry batch is **zero zustand commits and one
per-unit notification**; the store commits only when a _reactive_ fact moves —
status, alerts, a snapshot, the rounded fleet-average battery, the trending
set. Samples never enter reactive state; never hold `toArray()` across frames.
**Version counters drive canvas, never text**: text binds to the quantized
primitives or the shared 1 s ticker, and the store keeps no duration field.
A `fleet_snapshot` keeps the rings and the version counters (the canvases must
not think nothing changed), clears the primitives, and marks the seam
(`telemetryEpochTs`); `reset()` empties everything.

## Fleet store

| field                                        | notes                                                          |
| -------------------------------------------- | -------------------------------------------------------------- |
| `connection`                                 | `idle/connecting/open/reconnecting/closed`                     |
| `units`, `unitIds`                           | entry identity changes only for the changed unit; rail order   |
| `alerts`, `alertMeta`                        | newest first, capped at 100; ack/resolution per alert id       |
| `telemetryEpochTs`                           | per-unit seam between runs; replaced (not mutated) on snapshot |
| `trending`                                   | the trend watch's verdict, rail order; identity-stable         |
| `kpiNominal` / `kpiAlerts` / `kpiAvgBattery` | header KPIs; `kpiAlerts` counts units with an unresolved alert |

`UnitSummary` carries optional `posture`, `fw` and `fwPending` (render
`undefined` as walking / unknown); `applyUnitUpdate` is idempotent by content.
Selectors: `selectConnection`, `selectUnitIds`, `selectAlerts`, `selectKpi*`,
`selectUnit(id)`, `selectAlertMeta(alertId)`, `selectUnitFirstRaisedAt(id)`,
`selectTrendingUnits`. Battery and last contact are channel hooks (above), not
selectors: a zustand selector cannot see a batch.
UI actions: `ackAlert(alertId)` and `resolveAlert(alertId, { via, ref? })` —
idempotent, audit-logged once; the alert stays in the feed and renders its
resolved state from `alertMeta`. `reset()` clears state, rings and the trend
watch. Escalation (a red on a unit with an active amber) is logged by the
store, not by an action.

Subscribe via narrow selectors and wrap array-building selectors in
`useShallow`. `kpiAvgBattery` is kept in O(1) per battery move from a running
sum held as module state — writing that sum through `set()` would be a commit
per 0.1 %. A `fleet_snapshot` restates units, clears the feed and live
commands, and leaves the rings alone; rate-fitting derivations must not read
past `telemetryEpochTs`. `alertMeta` and the audit log survive snapshots.

## Trend watch (`trendWatch.ts`)

A reducer step, not a selector-memo: `applyTelemetry` calls `trendOnBatch`
once per batch (re-judges the one unit the batch carried — a map lookup and a
subtraction, plus at most one least-squares fit per `TREND_REFIT_MS` of that
unit's own clock) and `applyAlert` / `applyUnitUpdate` call
`trendOnUnitsChange` (a unit that stops being nominal leaves the watch at
once). The output is the store's `trending` field, committed only when
membership, the suspect joint or a whole-number °C/min moves. Only nominal
units are watched; a snapshot drops every latch and cached fit
(`resetTrendWatch`) so a replayed storyline is judged at ENTER like the first
run. `TrendingUnit = { unitId, joint, cPerMin }`.

## Cohort detection

A cohort is `>= COHORT_THRESHOLD` (3) unresolved alerts grouped by
`(message, current fw)`. `selectCohorts` is memoized on the identities of
`units` / `alerts` / `alertMeta` (safe bare). `CohortIncident` =
`{ id, signature, fw, unitIds, alertIds, detectedAt, canary }`; `id`/`detectedAt`
latch at the crossing, a re-cross is a new instance. Membership is current truth
and dissolves during a rollback — render the tail from `selectFleetCommand`.

## Incident store

```
idle ──beginDescent(unitId)──▶ descending ──scan_start──▶ scanning
scanning ──walk/channel/flag──▶ scanning   (accumulates into session)
scanning ──verdict──▶ verdict ──completeAscent()──▶ idle (+ history entry)
verdict ──recalibration──▶ verdict          (the re-measure, once)
any active phase ──abortSession()──▶ idle  (nothing archived)
```

State: `phase`, `session: DiagSession | null`, `watching`,
`exiting: { session, phase } | null`, `history` (newest first).
`DiagSession` = `{ unitId, startedAt, walkLines, channels, flag, report,
acknowledged, calibration }`; `IncidentRecord` adds `id`
(`inc-<unitId>-<ts>`, the same ref the audit row carries) and copies the
session's evidence. Selectors: `selectDiagPhase`, `selectDiagSession`,
`selectDiagWatching`, `selectIncidentHistory`, `selectUnitHistory(id)`,
`selectShownSession` / `selectShownPhase` / `selectExiting`.
UI actions: `beginDescent`, `acknowledgeRecommendation`, `completeAscent`,
`leaveSession` / `watchSession`, `abortSession`, `dismissExit`.

- `watching` is not a phase: it is whether the operator is looking. Mid-scan
  CLOSE is `leaveSession()`; at the verdict it is `completeAscent()`
  (`components/machine/leave-descent.ts` owns that split).
- Replay is idempotent: each event is admitted once by its natural identity
  (walked path, channel joint), so render `session.walkLines` directly and
  keep no local copy. A scan that revisits a node would need a wire seq.
- `scan_start` while idle adopts an in-flight scan.
- **`exiting` is the session that has ended but is still on screen.**
  `completeAscent` / `abortSession` snapshot it in the same commit they clear
  `phase` and `session`, because the surface deliberately outlives that commit
  by one exit animation; the stage clears it via `dismissExit()` when the wipe
  finishes, and `beginDescent` / adopt / `watchSession` / `reset` clear it too,
  since a new session is never a departing one. `leaveSession` writes nothing:
  mid-scan CLOSE leaves the session _alive_, and a surface rendering it live
  through that exit is honest.
  **Machine space reads `selectShownSession` / `selectShownPhase`; everything
  on the operator page keeps reading the live `selectDiagPhase` /
  `selectDiagSession`** — reading through the snapshot out there would make the
  unit banner claim a diagnostic is running for the length of the ascent,
  which is the same lie pointed the other way.

## Command store

Driven by `command_event`s: `accepted → pending → progress* → complete`, any
`→ failed{reason}`. Keyed by `commandKey(unitId, cmd)`, one entry per (unit,
command), so a refusal cannot displace a running maneuver's receipt.
`UnitCommandState` = `{ unitId, cmd, phase, pct, note, reason, seq, updatedAt }`;
`note`/`reason` are machine voice, print verbatim. `selectUnitCommand(unitId, cmd)`
and `selectUnitLiveCommand(unitId)` are safe bare; `dismissCommand` is a no-op
mid-flight. A recalibration's re-measure arrives as a `diag_event`, admitted
in the `verdict` phase only. **Fleet slice:** `HALT_ROLLOUT` and
`ROLLBACK_COHORT {fw}` run the same machine keyed by command name —
`selectFleetCommand(cmd)` / `dismissFleetCommand(cmd)`. HALT is synchronous;
ROLLBACK is staged and serial, each restoration a `unit_update` then an `alert_clear`.

## Audit store

Entries `{ id, ts, kind, unitId, summary, ref? }`, newest first, session-scoped
(survive snapshots), deduped per `(kind, ref)`. Appended by the stores, never
the UI: `alert-raised` / `escalation` / `alert-acked` / `resolution` (fleet),
`diag-*` (incident), `command-*` / `rollback-*` / `rollout-halted` (command),
`cohort-detected` (derivation). Fleet-scoped kinds carry `unitId: FLEET_AUDIT_SCOPE`.
Selectors: `selectAuditLog` (safe bare), `selectUnitAuditLog(id)` (`useShallow`).

## Ordering policy

Enforced at the transport by `createOrderingGate` (`lib/transport`): stale
telemetry (`ts <=` newest admitted) is dropped whole; command events are ordered
by engine-monotonic `seq` on per-unit lanes plus one fleet lane; a `fleet_snapshot`
resets every gate; everything else dedupes in its reducer.

## Testing

Stores are module singletons: call `reset()` on every store you touch in
`beforeEach` (plus `resetCohortDerivation()`) and drive them with plain
messages. Every reducer appends to the audit store, so reset it too. The
fleet store's `reset()` empties the telemetry channel and the trend watch;
`subscribeUnitTelemetry` is how a test counts per-unit notifications, and
`telemetryBatchCount()` is the fleet-wide receipt. `SIM_UNITS` /
`NEXT_PUBLIC_SIM_UNITS` size the fleet (8–500); the named eight are always
first and byte-identical to the 8-unit run.
