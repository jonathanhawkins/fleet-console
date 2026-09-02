"use client";

import * as React from "react";
import { type Variants } from "framer-motion";
import {
  descentTimeline,
  EASE_WIPE,
  secs,
  type DescentTimeline,
} from "@/components/console";

/**
 * Beat 3: the chrome boots.
 *
 * Mono type on a black field has one honest way to arrive — it resolves, the
 * way a phosphor screen paints a frame — so every element here reveals by
 * opacity, and rules reveal by drawing themselves from one end. Nothing
 * translates. A staggered slide would be the generic dashboard entrance, and on
 * this material it reads as a web page pretending to be a terminal rather than
 * an instrument coming up.
 *
 * Two child variants because the material genuinely differs: type fades, rules
 * draw. Both answer to the same "hidden"/"shown" labels, so one parent drives
 * the whole board and framer's variant propagation handles the rest.
 *
 * **Why a context rather than framer's `custom`.** The variants need the
 * timeline, and `custom` is the documented way to pass it — but it only reaches
 * variants that resolve inside the same motion subtree, and this board's motion
 * elements are scattered across five components. Half of them silently
 * resolved their variant function with `custom` undefined. Building the
 * objects once, above the tree, removes the failure mode entirely and buys
 * something else worth having: the variant identities are stable, so the
 * ScanLog re-rendering twenty times as walk lines stream cannot restart an
 * animation that already played.
 */

export interface BootVariants {
  parent: Variants;
  item: Variants;
  rule: Variants;
  /**
   * The conclusion arriving and being put down (verdict-card.tsx).
   *
   * Not part of the boot — it happens ninety seconds later, on its own trigger,
   * with no stagger around it — but the same material on the same clock, so it
   * reads at the same speed as everything else that ever appeared on this board
   * and there is one timeline to change rather than two. `gone` exists so the
   * desktop card *leaves* the way it arrived instead of being cut out of the
   * tree: minimize and restore are one gesture in two directions, and only one
   * of them was animated.
   */
  verdict: Variants;
}

function build(t: DescentTimeline): BootVariants {
  return {
    parent: {
      hidden: {},
      shown: {
        transition: {
          delayChildren: secs(t.bootAtMs),
          staggerChildren: secs(t.bootStaggerMs),
        },
      },
      // Leaving is not a reverse boot: the board goes at once, ahead of the
      // surface, so the wipe carries black rather than a half-erased instrument.
      gone: { opacity: 0, transition: { duration: secs(t.boardExitMs), ease: "linear" } },
    },
    item: {
      hidden: { opacity: 0 },
      shown: { opacity: 1, transition: { duration: secs(t.bootMs), ease: "linear" } },
    },
    rule: {
      hidden: { scaleX: 0 },
      shown: { scaleX: 1, transition: { duration: secs(t.bootMs), ease: EASE_WIPE } },
    },
    verdict: {
      hidden: { opacity: 0 },
      shown: { opacity: 1, transition: { duration: secs(t.bootMs), ease: "linear" } },
      // No drift. A 6 px downward slide toward the status rule was built and
      // looked at side by side at 0 px and 6 px of drift:
      // the card carries its own top rule, so the drift slides a 1 px rule off
      // the board's lattice and hangs the MINIMIZE box below every other chip
      // in the column for the length of the fade. On this material that reads
      // as a misprint, not as travel — which is the law at the top of this
      // file, met from the other direction. The sheet keeps its travel because
      // a sheet is a surface lying over things and has somewhere to go; a card
      // in a column is part of the layout, and layout does not slide.
      gone: {
        opacity: 0,
        transition: { duration: secs(t.bootMs), ease: "linear" },
      },
    },
  };
}

const BootContext = React.createContext<BootVariants>(build(descentTimeline(false)));

export function BootProvider({
  timeline,
  children,
}: {
  timeline: DescentTimeline;
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => build(timeline), [timeline]);
  return <BootContext.Provider value={value}>{children}</BootContext.Provider>;
}

export function useBoot(): BootVariants {
  return React.useContext(BootContext);
}
