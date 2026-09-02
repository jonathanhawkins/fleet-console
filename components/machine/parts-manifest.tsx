"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  MANIFEST_GROUP_LABEL,
  subjectRowState,
  type ManifestEntry,
  type ManifestGroup,
  type ManifestState,
} from "./manifest-spec";
import { pad4 } from "./scan-copy";

/**
 * The numbered inventory, straight off the eva parts-status board.
 *
 * The reference's whole trick is the chip treatment, and it is worth naming
 * because it is what makes that frame legible from across a room: OPERATING is
 * *text on a ground* and DAMAGED is **inverted** — a solid block of alert with
 * the void knocked out of it. One state reads as a label, the other reads as a
 * stamp. That asymmetry does the work a colour difference alone cannot,
 * because it survives being small, being scanned past, and being looked at by
 * someone who is not checking each row.
 *
 * Pending rows carry no chip at all. A board where two thirds of the column is
 * printed before the machine has checked anything would be a board that told
 * you nothing while it filled in; the chips arriving *is* the progress
 * indicator, and the eye is drawn to the one that arrives inverted.
 */

const CHIP: Record<ManifestState, string> = {
  // Text on a faint ground: present, unremarkable, correct.
  operating: "bg-nominal-tint text-nominal",
  // Inverted: a stamp, not a label.
  damaged: "bg-alert text-bg",
  // Also a stamp, and deliberately the *same* stamp in the other hue. This row
  // was the one inverted block on a fifteen-row board; after the re-measure it
  // is still the one inverted block, and it has gone from red to phosphor. The
  // eye that found the damage by its weight finds the resolution in the same
  // place by the same weight — which is what makes this a state change of the
  // board rather than a line of small type somewhere else on the screen.
  restored: "bg-nominal text-bg",
  pending: "text-ink-muted",
};

const CHIP_COPY: Record<ManifestState, string> = {
  operating: "Operating",
  damaged: "Damaged",
  restored: "Restored",
  pending: "Pending",
};

export interface PartsManifestProps {
  entries: ManifestEntry[];
  /**
   * Ref onto the scan's subject, so the board can run a leader line to it.
   *
   * The subject, not "the damaged row": the leader line says *this module and
   * that row are the same thing*, which stays true after the fault on it has
   * been corrected. Dropping the line the moment the row turned RESTORED would
   * cut the drawing loose from the inventory at exactly the moment the two of
   * them have something new to agree about.
   */
  subjectRowRef?: React.Ref<HTMLDivElement>;
  className?: string;
}

export function PartsManifest({ entries, subjectRowRef, className }: PartsManifestProps) {
  let lastGroup: ManifestGroup | null = null;

  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      {entries.map((entry) => {
        const newGroup = entry.row.group !== lastGroup;
        lastGroup = entry.row.group;
        return (
          <React.Fragment key={entry.row.id}>
            {newGroup ? (
              <div className="mt-2 flex items-center gap-2 border-b border-line pb-1 first:mt-0">
                <span className="text-label text-ink-soft uppercase">
                  {MANIFEST_GROUP_LABEL[entry.row.group]}
                </span>
              </div>
            ) : null}
            <ManifestRowView
              entry={entry}
              rowRef={subjectRowState(entry.state) ? subjectRowRef : undefined}
            />
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ManifestRowView({
  entry,
  rowRef,
}: {
  entry: ManifestEntry;
  rowRef?: React.Ref<HTMLDivElement>;
}) {
  const { row, ordinal, state, detail } = entry;

  return (
    <div
      ref={rowRef}
      data-row={row.id}
      data-state={state}
      className={cn(
        "flex items-center gap-2 py-[1.5px] text-small whitespace-nowrap",
        state === "pending" ? "text-ink-muted" : "text-ink-soft",
      )}
    >
      <span className="shrink-0 tnum text-ink-muted">{pad4(ordinal)}</span>
      {/* The reference's em dash between ordinal and name; it is what makes the
          column read as an inventory rather than as a list. */}
      <span aria-hidden className="shrink-0 text-ink-muted">
        —
      </span>
      <span
        className={cn(
          "shrink-0",
          state === "damaged" && "text-alert",
          state === "restored" && "text-nominal",
        )}
      >
        {row.id}
      </span>
      {row.tag ? <span className="shrink-0 tnum text-ink-muted">{row.tag}</span> : null}
      {detail ? <span className="shrink-0 tnum text-ink-muted">{detail}</span> : null}

      {/* Dot leader to the chip: the inventory idiom, and the thing that keeps
          a fifteen-row column readable across a gap. */}
      <span aria-hidden className="manifest-leader" />

      <span
        className={cn(
          "shrink-0 px-1.5 py-px text-center text-label uppercase",
          "min-w-[5.75rem]",
          CHIP[state],
        )}
      >
        {CHIP_COPY[state]}
      </span>
    </div>
  );
}
