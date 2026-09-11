/**
 * Whether a technician has been asked for, and the one recommendation that
 * asks.
 *
 * Its own module rather than a corner of the safe-sit copy: the incident
 * banner needs this fact on every troubled unit page, and reaching for it
 * inside a module full of maneuver narration pulled all of that narration into
 * the unit route's initial JS for one boolean. A page pays for what it reads.
 */

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The recommendation that asks for a technician.
 *
 * Matched by identity for the same reason every other action here is: a
 * substring test on "dispatch" answers yes to any recommendation the sim ever
 * words that way, and the surfaces that read this — the banner's headline and
 * the report's service block — would then disagree with the action rail about
 * what the operator actually pressed.
 */
export const DISPATCH_RECOMMENDATION = "Dispatch service";

export function isDispatchRecommendation(action: string): boolean {
  return norm(action) === norm(DISPATCH_RECOMMENDATION);
}

/**
 * Has the operator asked for a technician on this incident?
 *
 * The distinction the banner needs. Until this is true the console is *advising*
 * service; after it, the operator has decided and the decision is on the record,
 * and a headline still reading "service recommended" is the console repeating
 * advice that has already been taken.
 *
 * "Requested", not "dispatched": pressing it enters the incident record and
 * sends nothing (see RECORDED_NOTE), so the console may say what the operator
 * asked for and may not claim a technician was notified.
 */
export function serviceRequested(acknowledged: readonly string[]): boolean {
  return acknowledged.some(isDispatchRecommendation);
}
