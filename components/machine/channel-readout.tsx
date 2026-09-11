"use client";

import * as React from "react";
import { JOINTS } from "@/components/console";
import { type DiagChannel } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { machineJoint, pad2 } from "./scan-copy";
import {
  channelTone,
  gainRatio,
  rmsDelta,
  type ChannelTone,
} from "@/lib/diagnostics/waveform-math";

/**
 * The numbers under the traces.
 *
 * The eva boards are full of small value columns pinned beside whatever they
 * describe (eva-layer-status-red-grid puts one down the right of its scanning
 * field), and that adjacency is the point: a reading belongs next to the thing
 * it is a reading *of*. These two columns are what the strips above cannot
 * say — how far each live trace actually sits from its reference, and by what
 * factor its amplitude is wrong.
 *
 * They used to be in the walk log, which was one place too far from the traces
 * and one place too many overall. The log is the *process* — what the scanner
 * touched, in order. This is the *measurement*. Splitting them that way took a
 * duplicated number out of the product and gave the sweep panel the dense
 * value column its reference has.
 *
 * Both figures are computed here from the channel payload, using the same
 * thresholds the strips colour with. Nothing is read off the wire as a verdict:
 * `1.62x` is arithmetic on 120 samples the operator can see above it.
 */

const TONE_TEXT: Record<ChannelTone, string> = {
  nominal: "text-ink-soft",
  warn: "text-warn",
  alert: "text-alert",
};

export function ChannelReadout({ channels }: { channels: DiagChannel[] }) {
  const byJoint = React.useMemo(() => {
    const map = new Map<string, DiagChannel>();
    for (const c of channels) map.set(c.joint, c);
    return map;
  }, [channels]);

  return (
    <div className="shrink-0 border-t border-line px-3 py-2">
      <div className="flex items-center gap-2 pb-1 text-label text-ink-muted uppercase">
        <span className="w-8 shrink-0">Ch</span>
        <span className="flex-1">Joint</span>
        <span className="w-16 shrink-0 text-right">Rms Δ</span>
        <span className="w-14 shrink-0 text-right">Gain</span>
      </div>

      {JOINTS.map((joint, i) => {
        const channel = byJoint.get(joint);
        const delta = channel ? rmsDelta(channel.wave, channel.ref) : null;
        const gain = channel ? gainRatio(channel.wave, channel.ref) : null;
        const tone = delta === null ? "nominal" : channelTone(delta);

        return (
          <div
            key={joint}
            data-channel={joint}
            className={cn(
              "flex items-center gap-2 text-small",
              channel ? TONE_TEXT[tone] : "text-ink-muted",
            )}
          >
            <span className="w-8 shrink-0 tnum text-ink-muted">{pad2(i + 1)}</span>
            <span className="flex-1 truncate">{machineJoint(joint)}</span>
            {/* An em dash, not a zero: a channel that has not reported has no
                reading, and printing 0.000 for it would be the panel making one
                up. */}
            <span className="w-16 shrink-0 text-right tnum">
              {delta === null ? "—" : delta.toFixed(3)}
            </span>
            <span className="w-14 shrink-0 text-right tnum">
              {gain === null ? "—" : `${gain.toFixed(2)}×`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
