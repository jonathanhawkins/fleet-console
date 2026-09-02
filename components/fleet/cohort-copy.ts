import { type CohortCanary, type CommandPhase } from "@/lib/stores";

/**
 * Everything the fleet incident card is allowed to SAY, and the two derivations
 * behind what it shows — pure, clock-free, store-free.
 *
 * Same reasoning as `safe-sit-copy.ts`, which this file is the operator-space
 * sibling of: every string here ends up either in a confirmation the operator
 * reads before changing four robots' firmware, or in the receipt that says what
 * happened. Those belong somewhere a test can quote them, not in JSX.
 *
 * ## The voice, and why it is not machine voice
 *
 * SAFE SIT's confirmation is written in caps because it is drawn on an
 * instrument, in the machine's own status voice. This one sits on warm white
 * beside a map. Operator space "in plain verbs and sentence case" is PRD §5, and
 * `audit-line.ts` already states the consequence of ignoring it: machine voice
 * dropped onto this page reads as a different product shouting.
 *
 * So the machine's words are carried across, not copied across. Exactly two
 * strings still print verbatim, and both are refusals — `NO ROLLOUT ACTIVE`,
 * `ROLLBACK IN PROGRESS`. A refusal is the fleet declining to do the thing the
 * operator just asked for, and the exact words are the citation; the console
 * adds what they mean underneath rather than paraphrasing over the top.
 */

/* ---------------------------------------------------------------------------
   The incident, stated
--------------------------------------------------------------------------- */

/**
 * A reference an operator could read down a phone — `incidentRef`'s fleet twin.
 *
 * The store's instance id is `cohort-2.4.1-1787356771820`: correct as a key,
 * and thirteen digits of epoch noise on a warm-white card. This derives a short
 * reference from the same two facts (which build, which moment), so it is
 * exactly as stable and exactly as unique. `FLT` rather than `INC` because the
 * two documents are filed against different subjects, and an operator holding
 * two references should be able to tell which is the fleet's without opening
 * either.
 *
 * It lives here rather than with the report's derivations for the reason every
 * reference in this console does — it belongs to whatever *prints* it, which is
 * the card — and for one measured one: the card's chunk and the document's
 * chunk both need it, and a module only those two share becomes a third chunk
 * of its own (Turbopack, 0.5 KB gz across the two routes). This module is
 * already shared with the initial payload via audit-line.ts, so the reference
 * rides a boundary that exists.
 */
export function cohortRef(fw: string, detectedAt: number): string {
  return `FLT-${fw.replaceAll(".", "")}-${detectedAt.toString(36).toUpperCase()}`;
}

/**
 * The card's headline. Never singular: a cohort is >= COHORT_THRESHOLD units.
 *
 * One word of tense, and it is the difference between a live incident and a
 * record of one. A card still reading "raising" over a completed rollback and a
 * fleet counting zero alerting units would be the loudest thing on the page
 * asserting something the three regions underneath it have already disproved.
 */
export function cohortHeadline(memberCount: number, settled = false): string {
  return `${memberCount} units ${settled ? "raised" : "raising"} the same warning`;
}

/**
 * The same sentence once the incident is filed, with the build in it.
 *
 * It is deliberately `cohortHeadline`'s past tense rather than a new line: the
 * record replaces the card in the same place on the page, and an operator who
 * watched the card settle should recognise what is left as the same incident
 * rather than read a second description of it. What it adds is the build —
 * the card carried that in its own section label, and the record has no
 * section label to carry it.
 *
 * It does NOT say "restored". Closing an incident is the operator declaring
 * they are done with it; whether every robot came back is a separate claim,
 * made by the report where the evidence for it is printed.
 */
export function cohortRecordLine(memberCount: number, fw: string): string {
  return `${cohortHeadline(memberCount, true)} on ${fw} — incident closed.`;
}

/**
 * When the incident actually closed, read off the journals rather than off the
 * console's clock.
 *
 * The card's header runs a live duration while the incident is open, which is
 * correct and is the wrong thing entirely once it is over: a settled card
 * counting upwards is the loudest object on the page insisting the fleet is
 * still taking damage. So the span freezes here, at the last thing that closed
 * it — the latest member alert to clear, or the fleet declaring the staged
 * rollback complete, whichever landed last.
 *
 * Undefined where neither is on file, and the header prints no span at all in
 * that case. A closure the console cannot date is not a closure it should put a
 * number on — the same rule `durationSince` follows before the client clock
 * exists, and the same one the report's `Stamp` follows for a missing time.
 */
export function cohortClosedAt(
  /** Each member alert's `resolvedAt`, in cohort order; undefined where unresolved. */
  resolvedAts: readonly (number | undefined)[],
  /** The staged rollback's lifecycle, if there was one. */
  rollback: { phase: CommandPhase; updatedAt: number } | undefined,
): number | undefined {
  let latest: number | undefined;
  for (const ts of resolvedAts) {
    if (ts !== undefined && (latest === undefined || ts > latest)) latest = ts;
  }
  if (
    rollback?.phase === "complete" &&
    (latest === undefined || rollback.updatedAt > latest)
  ) {
    latest = rollback.updatedAt;
  }
  return latest;
}

/**
 * The canary comparison in one sentence — the whole argument for touching a
 * firmware rather than a robot.
 *
 * "All on firmware 2.4.1 — 0 of 4 units on 2.3.7 affected". The suspect row
 * leads (the store hands the array suspect-first, and this re-finds it by `fw`
 * rather than trusting position, because the sentence's subject must be the
 * build the operator is about to act on). The comparison rows are what make it
 * evidence instead of an assertion: a fault that appeared on both builds would
 * print here and quietly withdraw the accusation.
 *
 * A fleet running one build has nothing to compare against and says so. That is
 * the honest reading of the same data — not a missing sentence.
 */
export function canaryLine(canary: readonly CohortCanary[], fw: string): string {
  const suspect = canary.find((c) => c.fw === fw) ?? canary[0];
  if (suspect === undefined) return "";
  const head =
    suspect.affected === suspect.total
      ? `All on firmware ${suspect.fw}`
      : `${suspect.affected} of ${suspect.total} units on firmware ${suspect.fw}`;

  const rest = canary.filter((c) => c.fw !== suspect.fw);
  if (rest.length === 0) return `${head} — no other build in the fleet to compare`;

  // "units" once, on the first comparison row: it is the noun for the whole
  // clause, and repeating it down a list of builds reads as a table read aloud.
  const tail = rest
    .map((c, i) => `${c.affected} of ${c.total}${i === 0 ? " units" : ""} on ${c.fw}`)
    .join(", ");
  return `${head} — ${tail} affected`;
}

/* ---------------------------------------------------------------------------
   The two confirmations
--------------------------------------------------------------------------- */

/**
 * One line of a confirmation's impact list.
 *
 * `warn` is the amber tier and at most one line per confirmation gets it — the
 * consequence the operator is most likely to drop. The rule is SAFE SIT's
 * (`SIT_IMPACT`) and the reason is the same: a list where everything is
 * emphasised has no emphasis in it.
 */
export interface ImpactLine {
  text: string;
  tone: "soft" | "warn";
}

/**
 * What halting does, stated before it is done.
 *
 * The last line is the one that matters, and it is the fleet-scale twin of SAFE
 * SIT's "Service still required": halting saves the unit that has not been
 * updated yet and does *nothing* for the four already running the suspect
 * build. An operator who halts, sees "Rollout halted", and moves on has left
 * four robots faulty in four houses.
 *
 * `queued` is the units still carrying `fwPending` — the ones a halt actually
 * saves. Empty is a real state (the install already landed, or the rollout was
 * halted earlier), and the copy says so rather than promising a save the fleet
 * is about to refuse.
 */
export function haltImpact(queued: readonly string[], fw: string): ImpactLine[] {
  const lines: ImpactLine[] =
    queued.length > 0
      ? [
          {
            text: `Prevents the scheduled update on ${listUnits(queued)}.`,
            tone: "soft",
          },
        ]
      : [
          {
            text: "No update is still queued — the fleet may refuse this.",
            tone: "soft",
          },
        ];
  lines.push({ text: `Units already on ${fw} are unaffected.`, tone: "soft" });
  lines.push({ text: "Roll back the cohort to restore them.", tone: "warn" });
  return lines;
}

/**
 * The rollout service's published per-unit window, in ms.
 *
 * The console is quoting a contract here, not measuring one — the engine
 * restores one unit per ~4 s in roster order (lib/stores/README.md, "The fleet
 * slice"), and the estimate below is hedged with "about" precisely because a
 * quoted contract is not a stopwatch. It is worth stating at all because "roll
 * back four units" and "roll back four units for the next quarter minute" are
 * different decisions, and the second one is the true one: the operator is
 * about to watch a queue drain, not press a button and be finished.
 */
export const ROLLBACK_PER_UNIT_MS = 4_000;

/** "about 16 seconds" — deliberately coarse; see ROLLBACK_PER_UNIT_MS. */
export function rollbackEstimate(unitCount: number): string {
  return `about ${Math.round((unitCount * ROLLBACK_PER_UNIT_MS) / 1000)} seconds`;
}

/**
 * What a staged rollback does, stated before it is ordered.
 *
 * Three facts and a conditional. The staging is first because it changes what
 * the operator does next (they wait, and they watch a list); the alerts clearing
 * is second because it is the thing they will otherwise interpret as the feed
 * misbehaving; the revert is the warn line, because "these four robots lose the
 * update" is the cost, and it is the one the word "rollback" makes easy to skip
 * past. The conditional exists because the engine halts the rollout as a side
 * effect of rolling it back (a queued install of the same build is canceled),
 * and a side effect the operator was not told about is not a side effect, it is
 * a surprise.
 */
export function rollbackImpact(
  unitCount: number,
  fw: string,
  queued: readonly string[],
): ImpactLine[] {
  const lines: ImpactLine[] = [
    {
      text: `Rolls back ${unitCount} units, one at a time — ${rollbackEstimate(unitCount)}.`,
      tone: "soft",
    },
    { text: "Alerts clear as each unit completes.", tone: "soft" },
  ];
  if (queued.length > 0) {
    lines.push({
      text: `The queued update on ${listUnits(queued)} is canceled too.`,
      tone: "soft",
    });
  }
  lines.push({ text: `Reverts the ${fw} update on every affected unit.`, tone: "warn" });
  return lines;
}

/** "N-05" · "N-05 and N-06" · "N-05, N-06 and N-09". */
export function listUnits(unitIds: readonly string[]): string {
  if (unitIds.length <= 1) return unitIds[0] ?? "";
  return `${unitIds.slice(0, -1).join(", ")} and ${unitIds[unitIds.length - 1]}`;
}

/* ---------------------------------------------------------------------------
   Receipts and refusals
--------------------------------------------------------------------------- */

/**
 * The halt's receipt, in the page's voice.
 *
 * The engine's note is `ROLLOUT HALTED — N-05 REMAINS ON 2.3.7`, and the fact it
 * carries is the demonstrable non-event this whole storyline is built around:
 * a unit that did NOT get the bad build. Re-deriving that sentence from store
 * state would be the console asserting the save on its own authority; reading it
 * off the machine's own line keeps the claim the machine's, and the shape is
 * fixed by the engine (sim/engine.ts, HALT_ROLLOUT) rather than guessed at.
 *
 * Anything that does not match passes through untouched — the same
 * carry-through-on-no-match rule `countedResolution` uses in audit-line.ts, and
 * for the same reason: a receipt this file did not recognise is still the
 * machine's receipt, and printing it verbatim beats printing nothing.
 */
const HALT_RECEIPT = /^ROLLOUT HALTED — (\S+) REMAINS ON (\S+)$/;

/** The two facts inside a halt receipt: who was saved, and what they stayed on. */
export interface HaltReceiptFacts {
  unitId: string;
  fw: string;
}

/**
 * The receipt read as data rather than as a sentence.
 *
 * The fleet incident report needs the *unit* out of this line — an update that
 * did not happen has no other journal, because nothing happening leaves no
 * alert, no command and no unit_update to point at (cohort-report.ts, "the
 * save"). Parsed here, beside the sentence it is parsed from, so the report and
 * the card cannot come to disagree about which robot was spared.
 *
 * Null for anything that is not the engine's shape — the same
 * carry-through-on-no-match rule `haltReceipt` uses, in its data form: a note
 * this file does not recognise still prints, it just yields no facts to count.
 */
export function haltReceiptFacts(
  note: string | null | undefined,
): HaltReceiptFacts | null {
  if (note === null || note === undefined) return null;
  const match = HALT_RECEIPT.exec(note);
  return match ? { unitId: match[1]!, fw: match[2]! } : null;
}

export function haltReceipt(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  const facts = haltReceiptFacts(note);
  return facts ? `Rollout halted — ${facts.unitId} remains on ${facts.fw}` : note;
}

/**
 * What a refusal means, under the machine's own words.
 *
 * The reason prints verbatim above this; this says what the operator should do
 * about it. `NO ROLLOUT ACTIVE` is the one that carries the storyline's second
 * ending — the operator who reached for HALT after the install already landed —
 * and the honest answer is not "try again", it is "that door has closed, here is
 * the other one".
 */
export function refusalNote(reason: string | null): string | null {
  switch (reason) {
    case "NO ROLLOUT ACTIVE":
      return "Nothing left to halt — the update has already installed, or the rollout was stopped earlier. Rolling back the cohort restores the affected units.";
    case "ROLLBACK IN PROGRESS":
      return "A staged rollback is already running. It finishes one unit at a time.";
    default:
      return null;
  }
}

/* ---------------------------------------------------------------------------
   The staged rollback, derived
--------------------------------------------------------------------------- */

export type RollbackUnitPhase = "waiting" | "rolling-back" | "restored";

export interface RollbackUnitRow {
  unitId: string;
  phase: RollbackUnitPhase;
}

/** Operator-space words for the three states, and the order they read in. */
export const ROLLBACK_PHASE_COPY: Record<RollbackUnitPhase, string> = {
  waiting: "Waiting",
  "rolling-back": "Rolling back",
  restored: "Restored",
};

/**
 * The units a rollback of `fw` will touch, in the order the engine will touch
 * them.
 *
 * Roster order, not cohort order: the engine restores `units.filter(fw)` in
 * snapshot order, and the cohort's own membership is sorted by raise time. They
 * are usually the same four robots in a different sequence, and a progress list
 * that counted down in the wrong order would look like it had lost track.
 *
 * It is also a wider set than the cohort on purpose. A unit running the suspect
 * build that has not raised the signature *yet* is still rolled back by the
 * engine, so it belongs on the list the operator is shown before they confirm.
 */
export function rollbackRoster(
  unitIds: readonly string[],
  fwOf: (unitId: string) => string | undefined,
  fw: string,
): string[] {
  return unitIds.filter((id) => fwOf(id) === fw);
}

/**
 * The live progress list: one row per unit, derived from firmware truth.
 *
 * Nothing here parses the engine's narration. A unit is restored when its
 * firmware is no longer the suspect build — which is a `unit_update` the store
 * already applied, i.e. the same fact the rail row and the map marker are
 * reading — and the unit currently being worked is the first one that is not,
 * because the engine is strictly serial in this order. That makes the list a
 * reading of fleet state rather than a second copy of the command stream, and it
 * survives a replayed or coalesced beat without drifting.
 *
 * No command, or a finished one, means nothing is in flight: every remaining
 * unit reads `waiting` rather than one of them pretending to be underway. A
 * refusal takes the same branch, which is the point — `ROLLBACK IN PROGRESS`
 * must not leave this list animating a rollback that was declined.
 */
export function rollbackRows(
  roster: readonly string[],
  fwOf: (unitId: string) => string | undefined,
  fw: string,
  commandPhase: CommandPhase | undefined,
): RollbackUnitRow[] {
  // `complete` is the engine asserting the staged restoration finished, and it
  // outranks the derivation: the alternative is a list still showing a unit as
  // waiting under a line that says the rollback is done, which is the console
  // arguing with the machine on screen.
  if (commandPhase === "complete") {
    return roster.map((unitId) => ({ unitId, phase: "restored" as const }));
  }
  const running = commandPhase === "pending" || commandPhase === "progress";
  let activeTaken = false;
  return roster.map((unitId) => {
    if (fwOf(unitId) !== fw) return { unitId, phase: "restored" as const };
    if (running && !activeTaken) {
      activeTaken = true;
      return { unitId, phase: "rolling-back" as const };
    }
    return { unitId, phase: "waiting" as const };
  });
}

/** How many of the roster are done — the count line above the list. */
export function restoredCount(rows: readonly RollbackUnitRow[]): number {
  return rows.filter((r) => r.phase === "restored").length;
}

/**
 * The rollback's own headline, which changes tense exactly once.
 *
 * `restoredTo` is read from a unit the engine actually moved, never from a
 * baseline constant: the console has no business naming a version the fleet has
 * not reported. Absent (nothing restored yet, or a fleet that reports no
 * firmware) it simply drops out of the sentence.
 */
export function rollbackLine(
  rows: readonly RollbackUnitRow[],
  commandPhase: CommandPhase | undefined,
  restoredTo: string | undefined,
): string {
  const done = restoredCount(rows);
  if (commandPhase === "complete") {
    return restoredTo === undefined
      ? `Rollback complete — ${done} units restored.`
      : `Rollback complete — ${done} units restored to ${restoredTo}.`;
  }
  return `Rolling back ${rows.length} units — ${done} of ${rows.length} restored.`;
}
