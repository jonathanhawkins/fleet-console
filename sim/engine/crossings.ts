import { type FleetMessage } from "@/lib/schema";
import { kneeCrossings } from "./incident-knee";
import { offsetCrossings } from "./incident-offset";
import { navCrossings } from "./nav-recovery";
import { cohortCrossings } from "./rollout";
import { type EngineConfig, type EngineState } from "./state";

/**
 * Every storyline's beats in the storyline window (prevMs, curMs], in a fixed
 * order — the order two engines on the same seed have to agree on.
 *
 * Each storyline tests `prevMs < at && curMs >= at`, so the window may be as
 * wide as the caller likes and every beat inside it fires exactly once. That is
 * what makes both of this module's callers work: `advance()` passes one
 * 100 ms slot, and a chapter seek passes the whole run up to that chapter.
 */
export function storylineCrossings(
  cfg: EngineConfig,
  st: EngineState,
  prevMs: number,
  curMs: number,
): FleetMessage[] {
  return [
    ...kneeCrossings(cfg, st, prevMs, curMs),
    ...navCrossings(cfg, st, prevMs, curMs),
    ...offsetCrossings(cfg, st, prevMs, curMs),
    ...cohortCrossings(cfg, st, prevMs, curMs),
  ];
}
