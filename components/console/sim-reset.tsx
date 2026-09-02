"use client";

import * as React from "react";
import { resetStatusHistory } from "./status-history";
import { sendCommand } from "./telemetry-command";
import { useIncidentStore } from "@/lib/stores";
import { cn } from "@/lib/utils";

/**
 * Put the storyline back to the beginning.
 *
 * This app is a demo and says so on every page, and re-runnability is a feature
 * of a demo rather than a debug affordance hidden behind an env flag (CLAUDE.md
 * non-negotiable #6). Someone reviewing it will want to watch the incident a
 * second time, and the alternative to a button is telling them to restart a
 * server — which, on the deployed static build where the simulator lives in a
 * Web Worker, is not a thing they can do at all.
 *
 * So it ships in both builds, and it is quiet rather than hidden: sentence
 * case, muted, sitting beside the disclaimer where the other honesty about this
 * being a simulation already lives. It is the least prominent interactive thing
 * in the product, which is exactly its rank.
 *
 * **Both halves of the reset.** RESET_SIM restarts the sim's storyline and
 * broadcasts a fresh snapshot, which clears the fleet store's alerts and
 * statuses. It cannot clear what only the client knows: the incident history
 * written by `completeAscent()`, and the status-timeline recorder's spans. A
 * reset that replayed the incident while last run's verdict still sat in the
 * unit's history would leave the console showing two of everything by the third
 * pass.
 */

export interface SimResetProps {
  className?: string;
}

export function SimReset({ className }: SimResetProps) {
  const [pending, setPending] = React.useState(false);

  const reset = React.useCallback(() => {
    if (!sendCommand({ c: "RESET_SIM" })) return;
    // Local state the wire does not own. Order matters only in that both must
    // happen; the snapshot that comes back handles everything else.
    useIncidentStore.getState().reset();
    resetStatusHistory();
    setPending(true);
    window.setTimeout(() => setPending(false), 1200);
  }, []);

  return (
    <button
      type="button"
      onClick={reset}
      data-slot="sim-reset"
      className={cn(
        "rounded-sm text-small text-ink-soft underline-offset-4",
        "transition-colors duration-[var(--dur-micro)] ease-console",
        // A text control has no box to compress, so the press is the hover
        // treatment arriving on pointer-down — which is the only feedback a
        // phone, where hover never happens, would otherwise get.
        "hover:text-ink hover:underline",
        "active:text-ink active:underline",
        className,
      )}
    >
      {pending ? "Simulation reset" : "Reset simulation"}
    </button>
  );
}
