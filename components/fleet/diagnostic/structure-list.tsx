"use client";

import * as React from "react";
import { ConsoleButton, Disclosure, SectionLabel } from "@/components/console";
import { buildManifest } from "@/lib/diagnostics/manifest-spec";
import { type DiagSession } from "@/lib/stores";
import { cn } from "@/lib/utils";

/**
 * The nine subsystems the walk covers, and what the walk found.
 *
 * This is the half of the parts manifest the channel column above does not
 * already carry. The manifest's first six rows *are* the six joints, measured
 * and drawn there; listing them again here would be the panel saying the same
 * thing twice in two shapes. What is left is structure and firmware, and it is
 * worth its space for one reason: the diagnosis is not "the knee is broken", it
 * is "fifteen things were checked and one of them was not fine". The count is
 * the evidence, and a panel that printed only the finding would make a weaker
 * claim with the same words.
 *
 * Quiet by construction. A pending row is a middot, a cleared row is a small
 * check — not nine sage chips reading OPERATING, which would out-shout the one
 * row on the page that matters. The rows are ordered the way the scan clears
 * them, so the grid fills top to bottom and never skips around.
 */

/** Operator names for the wire's ids, in the order the walk clears them. */
const STRUCTURE_LABELS: ReadonlyArray<readonly [id: string, label: string]> = [
  ["HEARTBEAT_SVC", "Heartbeat"],
  ["POWER_RAIL_48V", "Power rail 48 V"],
  ["THERMAL_MAP", "Thermal map"],
  ["SPINE_BUS", "Spine bus"],
  ["PELVIS_PARK", "Park pose"],
  ["GAIT_CYCLE", "Walk cycle"],
  ["BALANCE_REFLEX", "Balance reflex"],
  ["GAIN_TABLES", "Gain tables"],
  ["IMU_FUSION", "IMU fusion"],
];

export const STRUCTURE_ORDER: readonly string[] = STRUCTURE_LABELS.map(([id]) => id);

/** A 10px stroke, not an icon font and not a chip. */
function CheckMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 10 10"
      className="size-2.5 shrink-0 text-nominal"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.5 5.5 4 8l4.5-6" />
    </svg>
  );
}

export interface StructureListProps {
  session: DiagSession | null;
}

export function StructureList({ session }: StructureListProps) {
  const [open, setOpen] = React.useState(false);
  const entries = buildManifest(session);
  const walked = session?.walkLines ?? [];

  const byId = new Map(entries.map((entry) => [entry.row.id, entry]));
  const rows = STRUCTURE_LABELS.map(([id, label]) => ({
    id,
    label,
    entry: byId.get(id),
  }));
  const cleared = rows.filter((r) => r.entry?.state === "operating").length;

  return (
    <section className="mt-5 flex flex-col gap-3 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <SectionLabel as="h3">
          Structure and firmware · {cleared} of {rows.length} checked
        </SectionLabel>
        <ConsoleButton
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide subsystem walk" : "Subsystem walk"}
        </ConsoleButton>
      </div>

      <ul className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(({ id, label, entry }) => {
          const done = entry?.state === "operating";
          return (
            <li
              key={id}
              data-structure={id}
              data-state={done ? "checked" : "pending"}
              className="flex items-baseline gap-2 text-small text-ink-soft"
            >
              <span
                className={cn(
                  "shrink-0 transition-colors duration-[var(--dur-micro)]",
                  done && "text-ink",
                )}
              >
                {label}
              </span>
              <span
                aria-hidden
                className="min-w-4 flex-1 border-b border-dotted border-line"
              />
              {entry?.detail ? (
                <span className="shrink-0 tnum text-label text-ink-soft">
                  {entry.detail}
                </span>
              ) : null}
              {done ? (
                <CheckMark />
              ) : (
                <span aria-hidden className="text-muted">
                  ·
                </span>
              )}
              <span className="sr-only">{done ? "checked" : "not yet checked"}</span>
            </li>
          );
        })}
      </ul>

      {/* The twenty paths, verbatim. Mono on warm white in the page's own ink —
          a transcript in daylight, not a screenshot of a terminal. */}
      <Disclosure open={open}>
        <ol className="mt-1 max-h-60 overflow-y-auto">
          {walked.map((path, i) => (
            <li key={path} className="flex gap-3 font-mono text-small text-ink-soft">
              <span className="tnum text-muted">{String(i + 1).padStart(4, "0")}</span>
              <span className="break-all">{path}</span>
            </li>
          ))}
          {walked.length === 0 ? (
            <li className="text-small text-ink-soft">No nodes walked yet.</li>
          ) : null}
        </ol>
      </Disclosure>
    </section>
  );
}
