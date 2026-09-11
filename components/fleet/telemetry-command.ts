"use client";

import { type OperatorCommand, type StorylineChapterName } from "@/lib/schema";
import { readDiagnosticView } from "@/lib/prefs/diagnostic-view";
import { useIncidentStore } from "@/lib/stores";
import { type TelemetryTransport } from "@/lib/transport";

/**
 * The outbound half of the telemetry link.
 *
 * Inbound messages flow into the stores through `bindTransport`, so any
 * component can read the fleet by subscribing. Outbound commands have no such
 * path: `lib/stores/README.md` is explicit that commands do *not* go through
 * the stores, which leaves the question of how a button three levels down the
 * unit page reaches the socket the root layout opened.
 *
 * The answer is this module rather than a React context, for the same reason
 * the telemetry rings are not in reactive state: there is exactly one link, it
 * never changes identity while the app is mounted, and nothing renders because
 * of it. A context would put a provider around the whole tree and a hook in
 * every caller to express a constant.
 *
 * `TelemetryProvider` registers the transport it just bound; everything else
 * calls `runDiagnostic` or `commandSafeSit`.
 */

let transport: TelemetryTransport | null = null;

/**
 * Called by `TelemetryProvider` on mount (and with `null` on unmount, which
 * matters in Strict Mode: the first mount's teardown must not leave a
 * disconnected transport registered for the second mount's commands).
 */
export function setCommandTransport(next: TelemetryTransport | null): void {
  transport = next;
}

/**
 * Send a command if the link is bound. Returns false when it is not — before
 * hydration, or in a test that never mounted the provider.
 *
 * "Bound" is not "connected": WsTransport queues commands while it reconnects
 * and flushes them on open, so a command sent during a blip still lands.
 */
export function sendCommand(cmd: OperatorCommand): boolean {
  if (!transport) return false;
  transport.send(cmd);
  return true;
}

/**
 * Run a diagnostic on a unit: the wire command and the local session opening,
 * as one call.
 *
 * The store README documents these two as a pair, and a pair that must be
 * written out by hand at every call site is a pair that eventually gets
 * half-written — `beginDescent` without the command hangs the UI in
 * "descending" forever, and the command without `beginDescent` drops the
 * operator into a scan the page never acknowledged starting. Here it cannot
 * come apart: if there is no link to send on, no session opens either.
 */
export function runDiagnostic(unitId: string): boolean {
  if (!sendCommand({ c: "RUN_DIAGNOSTIC", unitId })) return false;
  useIncidentStore.getState().beginDescent(unitId);
  // Which surface this scan opens in. Read here — at the press — rather than
  // inside the store, because `watching` means "the operator is in machine
  // space right now" and every consumer of it depends on that staying true.
  // A session that opened calm has nobody in machine space to be watching.
  if (readDiagnosticView() === "machine") useIncidentStore.getState().watchSession();
  return true;
}

/**
 * Command a unit into a safe seated hold — the first control in this console
 * that actually moved a robot, and the precondition for the one below it.
 *
 * The deliberate asymmetry with `runDiagnostic` above: that one is a *pair*,
 * because a scan needs a local session opened alongside the wire command. This
 * one is a single call, and the store README is explicit about why — pair it
 * with nothing. There is no optimistic write, no local "pending" flag, no
 * `beginSit()`. The command store starts at `accepted`, which is the first
 * thing the machine itself said, so nothing on screen can claim a maneuver the
 * unit never agreed to.
 *
 * What the caller does own is the gap between this returning true and that
 * first event landing (one round trip). That is a UI state — "sent, not yet
 * answered" — and it belongs to the component that sent it, not to a store
 * that only ever records the wire.
 *
 * Returns false when there is no link to send on: the operator asked for a
 * maneuver and nothing left the building, which is a thing to print rather
 * than to swallow.
 */
export function commandSafeSit(unitId: string): boolean {
  return sendCommand({ c: "COMMAND_SAFE_SIT", unitId });
}

/**
 * Drive the flagged joint through an unloaded calibration sweep — the second
 * control in this console that moves a robot, and the cheapest one.
 *
 * Pair it with nothing, for the same reason `commandSafeSit` is paired with
 * nothing: the command store starts at `accepted`, which is the first thing the
 * machine itself said, so nothing on screen can claim a maneuver the unit never
 * agreed to. The sim is entitled to refuse — REQUIRES SEATED POSTURE most of
 * all — and that refusal is a real ending of this storyline rather than an
 * error path.
 *
 * No joint argument, deliberately. The target is the joint the scan flagged and
 * the sim knows which one that is; a console that named a joint could ask for a
 * calibration the diagnosis never implicated.
 *
 * Returns false when there is no link to send on.
 */
export function commandRecalibrate(unitId: string): boolean {
  return sendCommand({ c: "RECALIBRATE_JOINT", unitId });
}

/**
 * Stop the firmware rollout program — the fleet-scoped sibling of the maneuver
 * above, and the same rule applies with the same force: pair it with nothing.
 *
 * There is no `beginHalt()` and no optimistic flag anywhere. The command store's
 * fleet slice starts at `accepted`, which is the first thing the rollout program
 * itself said, so nothing on screen can claim a halt the fleet has not agreed to
 * — and the fleet is entitled to refuse (`NO ROLLOUT ACTIVE`, when the queued
 * install already landed). That refusal is a real ending of this storyline, not
 * an error path, which is exactly why the console must not have drawn a receipt
 * before hearing back.
 *
 * Returns false when there is no link to send on.
 */
/**
 * Pull the next act forward to meet the operator. The engine keeps the fleet
 * as it stands and only moves the clock; a chapter already at hand is a no-op
 * there, so this is safe to send on every filing. See storyline-chain.ts for
 * when it is sent.
 */
export function advanceStoryline(chapter: StorylineChapterName): boolean {
  return sendCommand({ c: "ADVANCE_STORYLINE", chapter });
}

export function haltRollout(): boolean {
  return sendCommand({ c: "HALT_ROLLOUT" });
}

/**
 * Roll every unit running `fw` back to the baseline, one at a time.
 *
 * `fw` comes from the detected cohort (`CohortIncident.fw`) and nowhere else:
 * the operator is acting on a blast radius, and a firmware string assembled by
 * the UI would be the console choosing which robots to change. Pair with
 * nothing, for the reason above; the staged lifecycle arrives as
 * `fleet_command_event`s and the per-unit consequences as `unit_update`s and
 * `alert_clear`s on the roads they always travelled.
 */
export function rollbackCohort(fw: string): boolean {
  return sendCommand({ c: "ROLLBACK_COHORT", fw });
}
