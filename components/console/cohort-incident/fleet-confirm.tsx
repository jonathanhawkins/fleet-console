"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { type ImpactLine } from "../cohort-copy";
import { ConsoleButton } from "../console-button";

interface FleetConfirmProps {
  title: string;
  impact: readonly ImpactLine[];
  onConfirm: () => void;
  onAbort: () => void;
}

/**
 * The confirmation, standing where the buttons stood rather than floating over
 * the evidence. Three invariants: initial focus is Cancel (a second Return
 * must not confirm), the two choices carry equal weight, and it does not
 * animate in either motion preference.
 */
export function FleetConfirm({ title, impact, onConfirm, onAbort }: FleetConfirmProps) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const impactId = React.useId();

  React.useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
    boxRef.current?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onAbort();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = Array.from(
      boxRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    }
  };

  return (
    <div
      ref={boxRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={impactId}
      data-slot="fleet-confirm"
      onKeyDown={onKeyDown}
      // Warm white stepping up out of the tinted ground: operator space has no
      // scrim or shadow to spend here.
      className="flex flex-col gap-4 rounded-lg border border-line-strong bg-bg p-4 sm:p-5"
    >
      <h3 id={titleId} className="text-heading text-ink">
        {title}
      </h3>

      <ul id={impactId} className="flex flex-col gap-1.5">
        {impact.map((line) => (
          <li
            key={line.text}
            className={cn(
              "flex items-baseline gap-2.5 text-small",
              line.tone === "warn" ? "text-warn-ink" : "text-ink-soft",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 translate-y-[-0.15em] rounded-full",
                line.tone === "warn" ? "bg-warn" : "bg-ink-muted",
              )}
            />
            {line.text}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <ConsoleButton size="md" variant="secondary" onClick={onConfirm}>
          Confirm
        </ConsoleButton>
        <ConsoleButton ref={cancelRef} size="md" variant="secondary" onClick={onAbort}>
          Cancel
        </ConsoleButton>
        <span className="text-label text-ink-soft uppercase">Esc · cancel</span>
      </div>
    </div>
  );
}
