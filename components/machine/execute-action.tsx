"use client";

import * as React from "react";
import { ConsoleButton } from "@/components/console";
import { type ExecutedCommand } from "@/lib/schema";
import {
  selectUnitCommand,
  selectUnitLiveCommand,
  useCommandStore,
  useIncidentStore,
  type UnitCommandState,
} from "@/lib/stores";
import { cn } from "@/lib/utils";
import { MachineControl } from "./machine-control";
import { commandFill, commandLine, EXECUTE_NOTE, type ImpactLine } from "./safe-sit-copy";

/**
 * The controls in this console that move a robot, and everything the operator
 * is owed on the way there and back.
 *
 * ## Why this is a separate file from the card
 *
 * The verdict card renders a conclusion. This renders a *maneuver* — a thing
 * with a confirmation, a wire round trip, narrated beats, refusals and a
 * receipt in the telemetry. Those are two different lifetimes on one surface,
 * and the second one also has to appear in the status rule at the bottom of the
 * instrument, where the card cannot reach.
 *
 * ## Why it is generic
 *
 * There were two ways to add RECALIBRATE JOINT beside SAFE SIT, and one of them
 * was to copy this file. The reason not to is not line count: it is that every
 * safety property below — ABORT takes initial focus, the two confirm controls
 * carry equal weight, Escape is stopped before it can ascend, focus never falls
 * to `<body>` when the confirmation unmounts — is a property of *commanding a
 * robot*, not a property of sitting one down. A copy is a place for exactly one
 * of those to be quietly dropped later.
 *
 * So the maneuver is the component and the command is data: a `ManeuverSpec`
 * says what to send, what it does to the unit, and what to call it. Everything
 * that protects the operator is written once.
 *
 * ## The state machine, and where each state lives
 *
 * ```
 * idle ──press──▶ confirming ──ABORT / Esc──▶ idle
 * confirming ──CONFIRM──▶ sent ──(the wire answers)──▶ store
 * store: pending ─▶ progress ─▶ complete · any ─▶ failed{reason}
 * complete / failed ──DISMISS──▶ idle
 * ```
 *
 * Only the middle band is shared state. `idle`, `confirming` and `sent` are
 * this component's, because they are things the console is doing; `pending`
 * onward is the command store's, because they are things the *machine* said.
 * The store README draws that line and this is the component it was drawn for.
 *
 * `sent` is the interesting one. It covers exactly one round trip — the gap
 * between the command leaving and `accepted` arriving — and it deliberately
 * shows no percentage, no bar and no motion. A progress indicator there would
 * be the console animating a maneuver that the unit has not yet agreed to
 * perform, which is the precise failure mode this whole lineage exists to
 * remove. It says SENT, because that is all that is true yet.
 */
export interface ManeuverSpec {
  /**
   * The wire command this control drives.
   *
   * Carried so the control can subscribe to *its own* lifecycle: the store
   * keys a unit's live commands by `(unitId, cmd)`, and this is the
   * half of that key the component brings. It was briefly one slot per unit
   * with the control filtering what came back, which is a narrower promise
   * than it sounds — a filter can decline to render another command's words
   * but it cannot un-drop the completion that command's refusal displaced.
   */
  cmd: ExecutedCommand;
  /** Send it. Returns false when there is no link — see `confirm` below. */
  send(unitId: string): boolean;
  /** The confirmation's headline, minus the unit it names. */
  confirmTitle: string;
  /** What this does to the robot, stated before it is ordered. */
  impact: readonly ImpactLine[];
  /** For tests and for the surface's own hooks. */
  slot: string;
}

export interface ExecuteActionProps {
  unitId: string;
  /**
   * The report's own wording for this recommendation. Printed on the button
   * and recorded against the incident on confirm, so the incident history says
   * the operator acted on *that* line of the report rather than on a string
   * this file made up.
   */
  action: string;
  spec: ManeuverSpec;
  /**
   * A physical precondition the unit currently fails, in the machine's own
   * status voice. The control renders inert and says why; it is not hidden,
   * because the report recommended it and a card that hides a recommendation is
   * editing the report.
   */
  gate?: { suffix: string; note: string } | null;
}

type LocalPhase = "idle" | "confirming" | "sent" | "nolink";

export function ExecuteAction({ unitId, action, spec, gate }: ExecuteActionProps) {
  const command = useCommandStore(selectUnitCommand(unitId, spec.cmd));
  const [local, setLocal] = React.useState<LocalPhase>("idle");
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  /**
   * The note under the control, when there is a reason it must be read with
   * the control: the gate while it holds, and "no link" the moment a command
   * failed to leave. One id because the two are alternatives — and because
   * that is the one path where focus comes back to an *enabled* trigger, so
   * without the association a keyboard operator would hear the button they
   * pressed and nothing about the robot they did not command.
   */
  const noteId = React.useId();
  /**
   * The one element that survives every state this group passes through.
   *
   * It is `tabIndex={-1}` and never in the tab order — it exists so that
   * confirming has somewhere to put the keyboard. CONFIRM unmounts the instant
   * it is pressed and what replaces it (a disabled button, then a status line)
   * holds nothing focusable, so without this the operator's focus falls to
   * `<body>` at the exact moment they commanded a robot. Focusing the region
   * instead keeps them standing on the thing that is about to narrate.
   */
  const regionRef = React.useRef<HTMLDivElement>(null);
  /** Focus has to come back from the confirmation, but only if it went there. */
  const returnFocus = React.useRef(false);

  // The machine has spoken: the store owns the display from here, and whatever
  // this component believed about the command is now history. Keyed on
  // presence rather than on the state object, which moves on every beat.
  const answered = command !== undefined;
  React.useEffect(() => {
    if (answered) setLocal("idle");
  }, [answered]);

  /**
   * The confirmation never hands the keyboard to nobody, whichever way it ends.
   *
   * Every exit from `confirming` unmounts the control focus is standing on, so
   * every one of them owes focus a destination. There are four, and only one
   * ends with the trigger able to take it:
   *
   * - ABORT / Escape → `idle`, trigger enabled: back to the control it replaced.
   * - CONFIRM → `sent`, and the trigger renders `disabled`.
   * - CONFIRM with no link → `nolink`: the trigger is live again (try later),
   * and the reason rides on it through `aria-describedby`.
   * - the gate closing underneath — a `unit_update` from a second console, a
   * sit commanded elsewhere, RESET_SIM rebuilding the units — → `idle` with
   * the trigger now `disabled` *because* it is gated.
   *
   * `HTMLElement.focus()` on a disabled button is a silent no-op, so an effect
   * that only ran for `idle` and only ever aimed at the trigger dropped the
   * operator onto `<body>` on three of those four — at the exact moment the
   * console owed them the outcome of a command aimed at a robot. So: every
   * phase but `confirming`, and the region as the fallback, which is what it is
   * `tabIndex={-1}` for. DISMISS is the same debt in the other direction — it
   * unmounts itself and the trigger returns in its place — which is why
   * `answered` is a dependency.
   */
  React.useEffect(() => {
    if (local === "confirming" || !returnFocus.current) return;
    returnFocus.current = false;
    const region = regionRef.current;
    // Focus that has left this group belongs to wherever it went: taking it
    // back would be this card pulling the keyboard off another panel. `<body>`
    // is not somewhere else — it is the failure being fixed.
    const active = document.activeElement;
    if (region && active !== null && active !== document.body && !region.contains(active))
      return;
    const trigger = triggerRef.current;
    (trigger && !trigger.disabled ? trigger : region)?.focus({ preventScroll: true });
  }, [local, answered]);

  // A gate that closes under a confirmation the operator is standing in takes
  // the confirmation with it: the precondition is no longer met, so the offer
  // is no longer one. Reachable in both directions — a `unit_update` seats the
  // robot under an open SAFE SIT confirm (a second console, a sit commanded
  // elsewhere), and RESET_SIM rebuilds the units at `walking` under an open
  // RECALIBRATE one — which is why the effect above has to answer for where
  // the keyboard goes when this fires.
  const gated = gate != null;
  React.useEffect(() => {
    if (gated) setLocal("idle");
  }, [gated]);

  const confirm = React.useCallback(() => {
    // Send first, record second. `send` returns false when there is no link,
    // and an incident that logs "operator commanded safe sit" for a command
    // that never left the building is the same lie in a slower form.
    //
    // Neither branch touches focus: both are exits from `confirming`, and where
    // focus goes on an exit is one decision, made once, in the effect above.
    // It was two, and the branch that had no answer was this one's early
    // return — the console losing the keyboard precisely when it had to tell a
    // keyboard operator that a robot command did not leave.
    if (!spec.send(unitId)) {
      setLocal("nolink");
      return;
    }
    useIncidentStore.getState().acknowledgeRecommendation(action);
    setLocal("sent");
  }, [unitId, action, spec]);

  const abort = React.useCallback(() => setLocal("idle"), []);

  const dismiss = React.useCallback(() => {
    // The trigger comes back where DISMISS stood, so the keyboard travels with
    // the control rather than falling off the end of the one being put away.
    returnFocus.current = true;
    useCommandStore.getState().dismissCommand(unitId, spec.cmd);
  }, [unitId, spec]);

  const confirming = local === "confirming";

  return (
    <div ref={regionRef} tabIndex={-1} className="outline-none">
      {command !== undefined ? (
        <CommandReadout state={command} onDismiss={dismiss} />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            {/* The trigger stays in the flow while its confirmation is open,
                disabled rather than unmounted. The confirmation used to take
                its place, and the swap moved every line under it by the
                difference in their heights — on the board that was the centre
                column scrolling to keep the gate in view, and the chassis
                elevation going half off screen for a question about the
                knee. A control that keeps its footprint costs the layout
                nothing in either direction, and a disabled control is also
                the honest state of a button whose press is being confirmed. */}
            <ConsoleButton
              ref={triggerRef}
              size="md"
              variant="secondary"
              disabled={confirming || local === "sent" || gated}
              aria-describedby={gate || local === "nolink" ? noteId : undefined}
              onClick={() => {
                returnFocus.current = true;
                setLocal("confirming");
              }}
            >
              {gate
                ? `${action} · ${gate.suffix}`
                : local === "sent"
                  ? `${action} · sent`
                  : action}
            </ConsoleButton>
            {local === "sent" ? (
              // No bar, no percentage, no spinner: see the note at the top of
              // the file. One phrase, and it is about the console, not the unit.
              <span className="text-label text-ink-muted uppercase">
                Awaiting unit response
              </span>
            ) : null}
          </div>
          {gate ? (
            // The gate outranks the group's standing note while it holds: it is
            // the more load-bearing fact about a control that cannot be pressed.
            <p id={noteId} className="text-label text-ink-muted uppercase">
              {gate.note}
            </p>
          ) : local === "nolink" ? (
            <p id={noteId} className="text-label text-alert uppercase">
              Not sent · no link to the unit
            </p>
          ) : (
            <p className="text-label text-ink-muted uppercase">{EXECUTE_NOTE}</p>
          )}
          {confirming ? (
            <ExecuteConfirm
              unitId={unitId}
              title={spec.confirmTitle}
              impact={spec.impact}
              slot={spec.slot}
              onConfirm={confirm}
              onAbort={abort}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The confirmation, and where it stands.
 *
 * Not a floating modal, and not because one was hard to build. Machine space is
 * an instrument: a slab that lifts off the board and drops a scrim over the
 * evidence would be the one object on this screen that behaves like a web page,
 * and it would cover the traces that justify the maneuver at the exact moment
 * the operator is deciding whether to perform it. So the board stays readable
 * behind nothing, and the block is the same 1px box in both places it appears.
 *
 * Where it stands differs, and the stylesheet decides (`.execute-confirm` in
 * app/styles/machine.css), because the two surfaces have opposite problems:
 *
 * - **In the board's centre column** it is pinned to the foot of the column,
 *   over the card, out of the flow. That column scrolls, and a gate that
 *   opened *in* the flow grew the card under the manifest and scrolled the
 *   column to keep itself in view — which pushed the chassis elevation half
 *   off screen for a question about the knee. Out of the flow, nothing above
 *   moves when it opens and nothing moves back when it closes: the manifest,
 *   the elevation and the leader line between them stay exactly where the
 *   operator was looking. It covers only the lower edge of the card — the
 *   filing controls and RETURN, which the focus trap has already taken off the
 *   table — and never the evidence in the other two columns.
 * - **In the phone's verdict sheet** there is no column to pin to and nothing
 *   above it to protect, so it stays in the flow under the control that opened
 *   it and asks the sheet's own scroller to bring it into view. The sheet is a
 *   transformed, scrolling surface that a `position: fixed` overlay would have
 *   to be fought into; a block in the flow needs no fighting.
 *
 * It is still a modal in every way that protects the operator: `alertdialog`,
 * `aria-modal`, a focus trap, Escape aborts, and the pointer cannot reach a
 * control it has not been offered because the two it offers are the only ones
 * focus can reach — including the trigger, which stays on screen but disabled
 * for as long as the gate is up.
 *
 * ## Safety decisions, deliberately
 *
 * - **Initial focus is ABORT.** A confirmation that opens with the dangerous
 * control focused is a confirmation that a second Return keystroke defeats,
 * and the operator who double-tapped Return is precisely the one it exists
 * to catch.
 * - **CONFIRM and ABORT carry the same weight.** No primary, no colour, two
 * identical 1px boxes. The console has no opinion about whether this robot
 * should sit down; it has an obligation to say what happens if it does.
 * - **Escape stops here.** The descent surface listens for Escape on the
 * window and treats it as "leave machine space", so an un-stopped Escape
 * would abort the confirmation *and* ascend. It is stopped on the way past.
 * - **No animation.** A safety gate that fades in has a window in which it is
 * visible and not yet real. This one is simply there, in both motion
 * preferences.
 */
export interface ExecuteConfirmProps {
  unitId: string;
  title: string;
  impact: readonly ImpactLine[];
  slot: string;
  onConfirm: () => void;
  onAbort: () => void;
}

export function ExecuteConfirm({
  unitId,
  title,
  impact,
  slot,
  onConfirm,
  onAbort,
}: ExecuteConfirmProps) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const abortRef = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const impactId = React.useId();

  React.useEffect(() => {
    abortRef.current?.focus({ preventScroll: true });
    // Only where the block is in the flow (the sheet) is there anything to
    // scroll: pinned to the column it is in view by construction, and asking
    // the column to scroll anyway is the jump this layout exists to remove.
    const box = boxRef.current;
    if (!box || getComputedStyle(box).position === "absolute") return;
    box.scrollIntoView?.({ block: "nearest", behavior: "auto" });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // Both halves matter: React's stopPropagation stops the *native* event
      // too, which is what keeps the surface's window-level Escape handler
      // from ascending out of machine space behind this.
      e.stopPropagation();
      onAbort();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = Array.from(
      boxRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    // Two controls, so the trap is a two-line wrap rather than a general
    // solution: forward off the last returns to the first, back off the first
    // returns to the last, and anything in between is the browser's business.
    if (!e.shiftKey && active === last) {
      e.preventDefault();
      e.stopPropagation();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      e.stopPropagation();
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
      data-slot={slot}
      onKeyDown={onKeyDown}
      // A 1px box on the void, and one luminance step of ground under it so the
      // gate is distinguishable from the card it interrupts without a shadow,
      // a radius or a scrim — none of which exist in this world. Where it
      // stands is `.execute-confirm`'s decision (see above).
      className="execute-confirm flex flex-col gap-3 border border-line-strong bg-surface p-3"
    >
      <h3 id={titleId} className="text-heading text-ink uppercase">
        {title} · Unit {unitId}
      </h3>

      {/* What it does to the robot, before it is done to the robot. */}
      <ul id={impactId} className="flex flex-col gap-1">
        {impact.map((line) => (
          <li
            key={line.text}
            className={cn(
              "flex items-baseline gap-2 text-small uppercase",
              line.tone === "warn" ? "text-warn" : "text-ink-soft",
            )}
          >
            {/* A square, not a bullet: machine space has no radius, anywhere. */}
            <span
              aria-hidden
              className={cn(
                "size-1 shrink-0 translate-y-[-0.15em]",
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
        <ConsoleButton ref={abortRef} size="md" variant="secondary" onClick={onAbort}>
          Abort
        </ConsoleButton>
        <span className="text-label text-ink-muted uppercase">Esc · abort</span>
      </div>
    </div>
  );
}

/**
 * The maneuver, as the machine reported it: one line and one rule.
 *
 * Every word comes from the wire — the notes are the sim's (`GAIT ARRESTED`,
 * `CROUCH PHASE`, `TORQUE RAMP-DOWN`, `POSTURE SETTLED`; `JOINT UNLOADED`,
 * `RANGE SWEEP 1/2`, `RANGE SWEEP 2/2`, `GAIN TABLE WRITTEN`) and the refusal
 * reasons are too. Nothing here interpolates, estimates or eases toward a
 * number the unit has not sent; the bar moves in the steps the machine
 * narrated, because that is how many things it actually told us.
 *
 * The completion beat is a statement, not a celebration. The receipt is not
 * this line — it is the torque strips on the unit page going flat, and the
 * re-measured trace on the card, which are things the operator can go and look
 * at.
 */
function CommandReadout({
  state,
  onDismiss,
}: {
  state: UnitCommandState;
  onDismiss: () => void;
}) {
  const terminal = state.phase === "complete" || state.phase === "failed";
  const failed = state.phase === "failed";
  const lineId = React.useId();
  const fill = commandFill(state);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p
          id={lineId}
          className={cn("tnum text-small uppercase", failed ? "text-alert" : "text-ink")}
        >
          {commandLine(state)}
        </p>
        {terminal ? (
          <MachineControl aria-describedby={lineId} onClick={onDismiss}>
            Dismiss
          </MachineControl>
        ) : null}
      </div>

      {/* The rule *is* the progress bar. A track and a phosphor segment, 1px
          tall, in a world whose entire hierarchy is luminance and rules — the
          same object the board already uses to divide panels, carrying a length
          the machine reported. It steps rather than eases: the transition is
          the micro token, so it collapses to nothing under reduced motion and
          never runs ahead of a beat. */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fill}
        aria-labelledby={lineId}
        className="h-px w-full bg-line"
      >
        <div
          className={cn(
            "h-px transition-[width] duration-[var(--dur-micro)] ease-console",
            failed ? "bg-alert" : "bg-ink",
          )}
          style={{ width: `${fill}%` }}
        />
      </div>
    </div>
  );
}

/**
 * The maneuver in flight, in the bottom rule — the one strip of chrome that is
 * on screen in every phase of machine space, including the ones where the
 * verdict card has been put down.
 *
 * This is the live region for whichever command the unit is running, and the
 * card deliberately is not. An operator can minimize the conclusion mid-sit; if
 * the announcement lived in the card it would leave with it, and a screen
 * reader would hear a maneuver start and never hear it finish. The rule
 * outlives every other surface here, so it is where the narration belongs.
 *
 * Command-agnostic by construction: it prints `commandLine` for whatever the
 * unit is doing, so a recalibration narrates itself here on the day it is added
 * without this component learning a second vocabulary. *Which* lifecycle that
 * is, when a unit has two on file, is the store's decision and not this
 * component's (`selectUnitLiveCommand`): a rule that picked for itself would be
 * a second opinion about what the robot is doing.
 *
 * Always mounted, empty when there is nothing to say: a live region that is
 * created with its text already in it is a live region screen readers are
 * entitled to ignore.
 */
export function CommandStatusLine({ unitId }: { unitId: string }) {
  const command = useCommandStore(selectUnitLiveCommand(unitId));
  return (
    <p
      aria-live="polite"
      data-slot="command-status"
      className={cn(
        "tnum text-label uppercase",
        command?.phase === "failed" ? "text-alert" : "text-ink",
      )}
    >
      {command ? commandLine(command) : null}
    </p>
  );
}
