"use client";

import * as React from "react";
import { ConsoleButton, ConsoleCard, warmMachineFont } from "@/components/console";
import { setDiagnosticView } from "@/lib/prefs/diagnostic-view";
import {
  selectShownPhase,
  selectShownSession,
  useFleetStore,
  useIncidentStore,
} from "@/lib/stores";
import { ActionLadder } from "./action-ladder";
import { ChannelColumn } from "./channel-column";
import { Finding } from "./finding";
import { ProgressHead } from "./progress-head";
import { StructureList } from "./structure-list";

/**
 * The diagnostic, in operator space.
 *
 * One card in a page that is already a column of labelled cards. It grows in
 * where it stands, it never covers anything, and it can be scrolled past — the
 * three properties the full-screen descent could not have. The scan that used
 * to take the page now happens *on* the page, next to the telemetry that
 * motivated it.
 *
 * ## It holds nothing the store does not
 *
 * Every fact here is read from the incident session: the walked nodes, the
 * measured channels, the flag, the verdict, the acknowledgements. There is no
 * local mirror of any of it, which is what lets an operator navigate away
 * mid-scan and come back to a panel that has kept up — and what lets the same
 * session be rendered simultaneously as this card and as the dark board, with
 * no possibility of the two disagreeing.
 *
 * That is also why the machine-view control here is a *preference*, not a mode:
 * it changes which projection is on screen, not what is being projected.
 */

export interface DiagnosticPanelProps {
  unitId: string;
}

export function DiagnosticPanel({ unitId }: DiagnosticPanelProps) {
  const session = useIncidentStore(selectShownSession);
  const phase = useIncidentStore(selectShownPhase);
  const connection = useFleetStore((s) => s.connection);

  // Another unit's scan is not this page's business, and neither is no scan.
  if (!session || session.unitId !== unitId || phase === "idle") return null;

  const report = session.report;
  const flagged = session.flag?.joint ?? null;
  const stalled = connection !== "open";

  return (
    <ConsoleCard
      label="Diagnostic"
      labelAs="h2"
      action={
        <ConsoleButton
          size="sm"
          /**
           * `secondary`, not the `ghost` this slot usually holds. Ghost is the
           * right weight for an in-place disclosure — the session log's Show,
           * the walk's own toggle — because those reveal a little more of the
           * card they sit on. This one replaces the surface, and it is the only
           * door to the other half of the product; drawn as bare text it reads
           * as a label and nobody presses it. A border is the whole fix.
           */
          variant="secondary"
          onPointerEnter={preloadMachineView}
          onFocus={preloadMachineView}
          onClick={() => {
            setDiagnosticView("machine");
            useIncidentStore.getState().watchSession();
          }}
        >
          Machine view
        </ConsoleButton>
      }
    >
      <ProgressHead session={session} stalled={stalled} />

      <ChannelColumn channels={session.channels} subject={flagged} />

      <StructureList session={session} />

      {report ? (
        <>
          <Finding report={report} channels={session.channels} />
          <ActionLadder
            unitId={unitId}
            recommendations={report.recommendations}
            acknowledged={session.acknowledged}
          />
          <div className="mt-5 flex justify-end border-t border-line pt-5">
            <ConsoleButton
              variant="secondary"
              onClick={() => useIncidentStore.getState().completeAscent()}
            >
              File incident
            </ConsoleButton>
          </div>
        </>
      ) : null}
    </ConsoleCard>
  );
}

/**
 * Warm the machine chunk from the control that opens it, rather than from the
 * banner's mount. With machine space opt-in and off by default, fetching 56 KB
 * of it on every troubled unit page is paying for a surface most operators
 * will never open — but an operator whose pointer is on the button is about to.
 */
let warmed: Promise<unknown> | null = null;
function preloadMachineView(): void {
  warmed ??= import("@/components/machine/descent-stage");
  warmMachineFont();
}
