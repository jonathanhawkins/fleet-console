"use client";

import * as React from "react";
import { type StorylineChapterName } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { clearLocalStoryline } from "./storyline-reset";
import { sendCommand } from "./telemetry-command";

/**
 * Jump the storyline to a chapter.
 *
 * The fleet runs four stories on one clock and the last opens five and a half
 * minutes in. Nobody sits through that for a demo they did not build, so three
 * of the four were, in practice, unreachable: the cohort rollback and the
 * recalibration that actually succeeds — the counterweight to the one that
 * comes back PARTIAL — were work nobody ever saw.
 *
 * A chapter is not a scrubber. There is no timeline to drag and no clock on
 * screen, because the operator fiction does not have one: what this offers is
 * "show me the one where the route is blocked", and the sim replays from the
 * top and stops a few seconds short so the alert arrives while you are
 * watching. Pressing the same chapter twice lands on the same board both times.
 *
 * Volume: the same as `SimReset` beside it, for the same reason. These are the
 * demo admitting it is a demo, and they belong at the volume of the sentence
 * that says so — not competing with the console.
 */

interface Chapter {
  id: StorylineChapterName;
  label: string;
  /** The title attribute: which robot, and what goes wrong. */
  detail: string;
}

/**
 * Operator words, not engine words. Each names what an operator would see
 * arrive, which is also how the alert feed will phrase it seconds later.
 */
const CHAPTERS: readonly Chapter[] = [
  { id: "knee", label: "Knee fault", detail: "N-07: left knee actuator runs hot" },
  { id: "nav", label: "Blocked route", detail: "N-03: blocked route, recovers itself" },
  {
    id: "cohort",
    label: "Firmware cohort",
    detail: "Four units, one bad build, one rollback",
  },
  {
    id: "offset",
    label: "Ankle offset",
    detail: "N-01: the fault a recalibration fixes",
  },
];

export interface StorylineJumpProps {
  className?: string;
}

export function StorylineJump({ className }: StorylineJumpProps) {
  const [sent, setSent] = React.useState<StorylineChapterName | null>(null);

  const jump = React.useCallback((chapter: StorylineChapterName) => {
    if (!sendCommand({ c: "SEEK_STORYLINE", chapter })) return;
    clearLocalStoryline();
    setSent(chapter);
    window.setTimeout(() => setSent(null), 1200);
  }, []);

  return (
    <div
      data-slot="storyline-jump"
      className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1", className)}
    >
      {/* A group label rather than four unexplained words. `id` over
          aria-label so the visible text is the name — the same reason
          UnitCard spells "%" instead of "percent". */}
      <span id="storyline-jump-label" className="text-small text-ink-soft">
        Jump to
      </span>
      <div
        role="group"
        aria-labelledby="storyline-jump-label"
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
      >
        {CHAPTERS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => jump(c.id)}
            title={c.detail}
            className={cn(
              "rounded-sm text-small text-ink-soft underline-offset-4",
              "transition-colors duration-[var(--dur-micro)] ease-console",
              // Text controls have no box to compress, so the press is the
              // hover treatment arriving on pointer-down — the only feedback a
              // phone, where hover never happens, would otherwise get.
              "hover:text-ink hover:underline",
              "active:text-ink active:underline",
              sent === c.id && "text-ink underline",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
