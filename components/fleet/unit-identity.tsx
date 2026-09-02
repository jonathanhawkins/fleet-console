"use client";

import * as React from "react";
import Link from "next/link";
import {
  selectUnit,
  useFleetStore,
  useUnitBattery,
  useUnitLastContact,
} from "@/lib/stores";
import { cn } from "@/lib/utils";
import {
  BatteryMeter,
  formatRecency,
  isoTime,
  StatGroup,
  StatusChip,
  unitStatusChip,
  unitStatusCopy,
  useNow,
} from "@/components/console";
import { UnitPostureTag } from "./unit-posture-tag";
import { RunDiagnosticButton, useUnitDiagnostic } from "./run-diagnostic";

/**
 * Who this unit is, and the three facts that qualify the answer.
 *
 * The composition is the reference world's: the subject set large and quiet on
 * the left, its metadata in a wide-tracked, small, muted column on the right,
 * both sitting on the same baseline. The unit id is the page's h1 because it
 * is genuinely the title — on the fleet page the h1 is hidden, because there
 * the subject is "everything" and a display heading saying so would be the
 * loudest thing on a screen whose point is that nothing is happening.
 *
 * `useUnitLastContact` is quantised to a second in the telemetry channel, so
 * a unit reporting ten times a second re-renders this block once a second —
 * in step with the shared ticker that formats the label, rather than eighty
 * times faster than the text can change.
 */

/** A back link, not a breadcrumb trail: this hierarchy is two levels deep. */
export function BackToFleet() {
  return (
    <Link
      href="/"
      className="group inline-flex items-center gap-2 rounded-sm text-label text-ink-soft uppercase transition-colors duration-[var(--dur-press)] ease-console hover:text-ink active:text-ink"
    >
      <svg
        aria-hidden
        viewBox="0 0 12 12"
        className="size-3 shrink-0 -translate-x-0 transition-transform duration-[var(--dur-press)] ease-console group-hover:-translate-x-0.5 group-active:-translate-x-1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="square"
      >
        <path d="M11 6H1.5M5 2 1 6l4 4" />
      </svg>
      Fleet
    </Link>
  );
}

export interface UnitIdentityProps extends Omit<
  React.ComponentPropsWithoutRef<"div">,
  "children"
> {
  unitId: string;
}

export function UnitIdentity({ className, unitId, ...props }: UnitIdentityProps) {
  const unit = useFleetStore(selectUnit(unitId));
  const battery = useUnitBattery(unitId);
  const lastContact = useUnitLastContact(unitId);
  const now = useNow();
  // The banner's own decision, read rather than re-derived: exactly one of the
  // two surfaces carries the run control, and "none" is the banner saying it
  // has nothing to render (run-diagnostic.tsx).
  const { state: diagnostic } = useUnitDiagnostic(unitId);

  const recency = formatRecency(lastContact, now);
  const chip = unit ? unitStatusChip(unit.status) : "nominal";

  return (
    <div
      data-slot="unit-identity"
      className={cn("flex flex-col gap-6", className)}
      {...props}
    >
      <BackToFleet />

      {/* Two rows on a phone, one on a desk — the same wrap, given a shape.
          `w-full sm:w-auto` on the identity block is what forces the break:
          without it the three stats squeeze in beside a 44px unit id and each
          one wraps internally, which is three ragged columns instead of one
          clean second row. */}
      <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6 sm:gap-y-8">
        <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto">
          <h1 className="tnum text-display text-ink">{unitId}</h1>
          <p className="text-heading font-normal text-ink-soft">
            {unit?.name ?? "Waiting for the fleet"}
          </p>
        </div>

        {/* The metadata cluster: three facts, then the one thing the operator
            can do about them.

            `items-end` on the cluster and `items-start` on the `dl` inside it
            are doing different jobs. Inside, the three wide-tracked labels have
            to sit on one line with their values hanging beneath — bottom-
            aligning there would let the two-line battery meter push its own
            label down and put the row's labels on three different heights.
            Outside, the button aligns to the bottom of the stats rather than to
            the top of their labels, so it reads as the end of the row instead
            of as a fourth column of metadata. */}
        <div className="flex w-full flex-wrap items-end justify-between gap-x-8 gap-y-5 sm:w-auto sm:justify-end sm:gap-x-10">
          <dl className="flex flex-wrap items-start gap-x-6 gap-y-6 sm:gap-x-10">
            <StatGroup
              size="sm"
              label="Status"
              pending={!unit}
              value={
                unit ? (
                  <span className="flex flex-wrap items-center gap-2">
                    {/* Tinted, not bare: there is exactly one status on this
                        page, so there is no calm majority for it to drown out. */}
                    <StatusChip status={chip}>{unitStatusCopy(unit.status)}</StatusChip>
                    {/* Posture qualifies status rather than replacing it: a
                        completed SAFE SIT leaves N-07 reading "Alert · Safe
                        sit", which is the demo's whole point — broken, and
                        safe. Renders nothing for a unit on its feet. */}
                    <UnitPostureTag unitId={unitId} />
                  </span>
                ) : null
              }
            />
            <StatGroup
              size="sm"
              label="Battery"
              // Not `pending`: the meter has its own no-reading state, and it is
              // two lines tall in both — which is the difference between the
              // first snapshot filling a gauge and the first snapshot growing
              // this row by 11px and pushing the instruments down.
              // The gauge is also the widest object in this row and the only one
              // whose width is arbitrary, so it is the one that gives ground:
              // 80px on a phone is still a readable length, and it is what lets
              // status, battery and last contact stay on one line at 375.
              value={
                <BatteryMeter
                  value={unit ? battery : null}
                  trackClassName="w-20 sm:w-28"
                />
              }
            />
            <StatGroup
              size="sm"
              label="Last contact"
              pending={recency === null}
              value={
                <time dateTime={isoTime(lastContact)} className="tnum">
                  {recency}
                </time>
              }
            />
            {/* Which build this robot is running (Phase 11).

                It sits in the metadata row rather than on the incident banner
                because it is not news: firmware is a standing fact about a unit,
                true of a nominal robot and a faulty one alike, and the fleet
                incident's whole argument — four units, one build — is only
                checkable if an operator can look up any single unit and see
                which build it is on.

                The scheduled line is the exception, and it is the one thing on
                this page that HALT_ROLLOUT visibly saves: while the rollout has
                this unit queued the row reads "2.3.7 / Update scheduled 2.4.1",
                and the moment the halt lands the second line is simply gone. Its
                arrival and departure move the row's height by one label line —
                left unreserved on purpose, unlike the battery meter's two-line
                floor: an empty slot here would be the page promising an update
                that has not been scheduled. */}
            <StatGroup
              size="sm"
              label="Firmware"
              pending={!unit || unit.fw === undefined}
              value={
                <span className="flex flex-col">
                  <span className="tnum">{unit?.fw}</span>
                  {unit?.fwPending !== undefined ? (
                    <span className="text-label tracking-normal text-ink-soft">
                      Update scheduled <span className="tnum">{unit.fwPending}</span>
                    </span>
                  ) : null}
                </span>
              }
            />
          </dl>

          {/* The diagnostic, on a page that has nothing else to say about this
              unit.

              Every other state routes the action through the incident banner —
              the black pill while a fault is undiagnosed, "Run diagnostic
              again" once one has been. This is the state with no banner at all,
              and it used to be the state with no way to run a scan: a nominal
              robot could not be examined, which is a strange thing for a
              diagnostics console to say about a fleet whose whole job is
              catching what has not gone wrong yet. Quiet on purpose — an
              outline button in a metadata row, at the volume of the facts it
              sits beside. */}
          {unit && diagnostic === "none" ? (
            <RunDiagnosticButton unitId={unitId} size="sm" variant="secondary" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
