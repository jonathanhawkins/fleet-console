# lib/stores — public API

Four zustand stores plus one wiring function. Anything not listed here is
internal and may change.

```
bindTransport(transport)   wire messages + connection status into the stores (call once)
useFleetStore              units, alerts + lifecycle, connection, KPIs, telemetry versions
useIncidentStore           diag session state machine + incident history
useCommandStore            per-unit command lifecycles (SAFE SIT, RECALIBRATE) plus the
                           fleet slice (HALT_ROLLOUT / ROLLBACK_COHORT)
useAuditStore              append-only session log — the single source the UI renders
selectCohorts              derived fleet incident: the firmware cohort (cohortStore.ts is a
                           derivation over the fleet store, not a fifth store)
getUnitBuffers(unitId)     non-reactive telemetry ring buffers for canvas
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

## Fleet store

| field                                        | notes                                                          |
| -------------------------------------------- | -------------------------------------------------------------- |
| `connection`                                 | `idle/connecting/open/reconnecting/closed`                     |
| `units`, `unitIds`                           | entry identity changes only for the changed unit; rail order   |
| `alerts`, `alertMeta`                        | newest first, capped at 100; ack/resolution per alert id       |
| `latestBattery`, `lastContactAt`             | 0.1 % and 1 s quantized — mutated in place, never selected     |
| `unitTelemetryVersions`, `telemetryVersion`  | +1 per batch (per unit / any unit) — canvas hosts only         |
| `telemetryEpochTs`                           | per-unit seam between runs; replaced (not mutated) on snapshot |
| `kpiNominal` / `kpiAlerts` / `kpiAvgBattery` | header KPIs; `kpiAlerts` counts units with an unresolved alert |

`UnitSummary` carries optional `posture`, `fw` and `fwPending` (render
`undefined` as walking / unknown); `applyUnitUpdate` is idempotent by content.
Selectors: `selectConnection`, `selectUnitIds`, `selectAlerts`, `selectKpi*`,
`selectUnit(id)`, `selectUnitBattery(id)`, `selectUnitTelemetryVersion(id)`,
`selectLastContact(id)`, `selectAlertMeta(alertId)`, `selectUnitFirstRaisedAt(id)`.
UI actions: `ackAlert(alertId)` and `resolveAlert(alertId, { via, ref? })` —
idempotent, audit-logged once; the alert stays in the feed and renders its
resolved state from `alertMeta`. `reset()` clears state and rings. Escalation
(a red on a unit with an active amber) is logged by the store, not by an action.

**Invariants:** one store commit per 10 Hz batch, never per point; subscribe
via narrow selectors and wrap array-building selectors in `useShallow`.
Samples never enter reactive state — they live in `RingBuffer`s
(`getUnitBuffers(id)`, 600 samples ≈ 60 s); never hold `toArray()` across
frames. **Version counters drive canvas, never text**: text binds to quantized
primitives or the shared 1 s ticker, and the store keeps no duration field.
A `fleet_snapshot` restates units, clears the feed and live commands, and
leaves the rings alone; rate-fitting derivations (`trendWatch.ts`) must not
read past `telemetryEpochTs`. `alertMeta` and the audit log survive snapshots.

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
messages. Every reducer appends to the audit store, so reset it too.
`SIM_UNITS` / `NEXT_PUBLIC_SIM_UNITS` size the fleet (8–500); the named eight
are always first and byte-identical to the 8-unit run.
