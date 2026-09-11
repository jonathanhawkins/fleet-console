import { COMMAND_LABELS, type UnitCommandState } from "@/lib/stores";

/**
 * What the console is allowed to say about a command, and which of the
 * verdict's recommendations actually reaches the robot.
 *
 * Pure on purpose. Every string in this file ends up either in a status rule or
 * in a confirmation the operator reads before moving a machine, so each one is
 * assertable in a test rather than buried in JSX — and the three refusal
 * reasons in particular are the sim's own words, printed verbatim (the store
 * README is explicit that machine voice passes through untranslated).
 */

/**
 * The recommendations the sim executes.
 *
 * Matched against the report's own `recommendations` array rather than
 * positionally: the report is wire data, the order is the sim's business, and a
 * card that decided "the middle one is the dangerous one" would silently start
 * commanding a robot the day a fifth recommendation appears.
 *
 * The comparison is case- and space-insensitive because the report writes
 * sentence case ("Command safe sit") while the machine prints caps, and the two
 * must not be able to drift into being different actions.
 */
export const EXECUTED_RECOMMENDATION = "Command safe sit";

/**
 * The second one. It lives here beside its sibling rather than in
 * `recalibrate-copy.ts` because the two are the membership of one set, and a
 * set assembled from two modules is a set one of them can be dropped from
 * without the other noticing.
 */
export const RECALIBRATE_RECOMMENDATION = "Recalibrate joint";

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Which maneuver a recommendation *is*, or null if pressing it only files a
 * note.
 *
 * A table rather than two predicates, and a discriminated result rather than a
 * boolean, because the card has to do two things with the answer: put the
 * action in the right group, and render the right control under it. Those were
 * briefly two separate string comparisons — one normalized, one not — which is
 * a bug with a very specific shape: a report writing "recalibrate joint" in
 * lower case would have been sorted into EXECUTE by the normalized half and
 * then handed to the *safe sit* control by the exact half. One function, so
 * there is one answer, and a third executed command cannot be added without
 * this switch's callers failing to compile.
 */
export type ExecutedKind = "sit" | "recalibrate";

const EXECUTED_KINDS: ReadonlyArray<[string, ExecutedKind]> = [
  [norm(EXECUTED_RECOMMENDATION), "sit"],
  [norm(RECALIBRATE_RECOMMENDATION), "recalibrate"],
];

export function executedKind(action: string): ExecutedKind | null {
  const key = norm(action);
  return EXECUTED_KINDS.find(([k]) => k === key)?.[1] ?? null;
}

export function isExecutedRecommendation(action: string): boolean {
  return executedKind(action) !== null;
}

export interface SplitRecommendations {
  /** Reaches the unit. At most one today; an array because the wire decides. */
  execute: string[];
  /** Enters the incident record and goes no further. */
  record: string[];
}

/**
 * Rank within EXECUTE: the ladder's own order, not the report's.
 *
 * SAFE SIT leads because it is the *precondition* for the rung above it — a
 * recalibration needs the unit seated, and the only control here that seats it
 * is this one. A report that happens to list RECALIBRATE first therefore puts
 * the gated action at the top of the group and the action that ungates it
 * underneath, which reads as a console recommending something it has itself
 * disabled.
 *
 * This is the one place the report's order is overridden, and it is overridden
 * by a fact about the robot rather than by a preference about layout: you
 * cannot recalibrate a joint the machine is standing on. Everything else keeps
 * the wire's order, and the ranking is by identity — never by position — for
 * the same reason the split itself is.
 */
const EXECUTE_RANK = (action: string): number => {
  if (norm(action) === norm(EXECUTED_RECOMMENDATION)) return 0;
  if (norm(action) === norm(RECALIBRATE_RECOMMENDATION)) return 1;
  return 2;
};

/**
 * The whole point of, in four lines: some of these buttons command a
 * robot and the rest write a note, and the card once presented all of them as
 * the same kind of object under one caveat that was true of all of them. The
 * split is data, not layout — so the card cannot draw a shape that disagrees
 * with what pressing the thing does.
 *
 * Two execute as of ("Command safe sit", "Recalibrate joint"), which
 * is why `execute` was an array from the start. They come back in the order
 * they can actually be performed (see `EXECUTE_RANK`); RECORD keeps the wire's.
 */
export function splitRecommendations(
  recommendations: readonly string[],
): SplitRecommendations {
  const execute: string[] = [];
  const record: string[] = [];
  for (const action of recommendations) {
    (isExecutedRecommendation(action) ? execute : record).push(action);
  }
  // Stable: equal ranks keep the report's order.
  execute.sort((a, b) => EXECUTE_RANK(a) - EXECUTE_RANK(b));
  return { execute, record };
}

/**
 * The recommendation in the RECORD group that is gated on the unit's posture
 *.
 *
 * Disabling a load-bearing knee while the robot is standing on it drops the
 * robot, so DISABLE JOINT stays on the card — the report said it — but renders
 * inert until the unit's posture is "sitting". Matched by identity, like
 * EXECUTED_RECOMMENDATION and for the same reason: the gate must follow the
 * action, not the third slot in an array whose order is the sim's business.
 *
 * RECALIBRATE JOINT carries the same physical precondition for the same reason
 * and is deliberately NOT in here: it is an executed command, its
 * gate travels with its control (recalibrate.tsx), and one predicate covering
 * both groups would put a recorded action's inert styling on a button that
 * commands a robot.
 */
export const POSTURE_GATED_RECOMMENDATION = "Disable joint";

export function isPostureGatedRecommendation(action: string): boolean {
  return norm(action) === norm(POSTURE_GATED_RECOMMENDATION);
}

/**
 * The gate, on the button itself, in the machine's status voice (caps written
 * literally, like commandLine's, because these are the machine's own words
 * about its own body). The suffix idiom is acknowledgedLabel's: the button's
 * label carries its state, so a test and a screen reader read the same fact
 * the eye does.
 */
export const POSTURE_GATE_SUFFIX = "REQUIRES SEATED POSTURE";

export function postureGateLabel(action: string): string {
  return `${action} · ${POSTURE_GATE_SUFFIX}`;
}

/**
 * Why, for aria-describedby — the reason the suffix compresses. It does not
 * say "disabled": the button already reports that state; a description that
 * repeats it would be the stammer RECORDED_NOTE was rewritten to remove.
 */
export const POSTURE_GATE_NOTE =
  "Load-bearing joint · disable permitted only while seated";

/**
 * The mirror gate, on SAFE SIT itself.
 *
 * Once RECALIBRATE joined it in EXECUTE, the two controls stopped being
 * alternatives and became a sequence — and a sequence has a second half. A
 * console that kept offering SAFE SIT to a robot already in a seated hold would
 * be offering the step it just took: the sim refuses it (ALREADY SITTING) and
 * the console prints that refusal, which is honest and still wrong to have
 * offered.
 *
 * (The gate once had a second job — the store held one slot per unit, so the
 * recalibration that followed a sit erased the sit's receipt, and a re-offered
 * SAFE SIT was how that surfaced. fixed that where it lived, in the
 * store's key. This gate is about the procedure, and stands on its own.)
 *
 * So the gate is symmetric: standing, SAFE SIT is live and RECALIBRATE waits;
 * seated, SAFE SIT is spent and RECALIBRATE is live. The group states the
 * procedure at every posture instead of offering both halves at once.
 *
 * The suffix is the sim's own refusal word, for the reason the seated gate's
 * is: the console and the robot give one reason between them.
 */
export const SIT_GATE_SUFFIX = "ALREADY SITTING";

export const SIT_GATE_NOTE = "Unit is already in a seated hold";

/**
 * What a SAFE SIT does to the unit, stated before it is ordered.
 *
 * Three lines, and the third is the one that matters: an operator who reads
 * "SAFE SIT COMPLETE" and files the incident has left a broken actuator in a
 * house. The maneuver makes the unit safe; it does not make it fixed, and the
 * confirmation is the last place that can say so before the fact.
 *
 * "TORQUE TO HOLD RESIDUAL", not "TORQUE TO ZERO": the joints keep enough to
 * hold a seated posture, which is what the telemetry then shows, and a
 * confirmation that overstates by one word is a confirmation the strips
 * contradict thirty seconds later.
 */
export interface ImpactLine {
  text: string;
  /**
   * `warn` is the amber tier, and exactly one line gets it: the consequence the
   * operator is most likely to drop. Machine space earns hierarchy with
   * luminance, so this is the only colour spent in the whole confirmation.
   */
  tone: "soft" | "warn";
}

export const SIT_IMPACT: readonly ImpactLine[] = [
  { text: "Torque to hold residual", tone: "soft" },
  { text: "Unit remains monitored", tone: "soft" },
  { text: "Service still required", tone: "warn" },
];

/**
 * Attached to the two recommendations that never leave this console.
 *
 * It says *when*, and the tense is the point. "Recorded · no command sent" sat
 * directly under a button that had just changed to read "· RECORDED", which is
 * the same word twice in two tenses — the panel stammering the one thing it is
 * trying to state calmly. This line describes what the group does; the button
 * states what happened to it. And "on return" is the truth about the mechanism:
 * an acknowledgement lives in the session until `completeAscent()` archives it,
 * so the incident record is written when the operator leaves, not when they
 * press. An operator who abandons the session takes the note with them, and a
 * console that implied otherwise would be describing paperwork that never filed.
 */
export const RECORDED_NOTE = "Records to the incident on return · no command sent";

/** Attached to the one that does. */
export const EXECUTE_NOTE = "Executes on the unit · confirmation required";

// ---------------------------------------------------------------------------
// when the operator pressed it

/**
 * The clock time each recommendation was acknowledged at, keyed by session.
 *
 * Module-level rather than component state, and deliberately not in the
 * incident store. Two constraints meet here:
 *
 * - It cannot live in the store. `session.acknowledged` is a plain
 * `string[]` that the unit page's incident history joins straight into its
 * "Acknowledged: …" line, so a timestamp smuggled into those strings would
 * surface in the archive as "dispatch service · recorded 14:32:07" beside the
 * row's *own* clock. The history line already has a time; this one is the
 * card's.
 * - It cannot live in the card. The verdict can be minimized and picked back
 * up (and on a phone it is a sheet that leaves and returns), which unmounts
 * the card. A component-state time would come back blank, so the same button
 * would read "· RECORDED 14:32:07" before the operator put the card down and
 * "· RECORDED" after — the panel forgetting something it just told them.
 *
 * The key carries the session, so a second scan of the same unit starts clean
 * without anything having to remember to sweep up. First write wins: pressing
 * is idempotent in the store (`acknowledgeRecommendation` ignores a repeat), and
 * the time has to be idempotent with it or the record would drift later on a
 * press that changed nothing.
 */
const acknowledgedAt = new Map<string, number>();

const ackKey = (unitId: string, startedAt: number, action: string) =>
  `${unitId}#${startedAt}#${action}`;

/** Note the press. Returns the ts on file — the first one, if there is one. */
export function markAcknowledged(
  unitId: string,
  startedAt: number,
  action: string,
  now: number = Date.now(),
): number {
  const key = ackKey(unitId, startedAt, action);
  const existing = acknowledgedAt.get(key);
  if (existing !== undefined) return existing;
  acknowledgedAt.set(key, now);
  return now;
}

/** The ts on file, or undefined if this console never saw the press. */
export function acknowledgedTime(
  unitId: string,
  startedAt: number,
  action: string,
): number | undefined {
  return acknowledgedAt.get(ackKey(unitId, startedAt, action));
}

/** Tests and teardown only. */
export function resetAcknowledgedTimes(): void {
  acknowledgedAt.clear();
}

/**
 * The pressed button's label: specific, past, and stamped.
 *
 * The timestamp is what turns this from a toggle echo into a log entry. Without
 * it "DISPATCH SERVICE · RECORDED" is a control describing its own state, which
 * is what a checkbox does; with it the button is reporting an event that has a
 * place in a sequence — and it reads as the same kind of object as every other
 * timestamped line this console prints.
 *
 * `clock` is passed in rather than formatted here so this file stays free of
 * locale and Date behaviour; the card hands it `clockTime` from the console
 * library (the same formatter the incident history and the alert feed use, so
 * three surfaces cannot disagree about what 14:32:07 looks like).
 */
export function acknowledgedLabel(action: string, clock: string | null): string {
  // No time on file is possible in principle — an acknowledgement restored
  // without the press that made it — and the honest answer is the word alone
  // rather than a plausible-looking clock reading nobody observed.
  return clock === null ? `${action} · recorded` : `${action} · recorded ${clock}`;
}

/**
 * The command's one line, machine voice.
 *
 * Composed here rather than in two components, because the verdict card's
 * action row and the surface's status rule print the *same* sentence about the
 * same maneuver — two copies of this logic would eventually disagree about a
 * robot's posture, on screen, at the same moment.
 *
 * Notes and reasons pass through verbatim. `pct` is only printed once the
 * machine has reported one: a "0%" beside an accepted command reads as a
 * stalled maneuver rather than as one that has not narrated yet.
 *
 * Written in caps rather than left to `text-transform`, like scan-copy.ts and
 * for the same reason: this is the machine's status voice, the wire's own words
 * are already in it, and a line half-composed of literals the CSS has to finish
 * is a line that reads differently in a test than it does on a board.
 */
export function commandLine(state: UnitCommandState): string {
  const label = COMMAND_LABELS[state.cmd];
  switch (state.phase) {
    case "pending":
      return `${label} · ACCEPTED`;
    case "progress":
      return [label, `${state.pct}%`, state.note].filter(Boolean).join(" · ");
    case "complete":
      return `${label} COMPLETE`;
    case "failed":
      // REFUSED, not FAILED, and that is a contract reading rather than a
      // guess. lib/schema/messages.ts: "Exactly one `accepted` or `failed`
      // answers the command synchronously; an accepted command then streams
      // `progress` beats and ends in exactly one `complete`." So `failed` is
      // always the machine declining to start — never a maneuver coming apart
      // halfway — and all three of this sim's reasons (ALREADY SITTING /
      // SIT IN PROGRESS / SCAN IN PROGRESS) read as refusals because they are.
      // If the wire ever gains a mid-flight abort it will need its own beat,
      // and this line will need to learn the difference. The recalibration's
      // reasons read the same way: REQUIRES SEATED POSTURE and
      // CALIBRATION CURRENT are the machine declining to start, not a sweep
      // coming apart mid-range.
      return `REFUSED · ${state.reason ?? label}`;
  }
}

/**
 * The bar's fill, 0–100.
 *
 * A refused command draws nothing rather than a stub: the machine declined, so
 * there is no maneuver to be part-way through, and a bar under the word REFUSED
 * would be the console illustrating progress that never happened. The store
 * carries the previous command's `pct` forward onto a refusal, which is exactly
 * the number that must not be drawn here.
 */
export function commandFill(state: UnitCommandState): number {
  if (state.phase === "failed") return 0;
  return state.phase === "complete" ? 100 : state.pct;
}
