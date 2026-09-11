"use client";

import * as React from "react";
import { ConsoleButton, SectionLabel } from "@/components/console";
import {
  EXECUTE_NOTE,
  POSTURE_GATE_NOTE,
  RECALIBRATE_RECOMMENDATION,
  RECORDED_NOTE,
  SIT_IMPACT,
  EXECUTED_RECOMMENDATION,
  isExecutedRecommendation,
  isPostureGatedRecommendation,
  splitRecommendations,
} from "@/lib/diagnostics/safe-sit-copy";
import { selectUnit, useFleetStore, useIncidentStore } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { commandRecalibrate, commandSafeSit } from "../telemetry-command";

/**
 * What the operator may do about the diagnosis, and which of those the robot
 * is currently in a fit state to be asked.
 *
 * The four recommendations are deliberately not the same kind of object, and
 * the whole design problem of this rail is keeping that legible in a language
 * whose default control is a soft pill. Two of them **reach the robot** and are
 * grouped under a heading that says so; two only **enter the incident record**
 * and are grouped under a heading that says that. Within each group the
 * report's own order survives, because the order is the sim's business.
 *
 * ## The gate is written on the control, not hidden behind it
 *
 * Disabling a load-bearing knee while the robot is standing on it drops the
 * robot, so `Disable joint` is inert until the unit is seated — and the reason
 * is printed beside the control, wired to it by `aria-describedby`, so the eye
 * and a screen reader get the same fact. Inert, never hidden: the report
 * recommended it, and a rail that hides a recommendation is editing the report.
 *
 * `Recalibrate joint` carries the same physical precondition and is gated the
 * same way, but it lives in the executing group because it is a command, not a
 * note.
 */

const GATE_REASON = "Requires a seated posture";

export interface ActionLadderProps {
  unitId: string;
  recommendations: readonly string[];
  acknowledged: readonly string[];
}

export function ActionLadder({
  unitId,
  recommendations,
  acknowledged,
}: ActionLadderProps) {
  const unit = useFleetStore(selectUnit(unitId));
  const seated = unit?.posture === "sitting";
  const { execute, record } = splitRecommendations(recommendations);
  const [confirming, setConfirming] = React.useState<string | null>(null);

  if (recommendations.length === 0) return null;

  const done = (action: string) => acknowledged.includes(action);

  /** The two commands that move a robot, and their preconditions. */
  const gateFor = (action: string): string | null => {
    if (isPostureGatedRecommendation(action) && !seated) return GATE_REASON;
    if (action === RECALIBRATE_RECOMMENDATION && !seated) return GATE_REASON;
    if (action === EXECUTED_RECOMMENDATION && seated)
      return "Unit is already in a seated hold";
    return null;
  };

  const send = (action: string) => {
    if (action === EXECUTED_RECOMMENDATION) commandSafeSit(unitId);
    else if (action === RECALIBRATE_RECOMMENDATION) commandRecalibrate(unitId);
    useIncidentStore.getState().acknowledgeRecommendation(action);
    setConfirming(null);
  };

  return (
    <div className="mt-5 flex flex-col gap-6 border-t border-line pt-5">
      {execute.length > 0 ? (
        <Group heading="Act on the unit" note={EXECUTE_NOTE}>
          {execute.map((action) => (
            <Row
              key={action}
              action={action}
              gate={gateFor(action)}
              done={done(action)}
              confirming={confirming === action}
              onRequest={() => setConfirming(action)}
              onCancel={() => setConfirming(null)}
              onConfirm={() => send(action)}
            />
          ))}
        </Group>
      ) : null}

      {record.length > 0 ? (
        <Group heading="Record to the incident" note={RECORDED_NOTE}>
          {record.map((action) => (
            <Row
              key={action}
              action={action}
              gate={gateFor(action)}
              done={done(action)}
              onRequest={() =>
                useIncidentStore.getState().acknowledgeRecommendation(action)
              }
            />
          ))}
        </Group>
      ) : null}
    </div>
  );
}

function Group({
  heading,
  note,
  children,
}: {
  heading: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionLabel as="h3">{heading}</SectionLabel>
        <p className="text-small text-ink-soft">{note}</p>
      </div>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

interface RowProps {
  action: string;
  gate: string | null;
  done: boolean;
  confirming?: boolean;
  onRequest: () => void;
  onCancel?: () => void;
  onConfirm?: () => void;
}

function Row({
  action,
  gate,
  done,
  confirming,
  onRequest,
  onCancel,
  onConfirm,
}: RowProps) {
  const reasonId = React.useId();
  const executes = isExecutedRecommendation(action);
  const blocked = gate !== null && !done;

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line bg-bg px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={cn("text-small text-ink", done && "text-ink-soft")}>
          {action}
        </span>
        {done ? (
          <SectionLabel as="span" className="text-nominal-ink">
            Recorded
          </SectionLabel>
        ) : (
          <ConsoleButton
            size="sm"
            // `danger`, not `primary`: the library keeps the one black pill for
            // the page's single primary action — which on this page is the
            // banner's — and reserves this variant for a control that reaches
            // the robot. Both of these do. It is quiet until hover on purpose;
            // a control that moves a robot should be distinct without inviting
            // the press. Filing goes quieter still, so the two groups read in
            // the order of their consequences.
            variant={executes ? "danger" : "ghost"}
            disabled={blocked}
            aria-describedby={blocked ? reasonId : undefined}
            onClick={onRequest}
          >
            {executes ? "Command" : "Record"}
          </ConsoleButton>
        )}
      </div>

      {blocked ? (
        // One sentence, not two. The load-bearing note already contains the
        // gate — saying "requires a seated posture · permitted only while
        // seated" is the panel stammering the one thing it means to state
        // plainly.
        <p id={reasonId} className="text-small text-warn-ink">
          {isPostureGatedRecommendation(action) ? POSTURE_GATE_NOTE : gate}
        </p>
      ) : null}

      {confirming && onConfirm && onCancel ? (
        <Confirm action={action} onCancel={onCancel} onConfirm={onConfirm} />
      ) : null}
    </li>
  );
}

/**
 * The gate in front of a command that moves a robot.
 *
 * No animation, deliberately: a safety gate that fades in has a window in
 * which it is visible and not yet real. It states what the maneuver costs
 * before it is ordered — including the line an operator is most likely to drop,
 * that a seated robot is safe rather than fixed — and it opens with the
 * non-destructive control focused, so a stray Return cancels rather than
 * commands.
 */
function Confirm({
  action,
  onCancel,
  onConfirm,
}: {
  action: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="mt-1 flex flex-col gap-3 rounded-md border border-line-strong bg-surface p-4"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <p id={titleId} className="text-small font-medium text-ink">
        {action}?
      </p>
      <ul className="flex flex-col gap-1">
        {SIT_IMPACT.map((line) => (
          <li
            key={line.text}
            className={cn(
              "text-small",
              line.tone === "warn" ? "text-warn-ink" : "text-ink-soft",
            )}
          >
            {line.text}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <ConsoleButton ref={cancelRef} size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </ConsoleButton>
        <ConsoleButton size="sm" variant="primary" onClick={onConfirm}>
          Confirm
        </ConsoleButton>
      </div>
    </div>
  );
}
