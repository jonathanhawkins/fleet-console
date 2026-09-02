"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import {
  selectCohortRecord,
  selectCohorts,
  selectFleetCommand,
  useCohortRecordStore,
  useCommandStore,
  useFleetStore,
  type CohortIncident,
} from "@/lib/stores";
import { cn } from "@/lib/utils";

/**
 * The fleet incident's GATE: the subscription that decides whether there is
 * one, and the collapse that gives it its space. The card is a `next/dynamic`
 * boundary (cohort-incident/), never re-exported from the barrel.
 */

// One arrow, referenced twice, so the bundler emits one chunk for both.
const importCard = () => import("./cohort-incident");

const CohortIncidentCard = dynamic(() => importCard().then((m) => m.default), {
  ssr: false,
});

const CohortRecordLine = dynamic(() => importCard().then((m) => m.CohortRecord), {
  ssr: false,
});

let warmed: Promise<unknown> | null = null;

/** Warm the card's chunk: a cohort arrives on the wire, with no hover to warm on. */
export function preloadCohortCard(): void {
  warmed ??= importCard();
}

/** What the card is about, or null when there is no incident. */
export interface CohortSubject {
  cohort: CohortIncident;
  /** The derivation has let the group go; the commands are the story now. */
  dissolved: boolean;
}

export function useCohortSubject(): CohortSubject | null {
  const cohorts = useFleetStore(selectCohorts);
  const halt = useCommandStore(selectFleetCommand("HALT_ROLLOUT"));
  const rollback = useCommandStore(selectFleetCommand("ROLLBACK_COHORT"));

  // The incident at its widest: the derivation shrinks as a rollback restores
  // units, and the headline must not count down. Keyed on the instance id.
  const live = cohorts[0];
  const peakRef = React.useRef<CohortIncident | null>(null);
  const peak = peakRef.current;
  if (
    live !== undefined &&
    (peak === null || peak.id !== live.id || live.unitIds.length >= peak.unitIds.length)
  ) {
    peakRef.current = live;
  }
  const subject = peakRef.current;

  // A snapshot clears the fleet commands, so a stale subject cannot outlive its run.
  if (subject === null) return null;
  if (live === undefined && halt === undefined && rollback === undefined) return null;
  return { cohort: subject, dissolved: live === undefined };
}

/**
 * Whether the page has a fleet incident right now. Asks only the stores (no
 * per-caller peak ref), so every caller agrees.
 */
export function useHasCohortIncident(): boolean {
  const cohorts = useFleetStore(selectCohorts);
  const halt = useCommandStore(selectFleetCommand("HALT_ROLLOUT"));
  const rollback = useCommandStore(selectFleetCommand("ROLLBACK_COHORT"));
  return cohorts.length > 0 || halt !== undefined || rollback !== undefined;
}

export function CohortCard() {
  const subject = useCohortSubject();
  const record = useCohortRecordStore(selectCohortRecord);

  React.useEffect(() => {
    preloadCohortCard();
  }, []);

  // A closed incident is a record, not a card, whatever the command store holds.
  const closedId = record?.cohort.id ?? null;
  const live = subject !== null && subject.cohort.id !== closedId ? subject : null;

  // A new incident supersedes the last one's record (by detection, not by reset).
  const liveId = subject?.cohort.id ?? null;
  React.useEffect(() => {
    if (liveId === null || liveId === closedId) return;
    useCohortRecordStore.getState().reset();
  }, [liveId, closedId]);

  // Did the record arrive under a press just now? Adjusted during render: it
  // must be true in the SAME commit the card unmounts in, for focus hand-off.
  const seen = React.useRef<string | null | undefined>(undefined);
  const [handOff, setHandOff] = React.useState(false);
  if (seen.current !== closedId) {
    const arrived = seen.current !== undefined && closedId !== null;
    seen.current = closedId;
    if (arrived !== handOff) setHandOff(arrived);
  }

  return (
    <>
      <CohortReveal>
        {live !== null ? (
          <CohortIncidentCard cohort={live.cohort} dissolved={live.dissolved} />
        ) : null}
      </CohortReveal>
      {/* Both on screen for the length of the collapse. */}
      {record !== null && live === null ? (
        <CohortRecordLine record={record} claimFocus={handOff} />
      ) : null}
    </>
  );
}

/**
 * The card opening and closing on `grid-template-rows: 0fr → 1fr` (see
 * disclosure.tsx); the negative margin cancels the column's row gap.
 */
function CohortReveal({ children }: { children: React.ReactNode }) {
  const present = children !== null && children !== false;
  const [mounted, setMounted] = React.useState(present);
  const [open, setOpen] = React.useState(false);
  const last = React.useRef<React.ReactNode>(null);
  if (present) last.current = children;

  // Adjusted during render: the card must exist, closed, in the store's commit.
  if (present && !mounted) setMounted(true);

  React.useEffect(() => {
    if (!present) {
      setOpen(false);
      return undefined;
    }
    // One frame closed, so there is a travel to run rather than a jump.
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [present]);

  if (!mounted) return null;

  return (
    <div
      data-slot="cohort-reveal"
      data-open={open || undefined}
      // `inert` while collapsing: a ghost you can click is worse than a ghost.
      inert={!present}
      className={cn(
        "-mb-6 grid transition-[grid-template-rows] duration-[var(--dur-enter)] ease-console sm:-mb-8 md:-mb-10",
        open && present ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
      onTransitionEnd={(event) => {
        // Only the wrapper's own travel retires the card.
        if (event.target === event.currentTarget && !present) setMounted(false);
      }}
    >
      <div className="overflow-hidden">
        <div className="pb-6 sm:pb-8 md:pb-10">{present ? children : last.current}</div>
      </div>
    </div>
  );
}
