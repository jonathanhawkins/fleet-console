"use client";

import * as React from "react";
import { ConsoleButton } from "@/components/console";
import { clockTime } from "@/components/fleet/alert-lifecycle";
import { useFleetStore, useIncidentStore } from "@/lib/stores";
import { RecalibrateAction } from "./recalibrate";
import { RESTORED_GATE_NOTE, RESTORED_GATE_SUFFIX } from "./recalibrate-copy";
import { SafeSitAction } from "./safe-sit";
import {
  acknowledgedLabel,
  acknowledgedTime,
  executedKind,
  isPostureGatedRecommendation,
  markAcknowledged,
  POSTURE_GATE_NOTE,
  postureGateLabel,
  RECORDED_NOTE,
  splitRecommendations,
} from "./safe-sit-copy";

/**
 * The verdict's action rail: what the operator may do about the diagnosis,
 * which of those are gated, and why. Split from `VerdictCard` because it is
 * the only part of the card that talks to the fleet store and the command
 * path — everything above it only reads the report.
 */

/**
 * The recommendations, in the two groups they actually belong to.
 *
 * The order is deliberate and is not "the order the report listed them in":
 * EXECUTE first, because the operator descended into machine space to make a
 * broken robot safe and that is the control that does it, and RECORD second,
 * because filing is what you do once the thing is sitting down. The report's
 * own order survives *within* each group.
 *
 * ## The posture gate
 *
 * DISABLE JOINT is the one recorded action with a physical precondition:
 * disabling a load-bearing knee while the robot is standing on it drops the
 * robot. So while the unit's posture is anything but "sitting" the button is
 * inert — disabled, not hidden, because the report recommended it and a card
 * that hides a recommendation is editing the report — and its label carries
 * the reason as a suffix, the same idiom the recorded stamp uses.
 *
 * Posture is read live from the fleet store (a primitive subscription, so the
 * group re-renders only when the posture value itself moves). The gate lifts
 * without a remount: SAFE SIT completes, the settle beat's `unit_update` flips
 * posture to "sitting", and the same button enables in place. An unknown unit
 * gates closed — the schema reads absent posture as "walking", and a safety
 * gate fails safe.
 */
export function VerdictActions({
  unitId,
  startedAt,
  recommendations,
  acknowledged,
  anomaly,
  restored,
}: {
  unitId: string;
  /** The session's clock — the key the press times are filed under. */
  startedAt: number;
  recommendations: readonly string[];
  acknowledged: readonly string[];
  /**
   * What the scan concluded. Carried this far for one line of the
   * recalibration's confirmation — the sentence stating what a calibration
   * cannot fix, which is a fact about the diagnosis and not about the button.
   */
  anomaly: string;
  /**
   * The machine's re-measure said the channel came back.
   *
   * The receipts stay — they are the audit, and a console that tidied away the
   * proof of what it did to a robot would be worse than one that never showed
   * it. What goes is the *offer*: DISPATCH SERVICE and DISABLE JOINT are the
   * rungs above a calibration, and continuing to present them as live decisions
   * under a headline that says the fault is over is the card asking the operator
   * to send a van to a robot that is fine.
   *
   * Demoted rather than hidden, and that is the same ruling this group already
   * makes about the posture gate: the report recommended these, and a card that
   * removes a recommendation is editing the report. So they render inert, with
   * the reason on the label, exactly as a gated action does — the difference
   * being that this gate never lifts, which is the correct shape for a
   * precondition that is not a posture but a fault that no longer exists.
   */
  restored: boolean;
}) {
  const executeId = React.useId();
  const recordId = React.useId();
  const recordNoteId = React.useId();
  const gateNoteId = React.useId();
  const restoredNoteId = React.useId();
  const { execute, record } = React.useMemo(
    () => splitRecommendations(recommendations),
    [recommendations],
  );
  const seated = useFleetStore((s) => s.units[unitId]?.posture) === "sitting";
  const anyGated =
    !restored &&
    !seated &&
    record.some((a) => isPostureGatedRecommendation(a) && !acknowledged.includes(a));
  // The restored note outranks the posture note, and replaces it rather than
  // stacking with it: a posture gate on a robot with nothing wrong with it is a
  // true statement about a decision nobody is being asked to make.
  const anyRestored = restored && record.some((a) => !acknowledged.includes(a));

  return (
    <div className="flex flex-col gap-4">
      {execute.length > 0 ? (
        <div role="group" aria-labelledby={executeId} className="flex flex-col gap-2">
          {/* Full phosphor. This group has the board's brightest label because
              it is the only one on the card whose contents leave the console. */}
          <h3 id={executeId} className="text-label text-ink uppercase">
            Execute
          </h3>
          {execute.map((action) =>
            executedKind(action) === "recalibrate" ? (
              <RecalibrateAction
                key={action}
                unitId={unitId}
                action={action}
                anomaly={anomaly}
              />
            ) : (
              <SafeSitAction key={action} unitId={unitId} action={action} />
            ),
          )}
        </div>
      ) : null}

      {record.length > 0 ? (
        <div role="group" aria-labelledby={recordId} className="flex flex-col gap-2">
          <h3 id={recordId} className="text-label text-ink-muted uppercase">
            Record to incident
          </h3>
          <div className="flex flex-wrap gap-2">
            {record.map((action) => {
              const done = acknowledged.includes(action);
              const at = done ? acknowledgedTime(unitId, startedAt, action) : undefined;
              // A record that happened outranks either gate: "· recorded" is a
              // fact about the incident, and neither a posture nor a cleared
              // channel can un-happen it.
              const spent = !done && restored;
              const gated =
                !done && !spent && !seated && isPostureGatedRecommendation(action);
              return (
                <ConsoleButton
                  key={action}
                  size="sm"
                  variant="secondary"
                  // A record that happened is not an offer any more. Disabled
                  // rather than a live toggle, because there is nothing on the
                  // other side of a second press: the store ignores the repeat,
                  // and un-acknowledging is not a thing this console does.
                  // A gated action is disabled for the other reason: pressing
                  // it would file a recommendation whose precondition the
                  // robot's own body currently fails.
                  disabled={done || gated || spent}
                  aria-pressed={done}
                  // The caveat is the description of each of these controls,
                  // not a sentence floating under the card: ask any one of
                  // them what it does and it answers "records to the incident
                  // on return, no command sent". Printed once below, because
                  // printing it twice would be the same true line shouted at an
                  // operator who can see there are two buttons. A gated action
                  // is described by its gate instead — the more load-bearing
                  // fact while it holds.
                  aria-describedby={
                    spent ? restoredNoteId : gated ? gateNoteId : recordNoteId
                  }
                  className={done ? "tnum" : undefined}
                  onClick={() => {
                    useIncidentStore.getState().acknowledgeRecommendation(action);
                    // Ordered, not paired-by-luck: the store decides whether the
                    // press counted (verdict phase, not already acknowledged),
                    // and the clock is filed first-write-wins behind it, so the
                    // two can never disagree about when this happened.
                    markAcknowledged(unitId, startedAt, action);
                  }}
                >
                  {done
                    ? acknowledgedLabel(action, at === undefined ? null : clockTime(at))
                    : spent
                      ? `${action} · ${RESTORED_GATE_SUFFIX}`
                      : gated
                        ? postureGateLabel(action)
                        : action}
                </ConsoleButton>
              );
            })}
          </div>
          {anyRestored ? (
            <p id={restoredNoteId} className="text-label text-ink-muted uppercase">
              {RESTORED_GATE_NOTE}
            </p>
          ) : null}
          {anyGated ? (
            <p id={gateNoteId} className="text-label text-ink-muted uppercase">
              {POSTURE_GATE_NOTE}
            </p>
          ) : null}
          <p id={recordNoteId} className="text-label text-ink-muted uppercase">
            {RECORDED_NOTE}
          </p>
        </div>
      ) : null}
    </div>
  );
}
