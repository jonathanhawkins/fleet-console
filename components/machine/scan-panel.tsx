"use client";

import * as React from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import { cn } from "@/lib/utils";
import { useBoot } from "./boot-variants";

/**
 * One region of the scan, framed the way the eva boards frame theirs: a label
 * bar in the machine's voice, a 1px rule, and dense content running to the
 * edges of the box.
 *
 * There is no ConsoleCard here on purpose. ConsoleCard collapses correctly in
 * machine space — radius and elevation are already zero there — but it is
 * built for a page that breathes: it pads, it centres its header row, it
 * assumes a card is an object on a surface. These panels are not objects on a
 * surface, they are cells of one instrument, divided by the grid's own 1px
 * gaps (see `.scan-grid` in app/globals.css) and carrying no border of their
 * own. Wrapping the wrong abstraction to undo four of its opinions is how a
 * component library stops meaning anything.
 *
 * Each panel is one beat of the boot stagger, so the motion lives here rather
 * than at every call site.
 */
// HTMLMotionProps rather than ComponentPropsWithoutRef: the panel *is* a
// motion element (it is one beat of the boot stagger), and React's drag and
// animation handler types collide with framer's on a plain spread.
export interface ScanPanelProps extends Omit<HTMLMotionProps<"section">, "children"> {
  /** Uppercase system voice: SUBSYSTEM WALK, PARTS MANIFEST, CHANNEL SWEEP. */
  label: string;
  /** Trailing slot on the label bar — a count, a state word. */
  meta?: React.ReactNode;
  area: "log" | "board" | "waves";
  children?: React.ReactNode;
  /** The panel element. Used to bring a panel into view when it changes size. */
  ref?: React.Ref<HTMLElement>;
}

export function ScanPanel({
  className,
  label,
  meta,
  area,
  children,
  ...props
}: ScanPanelProps) {
  const boot = useBoot();
  return (
    <motion.section
      variants={boot.item}
      data-slot="scan-panel"
      // Also an attribute, not just a style: the divider controller measures
      // what a column is actually rendering at (scan-columns.tsx), and needs to
      // find it without knowing this component's internals.
      data-area={area}
      style={{ gridArea: area }}
      className={cn("flex min-h-0 flex-col overflow-hidden", className)}
      {...props}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-3 py-2">
        <h2 className="text-label text-ink-soft uppercase">{label}</h2>
        {meta ? (
          <span className="tnum text-label text-ink-muted uppercase">{meta}</span>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </motion.section>
  );
}
