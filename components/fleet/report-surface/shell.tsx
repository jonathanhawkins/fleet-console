"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/components/console";

export interface ReportShellProps {
  /** Ids the letterhead's own `h1`; the surface is labelled by it. */
  titleId: string;
  onClose(): void;
  /** Distinguishes the two documents in the DOM and in tests. */
  scope: "unit" | "fleet";
  children: React.ReactNode;
}

/**
 * The document, as a modal surface over a locked page.
 *
 * `data-slot="incident-report"` is the print stylesheet's own hook (the
 * `[data-report="open"]` block in globals.css hides every sibling of it), so
 * both reports carry it — a fleet incident report is an incident report, and a
 * second selector for the second document would be one more thing to keep in
 * step with a rule nobody reads until a page prints wrong.
 */
export function ReportShell({ titleId, onClose, scope, children }: ReportShellProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  /* Escape and Close mean the same thing here — there is nothing to lose by
     leaving, the record is on file either way. */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Focus goes to the document and stays inside it, and returns to whatever
   * opened it — the incident id in the history, the linkage on a part card, or
   * the fleet incident's own reference. The same discipline as the descent
   * stage: a keyboard operator must not be able to tab into a page they cannot
   * see.
   */
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    root.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === root)
      ) {
        e.preventDefault();
        last.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, []);

  return (
    <motion.div
      ref={rootRef}
      data-slot="incident-report"
      data-scope={scope}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      // A document arriving, so: opacity only, no travel. The page it covers is
      // not going anywhere and a report that slid in would be claiming to be a
      // panel. One micro beat (PRD §5), collapsed to nothing under reduced
      // motion — where an instant swap is the correct reading of "no motion".
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduced ? 0 : 0.14, ease: "linear" }}
      className={cn(
        "fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-bg",
        "outline-none focus-visible:outline-none",
      )}
    >
      {/*
        A document measure, not a dashboard one.

        This started at 64rem — the width a console page is comfortable at — and
        it is the wrong unit of measure for the one surface in the product that
        is meant to leave the building. At 1024 px almost nothing here fills the
        line: a three-column comparison puts 350 px of white between a build and
        its own count, the rollback's per-unit offsets float half a page from the
        unit they belong to, and the differential runs past 110 characters, which
        is a paragraph an eye loses its place in.

        52rem is close to the measure this document already has on paper (A4 less
        the 16 mm margins is ~42rem), so the screen version is now recognisably
        the same object as the printed one instead of a stretched relative of it.
      */}
      <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12">
        {children}
      </div>
    </motion.div>
  );
}
