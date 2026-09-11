"use client";

import dynamic from "next/dynamic";
import { useIncidentStore, type IncidentState } from "@/lib/stores";

/**
 * The door to the calm diagnostic, and the reason it is a door rather than the
 * panel itself.
 *
 * The panel is a `next/dynamic` boundary: the drawing, the action rail and the
 * copy that goes with them are a few hundred lines that no unit page needs
 * until a scan is actually running, and the unit route sits close enough to its
 * 200 KB budget that shipping them in its initial JS would fail the build. So
 * this gate is what the page imports — a phase read and nothing else — and the
 * panel arrives with the scan.
 *
 * It is deliberately *not* preloaded from the banner's mount. The chunk is
 * needed a beat after the operator presses a button that is already on screen,
 * and `Run diagnostic` has a round trip to the sim in front of it; the descent
 * had to be warmed early because it took the whole page in 200 ms, and this
 * one does not take the page at all.
 */

const importPanel = () => import("./diagnostic/panel");

const DiagnosticPanel = dynamic(() => importPanel().then((m) => m.DiagnosticPanel), {
  ssr: false,
});

/** Any session at all, in any phase but idle — the panel narrows to its unit. */
const selectHasSession = (s: IncidentState): boolean =>
  s.phase !== "idle" || s.exiting !== null;

export function DiagnosticGate({ unitId }: { unitId: string }) {
  const live = useIncidentStore(selectHasSession);
  if (!live) return null;
  return <DiagnosticPanel unitId={unitId} />;
}
