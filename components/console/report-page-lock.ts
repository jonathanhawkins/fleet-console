"use client";

import * as React from "react";

/**
 * The page under a full-viewport surface: locked, marked, and counted.
 *
 * Three surfaces cover the operator page — the unit report
 * (incident-report-overlay.tsx), the fleet report (cohort-incident.tsx) and the
 * descent (descent-overlay.tsx) — and all three want the same bargain: stop the
 * page scrolling underneath, and pay the reclaimed scrollbar back as padding so
 * it does not shift sideways while it is still visible.
 *
 * They used to want it three times, in three copies, each capturing its own
 * `previousPadding` and clearing `root.style.overflow` unconditionally on the
 * way out. The argument for the duplication was that the two reports can never
 * be open at once, which is true and was not the whole list: the unit page
 * mounts the descent AND the report gate, a `scan_start` on the wire opens the
 * descent with no operator action (a reconnect replay, a second console), and
 * from there the two overlap. The second lock then measures a gutter of 0 —
 * the scrollbar is already hidden — and whichever unmounts first hands the page
 * back under the other: scroll restored beneath a surface that is still up, and
 * a padding written back that the writer never set.
 *
 * So the lock is counted rather than copied. The state is snapshotted on the
 * 0 → 1 transition and restored on 1 → 0; everything in between is a no-op, and
 * a nested lock cannot take the page back from the one underneath it.
 *
 * The root attribute is counted the same way, and for a sharper reason: a stale
 * `data-report="open"` arms the print block in globals.css, which hides every
 * body child that is not the report — so a leaked attribute does not degrade
 * printing, it prints the whole app blank.
 *
 * **A layout effect, not a passive one**, and that is inherited rather than
 * chosen (descent-overlay.tsx). A passive cleanup runs a scheduler beat
 * *after* the commit that removes the surface, and that beat is a real state:
 * the page still locked and marked with nothing over it. It was observed
 * directly under a contended suite — overlay gone from the DOM, attribute still
 * standing, twice in 112 loaded runs. Releasing in the layout phase makes both
 * edges atomic with their commit.
 */

/** Marks the document root while a report is open; see the print block in globals.css. */
export const REPORT_ATTR = "data-report";

/** How many surfaces are holding the page right now. */
let held = 0;
/** The page's own values, taken at 0 → 1 and given back at 1 → 0. */
let previousOverflow = "";
let previousPadding = "";
/** Holders per root attribute — one name in practice, counted anyway. */
const marks = new Map<string, number>();

function acquire(): void {
  held += 1;
  if (held > 1) return;
  const root = document.documentElement;
  const body = document.body;
  previousOverflow = root.style.overflow;
  previousPadding = body.style.paddingRight;
  // The gutter the scrollbar leaves, measured while it is still there — which
  // is the whole reason this may only happen on the first lock.
  const gutter = Math.max(0, window.innerWidth - root.clientWidth);
  root.style.overflow = "hidden";
  if (gutter > 0) body.style.paddingRight = `${gutter}px`;
}

function release(): void {
  held -= 1;
  if (held > 0) return;
  held = 0;
  document.documentElement.style.overflow = previousOverflow;
  document.body.style.paddingRight = previousPadding;
}

function mark(attr: string, delta: number): void {
  const next = (marks.get(attr) ?? 0) + delta;
  if (next > 0) {
    marks.set(attr, next);
    document.documentElement.setAttribute(attr, "open");
    return;
  }
  marks.delete(attr);
  document.documentElement.removeAttribute(attr);
}

/**
 * Hold the page while `active`, and optionally mark the root with `attr`.
 *
 * The descent takes the lock alone — it carries its own `data-descent`, whose
 * dim variable has to be written on both edges and stays with it. The two
 * report gates pass {@link REPORT_ATTR}, which is the string the print block
 * keys on.
 */
export function usePageLock(active: boolean, attr?: string): void {
  React.useLayoutEffect(() => {
    if (!active) return;
    acquire();
    if (attr !== undefined) mark(attr, 1);
    return () => {
      if (attr !== undefined) mark(attr, -1);
      release();
    };
  }, [active, attr]);
}
