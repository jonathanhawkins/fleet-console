import { resetStatusHistory } from "./status-history";
import { useIncidentStore } from "@/lib/stores";

/**
 * The half of a storyline restart that the wire does not own.
 *
 * RESET_SIM and SEEK_STORYLINE both rebuild the fleet and broadcast a fresh
 * snapshot, which clears the fleet store's alerts and statuses. Neither can
 * clear what only the client knows: the incident history written by
 * `completeAscent()`, and the status-timeline recorder's spans. A restart that
 * replayed the incident while last run's verdict still sat in the unit's
 * history would leave the console showing two of everything by the third pass.
 *
 * So both controls call this, and the rule is that anything sending one of
 * those two commands calls it too.
 */
export function clearLocalStoryline(): void {
  useIncidentStore.getState().reset();
  resetStatusHistory();
}
