"use client";

import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { MachineControl } from "./machine-control";
import { buildScanLog, type ScanLogKind, type ScanLogLine } from "./scan-log-lines";
import { type ScanLink } from "./scan-state";
import { useDiagSession } from "./scan-state";

/**
 * The MAGI program walk: the robot's own tree, one node per line, arriving.
 *
 * The eva reference (eva-magi-program-flow-green.png) is a wall of dense
 * phosphor code in boxed columns, and what makes it read as a machine thinking
 * is not the green — it is that there is *far more of it than you can follow*,
 * moving, with a bright edge where the work is happening. That is the property
 * this borrows: three luminance tiers, no colour outside the two lines that
 * carry status, and a tail that runs away from you.
 *
 * **Recency is the hierarchy.** The newest line is at full phosphor with a
 * block cursor; the four behind it sit one tier down; everything older is at
 * the dim tier. Nothing else on this panel is coloured, so the flag line —
 * when it comes — is the only red on a column of green, and it does not have
 * to shout to be found.
 *
 * **Nothing is stored.** The lines are a projection of the store's session
 * (scan-log-lines.ts). A log that appended locally would double itself the
 * first time the transport reconnected mid-scan and replayed the prefix, which
 * is exactly the case is meant to survive.
 */

/** Dense leading — the point of the reference is density, not comfort. */
const ROW_HEIGHT = 18;
const OVERSCAN = 8;

/** Lines within this many of the tail keep the brighter middle tier. */
const RECENT_LINES = 4;

/** Treat "within this many pixels of the bottom" as still following. */
const TAIL_SLACK = 24;

const KIND_TONE: Record<ScanLogKind, string> = {
  walk: "",
  channel: "",
  // The two structural announcements: amber, because they are the scan telling
  // you where it is rather than what it found.
  phase: "text-warn",
  flag: "text-alert",
  hold: "text-alert",
};

export interface ScanLogProps {
  link: ScanLink;
  complete: boolean;
}

export function ScanLog({ link, complete }: ScanLogProps) {
  const session = useDiagSession();
  const lines = React.useMemo(
    () => buildScanLog({ session, link, complete }),
    [session, link, complete],
  );

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = React.useState(true);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  /**
   * Auto-follow, and the reason it can be given up.
   *
   * A log that always jumps to the tail is unreadable the moment an operator
   * tries to read it: the thing they scrolled back to look at leaves the
   * screen a third of a second later. So scrolling up hands them the column,
   * scrolling back to the bottom takes it back, and while they hold it the
   * panel says so and offers the way out. The tail is never *taken* back
   * without them.
   */
  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atTail = el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_SLACK;
    setFollowing(atTail);
  }, []);

  const count = lines.length;
  React.useEffect(() => {
    if (!following || count === 0) return;
    virtualizer.scrollToIndex(count - 1, { align: "end" });
  }, [following, count, virtualizer]);

  /**
   * The tail also has to survive the *box* changing under it.
   *
   * On a phone this panel is an eight-line tail that can be opened to the full
   * transcript (descent-stage.tsx), and growing a scroller from 160px to 500px
   * without moving its scrollTop lands the operator in the middle of the walk —
   * they asked for more of the log and got a different part of it. Same story
   * for a rotation. The effect above only fires when a line arrives, so the
   * resize needs its own trigger; the refs keep it subscribed once rather than
   * re-observing on every line.
   */
  const followingRef = React.useRef(following);
  followingRef.current = following;
  const countRef = React.useRef(count);
  countRef.current = count;

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      if (!followingRef.current || countRef.current === 0) return;
      virtualizer.scrollToIndex(countRef.current - 1, { align: "end" });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [virtualizer]);

  const resume = () => {
    setFollowing(true);
    if (count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        // A log is a live region for a sighted operator watching it move; for a
        // screen reader it is twenty paths a second of noise. The status bar
        // under the board is the spoken channel (it is aria-live), so this is
        // a plain scrollable region with a name.
        role="log"
        aria-label="Subsystem walk"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 py-2"
      >
        {/* mt-auto, not justify-end: a column flex container with
            justify-content:flex-end makes the overflowing top of a scrolled
            list unreachable. This hangs the log from the bottom edge the way
            a terminal does — new lines push the old ones up, and the tail the
            eye is following never floats in a void — while leaving the scroll
            behaviour completely ordinary once it fills. */}
        <div
          className="relative mt-auto w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((row) => {
            const line = lines[row.index];
            if (!line) return null;
            return (
              <LogRow
                key={line.key}
                line={line}
                // Distance from the tail decides the luminance tier, so the
                // brightest line is always the newest one — which during a
                // sweep is the line that just arrived.
                fromTail={count - 1 - row.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: row.size,
                  transform: `translateY(${row.start}px)`,
                }}
              />
            );
          })}
        </div>
      </div>

      {following ? null : (
        // A MachineControl rather than a hand-rolled box: it is a chip on this
        // instrument like every other one, so it inverts under the pointer,
        // lights under a finger, and grows the same invisible 10px touch margin
        // on coarse pointers. `bg-bg` because this one floats over a scrolling
        // log and the lines must not read through it.
        <MachineControl onClick={resume} className="absolute right-3 bottom-2 z-10 bg-bg">
          Resume tail
        </MachineControl>
      )}
    </div>
  );
}

function LogRow({
  line,
  fromTail,
  style,
}: {
  line: ScanLogLine;
  fromTail: number;
  style: React.CSSProperties;
}) {
  const current = fromTail === 0;
  const recent = fromTail <= RECENT_LINES;
  const tone = KIND_TONE[line.kind];

  return (
    <div
      data-kind={line.kind}
      style={style}
      className={cn(
        "flex items-center gap-2 text-small whitespace-pre",
        // Status lines keep their colour at every age; the walk dims with it.
        tone || (current ? "text-ink" : recent ? "text-ink-soft" : "text-ink-muted"),
        current && !tone && "text-ink",
      )}
    >
      <span className={cn("shrink-0 tnum", tone ? "opacity-80" : "text-ink-muted")}>
        {line.gutter}
      </span>
      {/* At desktop widths the column is sized so nothing truncates; below that
          it will, and a walked path the operator cannot finish reading is worth
          a tooltip. */}
      <span className="truncate" title={line.kind === "walk" ? line.text : undefined}>
        {line.text}
      </span>
      {line.trailing ? (
        <span className="ml-auto shrink-0 pl-3 tnum text-ink-muted">{line.trailing}</span>
      ) : null}
      {/* The cursor sits on the newest line only — one moving thing in a column
          of still ones, which is what makes the column read as live. */}
      {current ? (
        <span aria-hidden className="ml-1 shrink-0 text-ink">
          █
        </span>
      ) : null}
    </div>
  );
}
