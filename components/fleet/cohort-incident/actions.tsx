"use client";

import * as React from "react";
import { type CohortIncident, type FleetCommandState } from "@/lib/stores";
import { haltImpact, rollbackImpact, rollbackRoster } from "../cohort-copy";
import { ConsoleButton } from "@/components/console";
import { haltRollout, rollbackCohort } from "../telemetry-command";
import { FleetConfirm } from "./fleet-confirm";
import { HaltReadout, RollbackReadout } from "./readouts";
import { ResolveAction } from "./resolve-action";

type Pending = "halt" | "rollback" | null;
/**
 * What the console is doing. Everything from `accepted` onward belongs to the
 * command store, because it is what the fleet said; there is no optimistic
 * write.
 */
type LocalPhase = "idle" | "confirming" | "sent" | "nolink";

interface CohortActionsProps {
  cohort: CohortIncident;
  fwOf: (unitId: string) => string | undefined;
  unitIds: readonly string[];
  queued: string[];
  halt: FleetCommandState | undefined;
  rollback: FleetCommandState | undefined;
  /** The incident is closeable: the group has gone and nothing is in flight. */
  settled: boolean;
  /** The closing moment, carried into the record so the report can date it. */
  closedAt: number | undefined;
}

/**
 * The two fleet-scale actions, their confirmation, their readouts and the
 * close-out. The safety discipline is safe-sit.tsx's: the confirmation
 * replaces the row in the flow, focus lands on Cancel, Escape aborts.
 */
export function CohortActions({
  cohort,
  fwOf,
  unitIds,
  queued,
  halt,
  rollback,
  settled,
  closedAt,
}: CohortActionsProps) {
  const [local, setLocal] = React.useState<LocalPhase>("idle");
  const [pending, setPending] = React.useState<Pending>(null);
  // Refs on the trigger elements, not elements captured at the press: the
  // confirmation replaces the row, so the buttons remount as new nodes and a
  // captured (detached) element would make `focus()` a silent no-op.
  const haltRef = React.useRef<HTMLButtonElement>(null);
  const rollbackRef = React.useRef<HTMLButtonElement>(null);
  const returnTo = React.useRef<Pending>(null);
  // The one element that outlives every state here: Confirm unmounts the
  // instant it is pressed, and focus needs somewhere other than <body> to land.
  const regionRef = React.useRef<HTMLDivElement>(null);

  // The roster the rollback will walk, frozen at the press. Derived live it
  // would shorten as units are restored and the total would count down.
  const rosterRef = React.useRef<string[] | null>(null);

  // The fleet has spoken: the store owns the display for that command now.
  const haltAnswered = halt !== undefined;
  const rollbackAnswered = rollback !== undefined;
  React.useEffect(() => {
    if (haltAnswered || rollbackAnswered) {
      setLocal("idle");
      setPending(null);
    }
  }, [haltAnswered, rollbackAnswered]);

  React.useEffect(() => {
    if (local !== "idle") return;
    const which = returnTo.current;
    if (which === null) return;
    returnTo.current = null;
    (which === "halt" ? haltRef : rollbackRef).current?.focus({ preventScroll: true });
  }, [local]);

  const ask = React.useCallback((which: Exclude<Pending, null>) => {
    returnTo.current = which;
    setPending(which);
    setLocal("confirming");
  }, []);

  const abort = React.useCallback(() => {
    setLocal("idle");
    setPending(null);
  }, []);

  const roster = React.useMemo(
    () => rollbackRoster(unitIds, fwOf, cohort.fw),
    [unitIds, fwOf, cohort.fw],
  );

  const confirm = React.useCallback(() => {
    // Send first, believe second — and if nothing left the building, say so.
    if (pending === "rollback") rosterRef.current = roster;
    const sent = pending === "halt" ? haltRollout() : rollbackCohort(cohort.fw);
    if (!sent) {
      setLocal("nolink");
      return;
    }
    // The trigger is about to be replaced by a readout; focus the narrator.
    returnTo.current = null;
    setLocal("sent");
    regionRef.current?.focus({ preventScroll: true });
  }, [pending, cohort.fw, roster]);

  const confirming = local === "confirming" && pending !== null;
  const sentHalt = local === "sent" && pending === "halt";
  const sentRollback = local === "sent" && pending === "rollback";

  // Is there anything left for a fleet-scale command to do? A question about
  // firmware, not about alert membership (`settled`): a group can drop below
  // threshold with every member still on the suspect build, and the rollback
  // must stay offered while one is.
  const remaining =
    queued.length > 0 || cohort.unitIds.some((id) => fwOf(id) === cohort.fw);

  return (
    <div ref={regionRef} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      {halt !== undefined ? <HaltReadout state={halt} dismissible={!settled} /> : null}
      {rollback !== undefined ? (
        <RollbackReadout
          state={rollback}
          roster={rosterRef.current ?? roster}
          fwOf={fwOf}
          fw={cohort.fw}
          dismissible={!settled}
        />
      ) : null}

      {confirming ? (
        <FleetConfirm
          title={
            pending === "halt"
              ? `Halt the ${cohort.fw} rollout?`
              : `Roll back ${roster.length} units from ${cohort.fw}?`
          }
          impact={
            pending === "halt"
              ? haltImpact(queued, cohort.fw)
              : rollbackImpact(roster.length, cohort.fw, queued)
          }
          onConfirm={confirm}
          onAbort={abort}
        />
      ) : null}

      {/* The row (what is left to command) and the close-out (whether the
          incident can be filed) are separate questions; both may be offered. */}
      {!confirming && remaining && (halt === undefined || rollback === undefined) ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            {halt === undefined ? (
              // The page's one dark pill: while a cohort stands, the failing
              // subject is the fleet.
              <ConsoleButton
                ref={haltRef}
                size="md"
                variant="primary"
                disabled={sentHalt}
                onClick={() => ask("halt")}
              >
                {sentHalt ? "Halt rollout · sent" : "Halt rollout"}
              </ConsoleButton>
            ) : null}
            {rollback === undefined ? (
              <ConsoleButton
                ref={rollbackRef}
                size="md"
                variant="secondary"
                disabled={sentRollback}
                onClick={() => ask("rollback")}
              >
                {sentRollback ? "Roll back cohort · sent" : "Roll back cohort"}
              </ConsoleButton>
            ) : null}
            {local === "sent" ? (
              // A word, not a bar: the fleet has not agreed to anything yet.
              <span className="text-label text-ink-soft uppercase">
                Awaiting fleet response
              </span>
            ) : null}
          </div>
          {local === "nolink" ? (
            <p className="text-label tracking-normal text-alert">
              Not sent · no link to the fleet
            </p>
          ) : null}
        </div>
      ) : null}

      {!confirming && settled ? (
        <ResolveAction cohort={cohort} closedAt={closedAt} />
      ) : null}
    </div>
  );
}
