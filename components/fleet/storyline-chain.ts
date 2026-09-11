import { type OperatorCommand } from "@/lib/schema";
import { useIncidentStore } from "@/lib/stores";

/**
 * The next act meets the operator on the way back from the last one.
 *
 * Four storylines share one clock, and on that clock the firmware cohort
 * forms at 3:00 — which, for someone who opened the knee incident at 0:02
 * and filed it a minute later, is ninety seconds of a fleet being fine.
 * Filing is the moment they turn back to the board, so filing is the moment
 * the board should have something new on it: the console asks the engine to
 * bring the cohort forward, and four seconds later N-02 raises the first
 * signature amber.
 *
 * The clock is not replaced, only pre-empted. Left alone, the act still opens
 * at 3:00 for whoever never files anything. The engine keeps the fleet as it
 * stands — what the operator just did stays done — and treats a chapter
 * already at hand as a no-op, so a second incident cannot move the story
 * twice. And it is the knee's incident specifically: a clean scan is not an
 * act finished, and the cohort's own incident is what this leads into.
 *
 * The position a reload resumes from is the console's own clock
 * (telemetry-provider.tsx), which an advance does not move — so a reload after
 * one picks the story up where the clock says, as a reload after a seek does.
 * Making that position the engine's would need a message for it; until then
 * the cost is a cohort that waits for 3:00 again after a refresh.
 *
 * `NEXT_PUBLIC_SIM_CHAIN=0` disables it, which the e2e builds do: they park
 * the later acts past the horizon and pin every beat they assert on.
 */

/** The chapter that follows the knee, by storyline order and by the demo's script. */
export const CHAPTER_AFTER_KNEE = "cohort" as const;

const enabled = process.env.NEXT_PUBLIC_SIM_CHAIN !== "0";

/**
 * Watch the incident record; when the knee's incident is filed, send the
 * advance. Returns the unsubscribe. `send` is injected rather than imported so
 * this module has no path back into the link it is a behaviour of.
 */
export function bindStorylineChain(send: (cmd: OperatorCommand) => boolean): () => void {
  if (!enabled) return () => {};
  return useIncidentStore.subscribe((state, previous) => {
    if (state.history.length <= previous.history.length) return;
    const filed = state.history[0];
    if (!filed || filed.report.anomaly !== "gain") return;
    send({ c: "ADVANCE_STORYLINE", chapter: CHAPTER_AFTER_KNEE });
  });
}
