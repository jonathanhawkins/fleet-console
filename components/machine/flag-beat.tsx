"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { EASE_WIPE, secs, usePrefersReducedMotion } from "@/components/console";

/**
 * The moment the scan finds it.
 *
 * One alert-red rule, full height, travelling the width of the overlay once in
 * 600 ms, and then gone. It is deliberately the same object as the cursor
 * sweeping each waveform strip — the thing that has been quietly reading
 * channels for the last fifteen seconds — scaled to the whole screen. The
 * gesture says *that small thing just found something*, and it says it without
 * a single word, a colour that has not already been established, or any shape
 * the board does not already contain.
 *
 * ## Why this one is allowed to be loud
 *
 * It is the only beat in machine space with any velocity at all, and that is
 * the entire reason it works. Everything before it is restrained on purpose:
 * chips flip, traces resolve, lines dim. Spend a sweep on the channel sweep and
 * another on the manifest and this one becomes the third animation on a busy
 * screen. Protecting its contrast is a discipline paid for elsewhere.
 *
 * It fires exactly once per session, keyed on the flag's arrival, and it never
 * loops. A rule that pulsed would turn the peak into wallpaper inside ten
 * seconds.
 *
 * Under `prefers-reduced-motion` the rule does not travel: it appears at the
 * flagged channel's own strip and fades. The information — *now, here* — is
 * intact; only the distance is gone.
 */

/** One pass, and the longest single gesture in the product. */
const SWEEP_MS = 600;
const FADE_MS = 260;

export interface FlagBeatProps {
  /** Truthy once the flag has landed. The beat fires on the transition. */
  flagged: boolean;
}

export function FlagBeat({ flagged }: FlagBeatProps) {
  const reduced = usePrefersReducedMotion();
  const [playing, setPlaying] = React.useState(false);
  const fired = React.useRef(false);

  React.useEffect(() => {
    if (!flagged || fired.current) return;
    fired.current = true;
    setPlaying(true);
    const done = window.setTimeout(
      () => setPlaying(false),
      (reduced ? FADE_MS : SWEEP_MS) + 80,
    );
    return () => window.clearTimeout(done);
  }, [flagged, reduced]);

  if (!playing) return null;

  if (reduced) {
    return (
      <motion.span
        aria-hidden
        initial={{ opacity: 0.85 }}
        animate={{ opacity: 0 }}
        transition={{ duration: secs(FADE_MS), ease: "linear" }}
        className="flag-beat flag-beat--static"
      />
    );
  }

  return (
    <motion.span
      aria-hidden
      initial={{ x: "-2vw" }}
      animate={{ x: "102vw" }}
      transition={{ duration: secs(SWEEP_MS), ease: EASE_WIPE }}
      className="flag-beat"
    />
  );
}
