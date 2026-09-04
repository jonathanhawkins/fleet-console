import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import {
  type Alert,
  type CommandEvent,
  type FleetSnapshotMessage,
  type OperatorCommand,
  type UnitSummary,
} from "@/lib/schema";
import {
  resetCohortDerivation,
  useAuditStore,
  useCohortRecordStore,
  useCommandStore,
  useFleetStore,
} from "@/lib/stores";
import { type TelemetryTransport } from "@/lib/transport";
import { setAlertFilter } from "./alert-rail";
import { useCohortSubject } from "./cohort-card";
import CohortIncidentCard from "./cohort-incident";
import { resetCohortMembership } from "./cohort-membership";
import { setCommandTransport } from "./telemetry-command";

/**
 * The console noticing that four alerts are ONE incident, and giving
 * the operator fleet-scale actions with SAFE SIT's safety discipline — in
 * operator space, where the vocabulary is sentence case and the consequence is
 * four robots instead of one.
 *
 * The three things this file exists to hold down:
 *
 * 1. Nothing on screen claims a fleet-scale action the fleet has not agreed to.
 * No optimistic receipt, no progress bar over a round trip, no rollback list
 * animating a command that was refused.
 * 2. The confirmation is a real gate: focus lands on the cancel, Escape aborts,
 * and the two choices carry the same weight.
 * 3. The progress list is a reading of firmware truth, so it cannot drift from
 * what the rail rows and the map markers are showing about the same units.
 */

export const BASE = 1_700_000_000_000;
export const NOW = BASE + 34_000;

export const SIGNATURE = "Balance reflex latency above threshold";
export const SUSPECT = "2.4.1";
export const BASELINE = "2.3.7";

/** N-02/04/06/08 on the rollout build, N-05 queued for it, the rest baseline. */
export function unit(
  id: string,
  fw: string,
  fwPending?: string,
  battery = 80,
): UnitSummary {
  return {
    id,
    name: `${id} House`,
    status: "nominal",
    // Restatements carry a drifted battery because the sim's do: `summarize`
    // always reads the live value, and a test that restated a byte-identical
    // summary would be exercising the store's no-op path instead of the wire's.
    battery,
    pos: { lat: 44.06, lng: -121.31 },
    fw,
    ...(fwPending !== undefined ? { fwPending } : {}),
  };
}

export const SNAPSHOT: FleetSnapshotMessage = {
  t: "fleet_snapshot",
  units: [
    unit("N-01", BASELINE),
    unit("N-02", SUSPECT),
    unit("N-03", BASELINE),
    unit("N-04", SUSPECT),
    unit("N-05", BASELINE, SUSPECT),
    unit("N-06", SUSPECT),
    unit("N-07", BASELINE),
    unit("N-08", SUSPECT),
  ],
};

export const MEMBERS = ["N-02", "N-04", "N-06", "N-08"];

export const sent: OperatorCommand[] = [];
export const transport: TelemetryTransport = {
  connect: () => {},
  send: (cmd) => sent.push(cmd),
  disconnect: () => {},
};

let seq = 0;

/** Raise one member's signature alert — byte-identical message, by design. */
export function raise(unitId: string, at: number): Alert {
  const alert: Alert = {
    id: `al-${unitId}`,
    unitId,
    severity: "amber",
    message: SIGNATURE,
    ts: at,
  };
  act(() => {
    useFleetStore.getState().applyAlert({ t: "alert", alert });
  });
  return alert;
}

/** Everything up to and including the alert that crosses the threshold. */
export function formCohort(members: readonly string[] = MEMBERS): void {
  members.forEach((id, i) => raise(id, BASE + i * 1_000));
}

export function fleetEvent(
  cmd: "HALT_ROLLOUT" | "ROLLBACK_COHORT",
  ev: CommandEvent,
  fw = SUSPECT,
): void {
  act(() => {
    useCommandStore.getState().applyFleetCommandEvent({
      t: "fleet_command_event",
      cmd,
      fw,
      seq: (seq += 1),
      ts: NOW,
      ev,
    });
  });
}

/**
 * What the engine does at ROLLBACK_COHORT accept, beyond the lifecycle event.
 *
 * "Rolling a build back implies halting its rollout: a still-queued install of
 * cmd.fw is canceled here (visible as the unit_update dropping fwPending), and
 * rolloutHalted flips so a later HALT_ROLLOUT answers NO ROLLOUT ACTIVE
 * truthfully" (sim/engine.ts). The card reads the queue off `fwPending`, so a
 * fixture that skipped this restatement left the console — correctly — still
 * offering a halt for an install the wire still said was scheduled.
 */
export function cancelQueuedInstall(): void {
  act(() => {
    useFleetStore.getState().applyUnitUpdate({
      t: "unit_update",
      unit: unit("N-05", BASELINE, undefined, 79.8),
    });
  });
}

/** The engine's per-unit consequence: firmware restated, then the alert cleared. */
export function restore(unitId: string): void {
  act(() => {
    useFleetStore.getState().applyUnitUpdate({
      t: "unit_update",
      unit: unit(unitId, BASELINE, undefined, 79.4),
    });
    useFleetStore.getState().resolveAlert(`al-${unitId}`, { via: "rollback" });
  });
}

export function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-slot='cohort-card']");
}

export function rollbackRow(unitId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-slot='rollback-unit'][data-unit='${unitId}']`,
  );
}

/**
 * The shared ground under the cohort suites.
 *
 * `cohort-card.test.tsx` grew to 1,321 lines — the longest file in the repo,
 * and a test file at that, which is the worst place for one: a suite nobody
 * can hold in their head is a suite nobody edits with confidence. It is three
 * subjects wearing one preamble, so the preamble moved here and the subjects
 * became three files: the card, the commands it offers, and the record it
 * leaves behind.
 *
 * `installCohortHarness()` registers the hooks. Calling it rather than having
 * the import register them is the point: a file that imports a fixture should
 * not silently acquire a `beforeEach`, and the call site says out loud that
 * this suite runs on fake timers against a reset fleet.
 */

export function installCohortHarness(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    seq = 0;
    sent.length = 0;
    setAlertFilter("open");
    useFleetStore.getState().reset();
    useCommandStore.getState().reset();
    // Fleet and command reducers both append to the audit log; a stale log would
    // leak the previous test's receipts into this one.
    useAuditStore.getState().reset();
    // The close-out is session-scoped like the log: a record left over from the
    // previous test would suppress the next one's card before it existed.
    useCohortRecordStore.getState().reset();
    resetCohortDerivation();
    resetCohortMembership();
    setCommandTransport(transport);
    useFleetStore.getState().applySnapshot(SNAPSHOT);
  });

  afterEach(() => {
    setCommandTransport(null);
    vi.useRealTimers();
  });
}

/**
 * `fireEvent`, not `userEvent`: this suite runs on fake timers (the card has a
 * ticking duration), and user-event's own delay loop does not resolve under
 * them. The same choice alert-rail.test.tsx makes, for the same reason.
 */
export const press = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
export const key = (el: Element, init: Partial<KeyboardEvent>) =>
  fireEvent.keyDown(el, init);

/**
 * The card body, mounted against the gate's own judgement.
 *
 * `CohortCard` puts the body behind a `next/dynamic` boundary — the fleet
 * page's initial JS is measured against a hard budget and this card renders a
 * state that does not exist on load. That boundary is an async import, which
 * every synchronous assertion below would have to wait on for no benefit: the
 * thing under test is what the card SAYS, not how its chunk arrives. So the
 * suite renders the body directly, driven by `useCohortSubject` — the exact
 * derivation the gate uses, so the two cannot disagree about when a fleet
 * incident exists — and the boundary itself is covered once, in "the gate".
 */
export function Card() {
  const subject = useCohortSubject();
  if (subject === null) return null;
  return <CohortIncidentCard cohort={subject.cohort} dissolved={subject.dissolved} />;
}
