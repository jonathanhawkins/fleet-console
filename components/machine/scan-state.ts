"use client";

import * as React from "react";
import { useMediaQuery } from "@/components/console";
import {
  selectExiting,
  selectShownSession,
  useFleetStore,
  useIncidentStore,
  type DiagSession,
  type IncidentState,
} from "@/lib/stores";
import { SCAN_STACKED_QUERY, VERDICT_SHEET_QUERY } from "./machine-layout";

/**
 * What the scan knows about itself, derived — never stored twice.
 *
 * Every machine-space panel renders from `useIncidentStore`'s session and from
 * nothing else. That is a rule with teeth: a ScanLog that kept its own
 * append-only array of lines would double every line when the transport
 * reconnects and replays the emitted prefix, and a board that latched
 * "OPERATING" into local state would survive a session that was aborted
 * underneath it. The store dedupes replays (lib/stores/README.md); the panels
 * are pure functions of what it holds.
 */

/**
 * The link, as the scan experiences it.
 *
 * open events are arriving, or can
 * lost the socket is down mid-scan — the board holds what it has
 * resumed the socket came back and the sequence has not continued yet
 *
 * `resumed` exists because a reconnect has two possible endings and the
 * console cannot tell them apart from the socket alone. If the host still has
 * the scan it replays the emitted prefix and carries on, and this state lasts
 * one message. If the host was restarted, there is no scan to replay and this
 * state lasts forever — which is exactly when the operator needs the way out
 * that the stage keeps on screen from the first drop onward. Saying "AWAITING
 * SEQUENCE" is true in both endings; guessing which one it is would not be.
 *
 * Detected by counting events rather than by a timer: the sequence has natural
 * four-second gaps, and a grace period long enough not to false-positive on
 * the pause before the verdict would be too long to be useful.
 */
export type ScanLink = "open" | "lost" | "resumed";

/**
 * A primitive, so this subscription survives twenty walk lines without a
 * render.
 *
 * Counted over the *shown* session. Over the live one it returned 0
 * in the commit that ended a scan, and that was a shipped bug, not a
 * curiosity: a session whose socket dropped and came back before its first
 * walk line has `countAtRestore === 0`, so the collapse re-satisfied the
 * "resumed" test below and the log grew HOLD — LINK RESTORED · AWAITING
 * SEQUENCE under a scan that had already reached a verdict. The count is an
 * input to what the surface is *showing*, so it follows the surface.
 */
export const selectSessionEventCount = (s: IncidentState): number => {
  const session = selectShownSession(s);
  if (!session) return 0;
  return (
    session.walkLines.length +
    session.channels.length +
    (session.flag ? 1 : 0) +
    (session.report ? 1 : 0)
  );
};

const selectLinkOpen = (s: ReturnType<typeof useFleetStore.getState>): boolean =>
  s.connection === "open";

interface LinkMark {
  /** Has this session ever lost the link? Once true, it stays true. */
  everLost: boolean;
  /** Event count at the moment the link came back; -1 while it is down. */
  countAtRestore: number;
}

const INITIAL_MARK: LinkMark = { everLost: false, countAtRestore: -1 };

export function useScanLink(): ScanLink {
  const open = useFleetStore(selectLinkOpen);
  const events = useIncidentStore(selectSessionEventCount);
  const departing = useIncidentStore(selectExiting);
  const [mark, setMark] = React.useState<LinkMark>(INITIAL_MARK);

  React.useEffect(() => {
    setMark((m) => {
      if (!open)
        return m.everLost && m.countAtRestore < 0
          ? m
          : { everLost: true, countAtRestore: -1 };
      if (!m.everLost || m.countAtRestore >= 0) return m;
      return { everLost: true, countAtRestore: events };
    });
    // `events` moves ten times a scan; every one of those runs returns the same
    // object from the updater, so React bails out and nothing re-renders.
  }, [open, events]);

  const live: ScanLink = !open
    ? "lost"
    : mark.everLost && mark.countAtRestore >= 0 && events === mark.countAtRestore
      ? "resumed"
      : "open";

  /**
   * The link is held with the session and the phase, and it is the one of the
   * three that cannot be held *in* the store.
   *
   * The store's snapshot fixes the input that was lying — the event count, which
   * collapsed to 0 with the session — but the other input is the socket, and it
   * goes on moving. A drop in the 250 ms of an ascent would put HOLD on the
   * header and LINK RESTORED in the log of a scan that reached its verdict two
   * frames ago: true of the console, false of the diagnostic on screen, which
   * is exactly the class of lie the snapshot exists to end. So the last reading
   * taken while the surface was still the store's is what it leaves with — the
   * same rule the session and phase follow, applied to the input the reducer
   * cannot see.
   *
   * A ref rather than state because it must be exact on the very frame the exit
   * begins, and because it is *driven by* the store's one `exiting` fact rather
   * than being a second copy of it: nothing here decides that an exit is
   * happening, it only reads what this hook last said while one was not.
   */
  const held = React.useRef<ScanLink>(live);
  if (!departing) held.current = live;
  return departing ? held.current : live;
}

/** True once the link has dropped at all — the stage's way out stays offered. */
export function useLinkEverLost(): boolean {
  const link = useScanLink();
  const [everLost, setEverLost] = React.useState(false);
  React.useEffect(() => {
    if (link !== "open") setEverLost(true);
  }, [link]);
  return everLost;
}

/**
 * The session, or null. Re-renders on every accepted event — panels want that.
 *
 * Reads through the store's departing snapshot, which is what makes
 * the last 250 ms of machine space true. `completeAscent()` empties the live
 * fields in one commit — phase to `idle`, session to null — and the surface
 * still has a board fade and a wipe left to play. Panels reading the live
 * session straight through that exit do not go blank; they render *a different
 * scan*: zero nodes walked, nothing cleared on the manifest, INITIALISING SCAN
 * in the bottom rule, and a session header whose id is derived from the clock
 * and so comes out brand new. For the length of the fade the instrument
 * describes a diagnostic that never happened, over the top of the one that just
 * did.
 *
 * This used to be a context the stage provided, plus a ref inside the stage
 * that decided when to stop believing the store — the same fact latched twice
 * more, in the two places that happened to notice it. The panels never needed
 * to know an exit was a thing that could happen to them, and now nothing here
 * does: the store says what is being shown, and this is a plain read of it.
 */
export function useDiagSession(): DiagSession | null {
  return useIncidentStore(selectShownSession);
}

/**
 * True where the scan is one scrolling column rather than a board.
 *
 * Read this only to decide what to *render* — a component that is genuinely
 * absent on a phone (the turntable), a control that only a phone needs (the
 * log's expand), a hint that names a key a phone does not have. Anything that
 * is merely laid out differently belongs in the stylesheet, which owns this
 * threshold; `SCAN_STACKED_QUERY` is a copy of the media query there and the
 * two are meant to be read together.
 */
export function useStackedScan(): boolean {
  return useMediaQuery(SCAN_STACKED_QUERY);
}

/**
 * True where the verdict is a sheet over the instrument rather than a card in
 * the board's centre column — every width below 64rem, phone and tablet alike.
 *
 * Separate from {@link useStackedScan} on purpose; see the note on
 * `VERDICT_SHEET_QUERY` for why the two thresholds are different questions.
 */
export function useVerdictSheet(): boolean {
  return useMediaQuery(VERDICT_SHEET_QUERY);
}
