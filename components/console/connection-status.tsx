import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The state of the telemetry link, stated once, quietly, in the header.
 *
 * Four states and no store: the transport and its zustand slice land in the
 * next wave, so this is a pure function of a prop and defaults to `idle`. When
 * the wiring arrives it passes `state={connection}` and nothing else changes.
 *
 * Colour lives in the dot, never in the word — an operator glancing at a
 * healthy fleet should register "green, fine" without reading anything. `lost`
 * is the one state allowed to colour its label, because it is the one state
 * that needs to interrupt a glance. `connecting` is the one state allowed
 * motion: a slow breathe, hand-authored in globals.css on the console's own
 * curve, because a dot that neither settles nor alarms is exactly what "in
 * progress" looks like.
 */
export const CONNECTION_STATES = ["idle", "connecting", "live", "lost"] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** Sentence case in the source, uppercased by the label type step (PRD §5). */
const COPY: Record<ConnectionState, string> = {
  idle: "Idle",
  connecting: "Connecting",
  live: "Live",
  lost: "Connection lost",
};

const DOT: Record<ConnectionState, string> = {
  // --muted as non-text decoration: 3.31:1 clears the 3:1 bar for a UI graphic
  idle: "bg-ink-muted",
  // connection-breathe, not animate-pulse: the stock pulse (2 s, a foreign
  // curve) was the only off-the-shelf motion in the product
  connecting: "bg-warn connection-breathe",
  live: "bg-nominal",
  lost: "bg-alert",
};

const LABEL: Record<ConnectionState, string> = {
  idle: "text-ink-soft",
  connecting: "text-ink-soft",
  live: "text-ink-soft",
  lost: "text-alert-ink",
};

export interface ConnectionStatusProps extends Omit<
  React.ComponentPropsWithoutRef<"span">,
  "children"
> {
  /** Defaults to `idle` — nothing has tried to connect yet. */
  state?: ConnectionState;
}

export function ConnectionStatus({
  className,
  state = "idle",
  ...props
}: ConnectionStatusProps) {
  return (
    <span
      data-slot="connection-status"
      data-state={state}
      // a live region: the transport can flip this under the operator, and a
      // connection dropping is exactly the kind of change that must be spoken
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-2 text-label uppercase",
        LABEL[state],
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        // rounded-pill, not rounded-full: the token squares it in machine space
        className={cn("size-1.5 shrink-0 rounded-pill", DOT[state])}
      />
      <span className="sr-only">Telemetry connection: </span>
      {COPY[state]}
    </span>
  );
}
