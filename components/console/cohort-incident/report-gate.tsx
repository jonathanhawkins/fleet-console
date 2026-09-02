"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { type CohortArchive, type CohortIncident } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { cohortRef } from "../cohort-copy";
import { REPORT_ATTR, usePageLock } from "../report-page-lock";

/** The write-up, a chunk further out than the card; not warmed, it arrives under a press. */
const ReportSurface = dynamic(
  () => import("../cohort-report-surface").then((m) => m.CohortReportSurface),
  { ssr: false },
);

/** The incident's reference, pressable: one object on the card means one document. */
export function ReportReference({
  cohort,
  onOpen,
  ref,
}: {
  cohort: CohortIncident;
  onOpen: () => void;
  /** Where the keyboard lands when the incident's card leaves (CohortRecord). */
  ref?: React.Ref<HTMLButtonElement>;
}) {
  const reference = cohortRef(cohort.fw, cohort.detectedAt);
  return (
    <button
      ref={ref}
      type="button"
      data-slot="cohort-report-link"
      onClick={onOpen}
      aria-label={`Open fleet incident report ${reference}`}
      className={cn(
        "-mx-1 rounded-md px-1 tnum text-label tracking-normal text-ink-soft underline",
        "decoration-line-strong underline-offset-4",
        "transition-colors duration-[var(--dur-press)] ease-console",
        "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/70",
        "focus-visible:outline-none",
      )}
    >
      {reference}
    </button>
  );
}

/**
 * The document's gate. Portalled to the body, which is load-bearing: the
 * print rule hides every sibling of the report.
 */
export function CohortReportGate({
  cohort,
  archive,
  open,
  onClose,
}: {
  cohort: CohortIncident;
  /** The stores as they stood when this incident was filed; live while it is not. */
  archive?: CohortArchive;
  open: boolean;
  onClose: () => void;
}) {
  usePageLock(open, REPORT_ATTR);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <ReportSurface cohort={cohort} archive={archive} onClose={onClose} />,
    document.body,
  );
}
