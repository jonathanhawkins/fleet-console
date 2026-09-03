"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ConsoleButton, JOINTS } from "@/components/console";
import { clockTime } from "@/components/fleet/alert-lifecycle";
import { type VerdictReport } from "@/lib/schema";
import {
  useFleetStore,
  useIncidentStore,
  type DiagChannel,
  type DiagSession,
} from "@/lib/stores";
import { cn } from "@/lib/utils";
import { useBoot } from "./boot-variants";
import { EvidenceTrace } from "./evidence-trace";
import { MachineControl } from "./machine-control";
import { RecalibrateAction } from "./recalibrate";
import {
  calibrationAmendment,
  calibrationSummary,
  isRestored,
  residualDifferential,
  residualReading,
  RESTORED_GATE_NOTE,
  RESTORED_GATE_SUFFIX,
  SCAN_TENSE_LABEL,
  type CalibrationOutcome,
} from "./recalibrate-copy";
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
import {
  anomalyDifferential,
  machineComponent,
  machineJoint,
  VERDICT_CHIP_HEAD,
  verdictChipDetail,
  verdictChipLabel,
} from "./scan-copy";

/**
 * What the scan concluded, and what the operator can do about it.
 *
 * The card lands in the centre column under the manifest — the space the board
 * has been leaving empty all scan — because that is where the eye already is
 * when the last chip flips, and because the conclusion belongs directly beneath
 * the evidence that produced it rather than floating over it in a modal. The
 * board, the traces and the log all stay on screen behind their own headers;
 * nothing that justified this verdict is hidden by it.
 *
 * ## Some of the actions are real
 *
 * The card used to carry one line under all four recommendations — "actions
 * are recorded to the incident; no command is sent to the unit" — which was
 * true of all of them and, once the sim learned to execute SAFE SIT, true of
 * three. A blanket caveat that is mostly right is worse than no caveat: it made
 * COMMAND SAFE SIT look like the paperwork its neighbours were, at the exact
 * moment it stopped being paperwork.
 *
 * So the recommendations are split by what pressing them does, and the split is
 * data rather than layout (safe-sit-copy.ts). EXECUTE holds the two that reach
 * the robot — COMMAND SAFE SIT and, RECALIBRATE JOINT — each
 * behind a confirmation that states the consequences, each narrating itself
 * from the wire afterwards. RECORD TO INCIDENT holds the two that enter the
 * incident record and go no further, and carries the caveat that is now true of
 * exactly the actions it sits under. The groups are separated by luminance, the
 * way everything on this board is: the group that acts is labelled in full
 * phosphor, the group that files is labelled dim.
 *
 * ## The order in EXECUTE is a procedure
 *
 * RECALIBRATE leads it because the report leads with it, and it is inert until
 * the unit is seated — which the control below it is what produces. Sit the
 * robot down, then work on it: two buttons that used to be neighbours are now
 * a sequence, and the card says so by leaving the first one visibly waiting on
 * the second.
 *
 * ## Minimize is not close
 *
 * The card lands in the middle of the evidence that produced it, and the centre
 * column is the one surface it does cover. So it can be put down: MINIMIZE
 * collapses it to a single line in the status bar (`VerdictStrip`), the board
 * comes back, and the log and the sweep — which were never covered — are now
 * browsable next to a conclusion that is still on file.
 *
 * It goes the way it came. The card used to arrive on a fade and leave by being
 * dropped out of the tree — the one direction of a two-direction gesture that
 * was animated — which made MINIMIZE read as the conclusion being deleted
 * rather than put down. It now fades out over the same beat it faded in on
 * (`boot.verdict`, so both halves are the board's own clock), and the strip it
 * becomes is already in the status rule when it goes.
 *
 * That state is deliberately *not* in the incident store. Minimizing is something
 * the operator did to this console's view; it is not something that happened to
 * the diagnostic, so it does not belong in the record the unit page reads, does
 * not survive a reload, and cannot leave a session archived as "seen" because
 * someone tidied a panel away. Reload mid-verdict and the conclusion is in front
 * of you again, which is the correct answer to "what did the scan find".
 *
 * RETURN TO CONSOLE stays the single exit either way, and the strip carries its
 * own RETURN precisely so that minimizing never puts the way out further away
 * than it was.
 */

/** The healthy joint to show beside the failing one: its opposite number. */
export function pairJoint(joint: string): string | null {
  const flip = joint.endsWith("_L")
    ? `${joint.slice(0, -2)}_R`
    : joint.endsWith("_R")
      ? `${joint.slice(0, -2)}_L`
      : null;
  return flip && (JOINTS as readonly string[]).includes(flip) ? flip : null;
}

export interface VerdictCardProps {
  session: DiagSession;
  /** Put the card down. Omitted where there is nowhere for it to go. */
  onMinimize?: () => void;
  /**
   * Where the card is standing.
   *
   * `inline` is the board: the conclusion arrives *under* the manifest, with a
   * rule above it saying so, in a column that is already holding evidence.
   * `sheet` is the phone: there is no column to arrive in, so the card is the
   * whole scrolling body between the session header and the status line, and
   * the rule it would draw for itself is already drawn by the header above.
   * The only other difference is where RETURN lives — see below.
   */
  surface?: "inline" | "sheet";
}

export function VerdictCard({
  session,
  onMinimize,
  surface = "inline",
}: VerdictCardProps) {
  const sheet = surface === "sheet";
  const boot = useBoot();
  const report = session.report;
  const acknowledged = session.acknowledged;

  /**
   * Focus lands on the verdict itself, not on RETURN.
   *
   * This is the payload of the whole demo, and a screen reader that autofocuses
   * RETURN on arrival never hears it: "Return to console, button" is the entire
   * announcement, and the finding underneath it goes unread until someone tabs
   * backward to find it. The section carries the finding as its accessible name
   * (aria-labelledby below), so focusing *it* is what makes a screen reader say
   * the joint, the part and the anomaly the instant the verdict lands — RETURN
   * stays one control away, reached by Tab exactly as every other control on
   * the card is.
   *
   * `preventScroll: true` is unchanged from the control it replaced: the card
   * arrives beneath the board and the headline must stay where it landed, not
   * be scrolled to.
   */
  const sectionRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    sectionRef.current?.focus({ preventScroll: true });
  }, []);

  const subject = React.useMemo(
    () => session.channels.find((c) => c.joint === report?.joint) ?? null,
    [session.channels, report?.joint],
  );
  const control = React.useMemo(() => {
    const pair = report?.joint ? pairJoint(report.joint) : null;
    return pair ? (session.channels.find((c) => c.joint === pair) ?? null) : null;
  }, [session.channels, report?.joint]);

  /**
   * The board's register.
   *
   * `clean` is a scan that found nothing; `restored` is a scan that found
   * something and then watched the machine's own re-measure put it back inside
   * the envelope. They are not the same finding and they do not read the same:
   * a clean scan never had an anomaly to name, and this one still names the
   * one it found — in the past tense, in phosphor, with the alert gone.
   *
   * One flag, read here and passed down, rather than six components each
   * asking the calibration what its outcome was. Every surface below changes
   * *together* or the card is telling two stories at once, which is exactly
   * what it was doing when a cleared result was a single line of small type
   * under a headline still shouting in red.
   */
  const restored = isRestored(session.calibration);

  /**
   * The one-shot acknowledgement plays for the event, not for the card.
   *
   * A sweep that ran every time the conclusion was picked back up would be the
   * console reporting, a minute later and in the present tense, something that
   * happened once. So it is armed only when the card was already mounted and
   * still un-restored at the moment the re-measure landed — which is the only
   * moment there is anything to acknowledge.
   */
  const restoredAtMount = React.useRef(restored);
  const sweep = restored && !restoredAtMount.current;

  if (!report) return null;

  const clean = report.anomaly === "none";

  return (
    <motion.section
      // A single fade, no slide, in both directions: the card is a *conclusion
      // arriving*, and the only thing in machine space allowed a bigger gesture
      // than that is the flag beat, whose contrast this would spend. The timing
      // is the board's own (boot-variants.tsx) rather than a number typed here,
      // so the conclusion resolves at the speed everything else on this
      // instrument resolved at — and collapses to the reduced timeline with the
      // rest of it.
      variants={boot.verdict}
      initial="hidden"
      animate="shown"
      exit="gone"
      ref={sectionRef}
      tabIndex={-1}
      // The section's own accessible name, not just the headline's: a clean
      // scan's headline already says the whole finding ("No anomaly
      // detected"), but a faulted one splits the finding across two lines —
      // the headline names the joint and the part, the line under it names
      // the anomaly and, once a recalibration has answered it, the cleared or
      // partial outcome. Both id'd elements together are what a screen reader
      // reports the instant focus lands here.
      aria-labelledby={clean ? "verdict-headline" : "verdict-headline verdict-anomaly"}
      // The outcome, on the card itself, so the register the operator reads is
      // the register a test (and the stylesheet) can ask about by name.
      data-slot="verdict-card"
      data-outcome={session.calibration?.outcome}
      className={cn(
        "flex flex-col gap-4",
        // One luminance wash, left to right, once. It is the only motion this
        // card spends on the result, and it is deliberately the cheapest kind:
        // no travel, no scale, no bounce — a board that congratulated itself
        // would stop being an instrument. Under reduced motion the global
        // clamp collapses it to nothing and the card is simply already green,
        // which is the whole message anyway (app/styles/machine.css).
        sweep && "verdict-resolve-sweep",
        sheet ? "min-h-full px-4 pt-4" : "mt-4 border-t border-line-strong pt-4",
      )}
    >
      {/* On a sheet the header is also the handle.
          A drag has to start somewhere it cannot be mistaken for a scroll, and
          the honest place is the top of the surface — the same place a hand
          reaches for on any sheet on any platform. It is not *drawn* as a
          handle: machine space has no grabber pill to draw and a 1px board does
          not grow one, so the affordance is that the whole block moves with the
          finger the instant it is pushed, and that MINIMIZE is already sitting
          in it. Everything below stays the scroller's, because reading the
          conclusion is the more important gesture on this surface and native
          scrolling beats anything hand-rolled (see verdict-sheet.tsx). */}
      <header data-sheet-grab={sheet || undefined} className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-4">
          {/* The label carries the outcome the moment there is one. It is the
              first line of the card in reading order, and after a clear it is
              the first place the eye can be told that the thing below it is
              over rather than ongoing. */}
          <span className="text-label text-ink-muted uppercase">
            Verdict{restored ? " · cleared" : null}
          </span>
          {onMinimize ? (
            // A square, and one glyph inside it. The underscore is the only
            // mark in the mono set that already means "put this down" and it
            // sits on the baseline — low in its box, pointing at the status
            // line the card is about to become. No icon, because machine space
            // does not draw; it prints.
            <MachineControl
              aria-label="Minimize verdict"
              onClick={onMinimize}
              className="size-6 px-0 leading-none"
            >
              _
            </MachineControl>
          ) : null}
        </div>
        {/* The loudest thing in machine space, by construction.

            Display, the top of the machine scale, and the only element on
            this surface set at that size; the anomaly line under it at title,
            one step below. Both lines used to sit a step lower (title and
            heading), which on a board whose every other line is a 10px label
            read as one more line of furniture: the operator found the verdict
            by its colour, not its weight. The size is what makes the answer
            to "what did the scan find" the first thing a glance lands on; the
            colour is the second, and it is spent on the two lines that ARE
            the finding — the part, then the kind of wrong, both at the alert
            token's full luminance. Nothing else on the card is allowed
            either: the differential, the summary, the evidence and the
            controls all sit lower on the scale and dimmer on the ladder,
            because they qualify the verdict rather than state it.

            A clean scan spends neither the colour nor the second line — one
            phosphor line, still at display size, because "nothing is wrong"
            is a finding too and deserves to be read as one.

            And a *restored* channel spends the size without the colour. The
            part is still named — ANKLE_R · ACTUATOR A-12 is what the scan
            found and a headline that erased it would be a diagnosis with no
            history — but the alert is gone from it, because there is no longer
            an alert. This is the single largest thing on the surface changing
            hue, which is what makes the result legible in the first glance
            rather than in the third line of the fourth paragraph. */}
        <h2
          id="verdict-headline"
          className={cn(
            "text-display uppercase",
            clean ? "text-ink" : restored ? "text-nominal" : "text-alert",
          )}
        >
          {clean
            ? "No anomaly detected"
            : `${machineJoint(report.joint)} · ${machineComponent(report.component)}`}
        </h2>
        {clean ? null : (
          /* The finding, and — once a calibration has answered it — the
             outcome, on one line at one size.

             The outcome word rides here rather than on a line of its own
             because "what kind of wrong" and "is it still wrong" are one
             question, and the operator asks it in one glance. The two halves
             are toned separately and that asymmetry is the whole point:
             CLEARED puts the entire line into phosphor, because nothing about
             it is a warning any more; PARTIAL leaves the anomaly in alert and
             prints itself in amber beside it, because a fault that is still
             there and a correction that did not finish are two facts and the
             card owes both. */
          <p
            id="verdict-anomaly"
            data-slot="verdict-anomaly"
            className={cn(
              "text-title uppercase",
              restored ? "text-nominal" : "text-alert",
            )}
          >
            {report.anomaly} anomaly
            {session.calibration ? (
              <span className={restored ? undefined : "text-warn"}>
                {" · "}
                {session.calibration.outcome}
              </span>
            ) : null}
          </p>
        )}
        {/* The differential: what produces this signature, one dim
            line under the anomaly it qualifies. The scan measured a trace; it
            did not open the knee, and the headline must not read as if it had.
            Absent on a clean scan — and for any anomaly the table has no
            differential for — because the machine does not improvise. */}
        {clean ? null : (
          <VerdictDifferential
            anomaly={report.anomaly}
            calibration={session.calibration}
            channels={session.channels}
          />
        )}
        {/* The report's own words, in the voice they were written in. This is
            the one place the machine's summary is shown verbatim — the operator
            page translates the same facts into its own sentence rather than
            shouting this one across a warm-white banner. */}
        <VerdictSummary
          summary={report.summary}
          anomaly={report.anomaly}
          calibration={session.calibration}
          channels={session.channels}
        />
      </header>

      {subject ? (
        <div className="flex flex-wrap gap-3">
          <EvidenceTrace
            joint={subject.joint}
            wave={subject.wave}
            ref={subject.ref}
            subject
            // The re-measure only belongs on the joint it re-measured. A
            // calibration of some other joint (nothing produces one today) must
            // not redraw this exhibit, because the trace under a figure has to
            // be a measurement OF that figure's channel.
            post={
              session.calibration?.joint === subject.joint
                ? session.calibration.wave
                : undefined
            }
            className="min-w-[15rem] flex-1"
          />
          {control ? (
            <EvidenceTrace
              joint={control.joint}
              wave={control.wave}
              ref={control.ref}
              className="min-w-[15rem] flex-1"
            />
          ) : null}
        </div>
      ) : null}

      {/* A clean scan's one recommendation is "No action required", and a
          *button* that says so is a decision offered where there is no
          decision — press it and the incident record grows a line reading
          "acknowledged: no action required", which is the console
          manufacturing paperwork out of a robot being fine. The report's
          field is still printed, because the card renders the report; it is
          printed as the statement it is, under the label it came with, and
          nothing here is split into what executes and what files because
          nothing here does either. */}
      {clean ? (
        <div className="flex flex-col gap-2">
          <span className="text-label text-ink-muted uppercase">Recommended actions</span>
          <p className="text-small text-ink-soft uppercase">
            {report.recommendations.join(" · ")}
          </p>
        </div>
      ) : (
        <VerdictActions
          unitId={session.unitId}
          startedAt={session.startedAt}
          recommendations={report.recommendations}
          acknowledged={acknowledged}
          anomaly={report.anomaly}
          restored={restored}
        />
      )}

      {/* The way out.
          On the board it is a row at the foot of the card, where the reading
          order has just finished. On a phone it is pinned: there is no Escape
          key, so RETURN is the *only* exit, and an only exit that can be
          scrolled off the bottom of a two-screen conclusion is not one.
          `mt-auto` for a short sheet, `sticky` for a tall one — between them the
          block sits on the bottom edge in every case.

          From 48rem the pinning is dropped and the row goes back to being a row.
          The sheet still runs the height of the instrument there, but the
          conclusion no longer fills it — and a full-bleed slab held against the
          bottom edge with 500px of void above it reads as a layout that broke,
          not as an exit that is always in the same place. A tablet also has the
          Escape key the phone does not, so the pinned copy is not carrying the
          only way out at that width. */}
      <div
        className={cn(
          "flex items-center gap-4 border-t border-line pt-3",
          sheet &&
            "sticky bottom-0 -mx-4 mt-auto flex-col items-stretch gap-2 bg-bg px-4 pb-4",
          sheet && "md:static md:mt-2 md:flex-row md:items-center md:gap-4 md:pb-0",
        )}
      >
        <ConsoleButton
          size="md"
          variant="primary"
          className={sheet ? "w-full md:w-auto" : undefined}
          onClick={() => useIncidentStore.getState().completeAscent()}
        >
          Return to console
        </ConsoleButton>
        <span className="text-label text-ink-muted uppercase">
          {/* A phone has no Escape key to mention. The handler is still there
              for the tablet with a keyboard on it; the hint is not. */}
          <span className="hidden md:inline">Esc · </span>incident is logged on return
        </span>
      </div>
    </motion.section>
  );
}

/**
 * The machine's own prose, and its tense.
 *
 * One paragraph until a calibration clears the fault, and two afterwards, and
 * the second one is the whole reason this is a component rather than a line of
 * JSX. `report.summary` is written in the present — "LIVE TRACE DISPLACED 0.21
 * FROM REFERENCE DATUM" — because when the scanner wrote it the trace was
 * displaced by 0.21. After a cleared re-measure it is displaced by 0.012, and
 * that sentence left standing on its own is the most misleading thing on the
 * card: the machine's own words, in the present tense, about a measurement that
 * has been superseded.
 *
 * It is not rewritten and it is not dropped. It is *dated* — labelled AT SCAN
 * and dropped one luminance tier — and the sentence that is true now is printed
 * under it at full phosphor. The scan's finding stays on the record where a
 * reader can see what the calibration was measured against; what changes is
 * which of the two lines the card is asserting.
 *
 * A partial result gets neither treatment. The report's summary is still an
 * accurate description of that channel — the trace really is still off its
 * reference — so there is nothing to date and nothing to add.
 */
function VerdictSummary({
  summary,
  anomaly,
  calibration,
  channels,
}: {
  summary: string;
  anomaly: string;
  calibration: DiagSession["calibration"];
  channels: readonly DiagChannel[];
}) {
  // The same measurement the amendment and the trace's own footer print, from
  // the same two arrays: three sentences about one number, one number.
  const after = React.useMemo(() => {
    if (!calibration) return null;
    const ref = channels.find((c) => c.joint === calibration.joint)?.ref;
    if (!ref) return null;
    return calibrationSummary(
      calibration.outcome,
      residualReading(anomaly, calibration.wave, ref),
    );
  }, [anomaly, calibration, channels]);

  if (!after) {
    return <p className="mt-1 max-w-[52ch] text-small text-ink-soft">{summary}</p>;
  }

  return (
    <div className="mt-1 flex max-w-[52ch] flex-col gap-1">
      <p className="text-small text-ink-muted">
        {/* The date stamp is a label, not a sentence: it is the same 10px
            wide-tracked idiom every other piece of metadata on this board
            wears, so it reads as a marker on the line rather than as the first
            words of it. */}
        <span className="text-label uppercase">{SCAN_TENSE_LABEL} · </span>
        {summary}
      </p>
      <p className="text-small text-ink">{after}</p>
    </div>
  );
}

/**
 * The differential, and — once the cheapest rung has been tried — what the
 * attempt was worth.
 *
 * Its own component so the header's subscription surface stays exactly what it
 * renders: a null differential mounts nothing at all.
 *
 * ## Why the conclusion amends rather than moves
 *
 * The headline still says KNEE_L · ACTUATOR A-07 · GAIN ANOMALY after a partial
 * calibration, because that is still what the scan found and a verdict that
 * rewrote itself on a treatment would be a diagnosis with no history. What
 * changes is what is left: the correctable cause has now been corrected and the
 * trace did not come back, so GAIN DRIFT leaves the differential and what
 * remains is mechanical. That is the sentence that makes DISPATCH SERVICE the
 * conclusion of an argument instead of the third button on a card.
 *
 * The residual is measured here by the same function the trace's own footer
 * measures with, from the same two arrays. Two sentences about one measurement,
 * one measurement.
 */
function VerdictDifferential({
  anomaly,
  calibration,
  channels,
}: {
  anomaly: string;
  calibration: DiagSession["calibration"];
  channels: readonly DiagChannel[];
}) {
  const differential = anomalyDifferential(anomaly);
  const residual = React.useMemo(() => {
    if (!calibration) return null;
    const ref = channels.find((c) => c.joint === calibration.joint)?.ref;
    return ref ? residualReading(anomaly, calibration.wave, ref) : null;
  }, [anomaly, calibration, channels]);

  if (!differential && !calibration) return null;
  const cleared = isRestored(calibration);
  return (
    <>
      {differential ? (
        <p className="text-label text-ink-soft uppercase">{differential}</p>
      ) : null}
      {calibration && residual !== null ? (
        <>
          {/* Warn on a partial, and it is the only colour this block spends: an
              operator who reads a completed maneuver and files the incident is
              the one that line exists to stop, and PARTIAL is the word doing
              the work. A cleared result spends none — full phosphor, the tone
              every other stated fact on this board is printed in. Amber would
              be a warning about nothing, and the board has no colour for good
              news because the console does not celebrate. */}
          <p className={cn("text-label uppercase", cleared ? "text-ink" : "text-warn")}>
            {calibrationAmendment(calibration.outcome, residual)}
          </p>
          <ResidualDifferential anomaly={anomaly} outcome={calibration.outcome} />
        </>
      ) : null}
    </>
  );
}

/** What is still on the table, or nothing when the machine has nothing to say. */
function ResidualDifferential({
  anomaly,
  outcome,
}: {
  anomaly: string;
  outcome: CalibrationOutcome;
}) {
  const remaining = residualDifferential(anomaly, outcome);
  if (!remaining) return null;
  return <p className="text-label text-ink-soft uppercase">{remaining}</p>;
}

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
function VerdictActions({
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

export interface VerdictStripProps {
  report: VerdictReport;
  onRestore: () => void;
}

/**
 * The card, put down: one line in the status bar that can be picked back up.
 *
 * It carries the three facts that decide whether to reopen it — where, which
 * part, what kind of wrong (scan-copy.ts composes them) — and it is a control
 * rather than a label with a control beside it, because the whole line is the
 * thing you want to click and a 200px hit target that reads as text is worse
 * than a 200px hit target that inverts when you touch it.
 *
 * RETURN sits next to it and not inside it. Restore and exit are the two things
 * an operator can do from here, they are not the same weight, and one of them
 * archives the incident — so they get one box each.
 *
 * ## What gives way at 375px
 *
 * The full line is ~28 characters of mono plus RESTORE, and a phone's status
 * rule has room for neither at full length beside a RETURN box. So the chip is
 * built in three pieces: VERDICT and — RESTORE hold their width, and the detail
 * between them ellipsises. That is the honest order of importance for a control
 * whose whole job is to be recognised and pressed: what it is, and what
 * pressing it does. The complete line stays in the accessible name, so nothing
 * a screen reader or a test asks for is lost to a layout decision.
 */
export function VerdictStrip({ report, onRestore }: VerdictStripProps) {
  const chipRef = React.useRef<HTMLButtonElement>(null);

  // The card held focus (its RETURN autofocuses on arrival) and the card just
  // left. Focus has to land on the thing that replaced it, or minimizing drops
  // a keyboard operator back to the top of the tab order for no reason they
  // could have predicted. Mount-once: this only ever mounts on minimize.
  React.useEffect(() => {
    chipRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    // gap-5 below `md`: the machine controls carry a 10px invisible touch
    // margin on coarse pointers (globals.css), and 20px is exactly what keeps
    // RESTORE's and RETURN's hit areas from overlapping — RETURN archives the
    // incident, so it is not a box to hit by half a thumb's width.
    // basis-full below `md`, not flex-1: a flex-1 item has a hypothetical size
    // of zero, so it always "fits" beside the status sentence and never wraps —
    // it just gets squeezed until the chip is three letters wide. Claiming the
    // full basis makes the wrap happen and gives the chip its own rule.
    <div className="flex min-w-0 basis-full items-center gap-5 md:basis-auto md:gap-2">
      <MachineControl
        ref={chipRef}
        tone="strong"
        aria-label={`${verdictChipLabel(report)} — Restore`}
        onClick={onRestore}
        className="min-w-0 flex-1 gap-1 md:flex-none"
      >
        <span className="shrink-0">{VERDICT_CHIP_HEAD}</span>
        <span className="min-w-0 truncate">· {verdictChipDetail(report)}</span>
        <span className="shrink-0">— Restore</span>
      </MachineControl>
      <MachineControl
        aria-label="Return to console"
        onClick={() => useIncidentStore.getState().completeAscent()}
      >
        Return
      </MachineControl>
    </div>
  );
}
