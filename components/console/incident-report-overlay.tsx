"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { useShallow } from "zustand/react/shallow";
import { selectUnitHistory, useIncidentStore } from "@/lib/stores";
import {
  closeIncidentReport,
  incidentReportSnapshot,
  subscribeIncidentReport,
} from "./incident-report";
import { REPORT_ATTR, usePageLock } from "./report-page-lock";

/**
 * The door onto the incident report — a gate, like the descent's: on the unit
 * page for the whole session, rendering nothing until an operator asks.
 * Everything the document needs rides the archived record itself —
 * `completeAscent()` files the channels and the session clock on
 * `IncidentRecord` — so the report can be written by a console that never
 * watched the scan, and the gate's whole job is the door.
 *
 * **The document itself is a separate chunk.** The report pulls in the scan's
 * waveform math, the machine's copy tables and a page's worth of layout to
 * render something an operator opens occasionally and never on first paint.
 * Both routes sit within 11 KB gz of the PRD's 200 KB budget, and a document
 * nobody has asked for yet has no business spending that. `next/dynamic` puts
 * it behind the first open; what stays in the initial payload is this gate and
 * the small module beside it.
 *
 * Portalled to the body rather than rendered in the page's column, for the same
 * reason the descent is: the surface covers the header and footer this route
 * does not own, and — uniquely here — the print stylesheet needs the report to
 * be a direct child of `<body>` so everything that is *not* the report can be
 * hidden by one rule (app/globals.css, `[data-report="open"]`).
 *
 * The gate is `incident-report-overlay.tsx` and the pure module beside it is
 * `incident-report.ts`, deliberately not both called the same thing with
 * different extensions: `./incident-report` resolves to the `.ts` first, and a
 * component that can only be reached by writing its extension is a trap.
 */

const ReportSurface = dynamic(
  () => import("./incident-report-surface").then((m) => m.IncidentReportSurface),
  { ssr: false },
);

/**
 * Marks the document root while a report is open; see the print block in
 * globals.css. Defined with the page lock it belongs to (report-page-lock.ts)
 * now that three surfaces raise that lock, and re-exported here because this
 * gate is where the attribute has always been named from.
 */
export { REPORT_ATTR } from "./report-page-lock";

export interface IncidentReportProps {
  /** Only this unit's records open here. */
  unitId: string;
}

export function IncidentReport({ unitId }: IncidentReportProps) {
  const openId = React.useSyncExternalStore(
    subscribeIncidentReport,
    incidentReportSnapshot,
    () => null,
  );
  const history = useIncidentStore(useShallow(selectUnitHistory(unitId)));
  const record = openId === null ? undefined : history.find((r) => r.id === openId);

  /**
   * The page underneath is locked while the document is over it, and the gutter
   * the scrollbar leaves is paid back as padding so the page does not shift
   * sideways behind a surface that covers it.
   *
   * Counted rather than copied (report-page-lock.ts): this gate and the descent
   * are BOTH mounted on this route for the whole session, a `scan_start` on the
   * wire opens the descent with no operator action, and two uncounted locks
   * hand the page back over each other's heads.
   */
  usePageLock(record !== undefined, REPORT_ATTR);

  /**
   * An id that no longer names a record — a sim reset cleared the history while
   * the report was open — closes rather than rendering an empty document.
   */
  React.useEffect(() => {
    if (openId !== null && history.length > 0 && !record) closeIncidentReport();
  }, [openId, history.length, record]);

  if (!record) return null;

  return createPortal(
    <ReportSurface record={record} onClose={closeIncidentReport} />,
    document.body,
  );
}
