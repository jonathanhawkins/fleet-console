"use client";

import * as React from "react";
import {
  JOINTS,
  SectionLabel,
  jointLabel,
  registerFrame,
  usePrefersReducedMotion,
} from "@/components/console";
import {
  channelTone,
  gainRatio,
  rmsDelta,
  writeSampleTones,
  type ChannelTone,
} from "@/lib/diagnostics/waveform-math";
import { type DiagChannel } from "@/lib/stores";
import { cn } from "@/lib/utils";
import {
  columnAmplitude,
  drawCell,
  readCellPalette,
  FALLBACK_CELL_PALETTE,
  type CellPalette,
} from "./channel-draw";

/**
 * Six channels, each against the calibration table it is supposed to match.
 *
 * A column, not a grid, and the reason is arithmetic rather than taste: a
 * column puts all six RMS readings in one vertical line of tabular figures, so
 * the outlier is found by digit count — `0.183` among five `0.00x` — before any
 * colour is read. A three-by-two grid scatters those six numbers across two
 * rows and destroys that scan. The column is also, deliberately, the shape of
 * the table in the filed incident report, with a trace cell added: the report
 * an operator hands to a technician is the screen they watched it on.
 *
 * ## All six rows exist from the first paint
 *
 * Channels arrive one at a time over about six seconds. A column that grew a
 * row per arrival would move the page under the operator six times during the
 * fifteen seconds they are meant to be reading it, and would push whatever they
 * were looking at down with it. So every row is here from the start with its
 * readings dashed, and a channel landing fills a cell that already existed.
 * Nothing reflows for the length of a scan.
 *
 * ## One frame subscription for the whole column
 *
 * Not one per row. Each row keeps a small runtime record — its canvas, its
 * context, its tone buffer, the version it last drew — and the single callback
 * walks the six and returns early for any row whose picture has not changed.
 * A settled column costs one comparison per row per frame and paints nothing.
 */

const REVEAL_MS = 900;

interface RowRuntime {
  joint: string;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  width: number;
  height: number;
  dpr: number;
  channel: DiagChannel | null;
  tones: Uint8Array | null;
  /** performance.now() when the channel landed, or 0 for one replayed in. */
  arrivedAt: number;
  /** -1 forces a repaint: a resize, a new channel, a palette change. */
  drawnProgress: number;
  drawnWidth: number;
}

const makeRuntime = (joint: string): RowRuntime => ({
  joint,
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  dpr: 1,
  channel: null,
  tones: null,
  arrivedAt: 0,
  drawnProgress: -1,
  drawnWidth: -1,
});

const TONE_CLASS: Record<ChannelTone, string> = {
  nominal: "text-ink",
  warn: "text-warn-ink",
  alert: "text-alert-ink",
};

export interface ChannelColumnProps {
  channels: readonly DiagChannel[];
  /** The flagged joint, once the scan has named it. */
  subject?: string | null;
}

export function ChannelColumn({ channels, subject = null }: ChannelColumnProps) {
  const reducedMotion = usePrefersReducedMotion();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const runtimes = React.useRef<RowRuntime[]>(JOINTS.map(makeRuntime));
  const palette = React.useRef<CellPalette>(FALLBACK_CELL_PALETTE);
  const amplitude = React.useRef(1);
  const instant = React.useRef(reducedMotion);
  instant.current = reducedMotion;

  const byJoint = React.useMemo(() => {
    const map = new Map<string, DiagChannel>();
    for (const c of channels) map.set(c.joint, c);
    return map;
  }, [channels]);

  /**
   * The two readings, computed once per arrival rather than per render.
   *
   * Same reasoning as the tone buffer below, and the same dependency: these are
   * O(120) loops over a channel that does not change after it lands, and this
   * component re-renders on every scan event — the panel above it subscribes to
   * the session, whose identity changes on each walk line. Recomputing twelve
   * loops to get the identical answer fifteen times a scan is work for nothing.
   */
  const readings = React.useMemo(() => {
    const map = new Map<string, { delta: number; gain: number; tone: ChannelTone }>();
    for (const [joint, channel] of byJoint) {
      const delta = rmsDelta(channel.wave, channel.ref);
      map.set(joint, {
        delta,
        gain: gainRatio(channel.wave, channel.ref),
        tone: channelTone(delta),
      });
    }
    return map;
  }, [byJoint]);

  /**
   * Adopt arrivals. The tone buffer is computed here — once per channel — and
   * not in the draw: it is the same answer every frame, and recomputing 120
   * sliding windows six times a frame to get it would be the one allocation in
   * this component's steady state turned into sixty a second.
   */
  React.useEffect(() => {
    let landed = false;
    for (const rt of runtimes.current) {
      const channel = byJoint.get(rt.joint);
      if (!channel || rt.channel === channel) continue;
      rt.channel = channel;
      const n = Math.min(channel.wave.length, channel.ref.length);
      rt.tones = new Uint8Array(n);
      writeSampleTones(channel.wave, channel.ref, rt.tones);
      rt.arrivedAt = instant.current ? 0 : performance.now();
      rt.drawnProgress = -1;
      landed = true;
    }
    if (landed) {
      amplitude.current = columnAmplitude(channels);
      // A new peak rescales every cell, so every cell has to repaint.
      for (const rt of runtimes.current) rt.drawnProgress = -1;
    }
  }, [byJoint, channels]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    palette.current = readCellPalette(container);

    const observer = new ResizeObserver(() => {
      const dpr = globalThis.devicePixelRatio || 1;
      for (const rt of runtimes.current) {
        const canvas = rt.canvas;
        if (!canvas) continue;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        rt.width = rect.width;
        rt.height = rect.height;
        rt.dpr = dpr;
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        rt.drawnProgress = -1;
        rt.drawnWidth = rect.width;
      }
    });
    observer.observe(container);
    for (const rt of runtimes.current) if (rt.canvas) observer.observe(rt.canvas);

    const stop = registerFrame((now) => {
      for (const rt of runtimes.current) {
        if (!rt.channel || !rt.canvas || rt.width === 0) continue;
        rt.ctx ??= rt.canvas.getContext("2d");
        if (!rt.ctx) continue;

        const elapsed = rt.arrivedAt === 0 ? REVEAL_MS : now - rt.arrivedAt;
        const progress = Math.min(1, Math.max(0, elapsed / REVEAL_MS));
        // Settled and unchanged: the common case, and it paints nothing.
        if (progress === rt.drawnProgress && rt.width === rt.drawnWidth) continue;

        drawCell({
          ctx: rt.ctx,
          width: rt.width,
          height: rt.height,
          dpr: rt.dpr,
          palette: palette.current,
          wave: rt.channel.wave,
          ref: rt.channel.ref,
          tones: rt.tones,
          progress,
          amplitude: amplitude.current,
        });
        rt.drawnProgress = progress;
        rt.drawnWidth = rt.width;
      }
    });

    return () => {
      observer.disconnect();
      stop();
    };
  }, []);

  return (
    <div ref={containerRef} className="mt-4">
      <div
        role="table"
        aria-label="Channels measured against their calibration reference"
        className="w-full"
      >
        <div role="row" className="flex items-end gap-4 border-b border-line pb-2">
          <SectionLabel as="span" role="columnheader" className="w-28 shrink-0">
            Joint
          </SectionLabel>
          <SectionLabel as="span" role="columnheader" className="min-w-0 flex-1">
            Live vs reference
          </SectionLabel>
          <SectionLabel
            as="span"
            role="columnheader"
            className="w-16 shrink-0 text-right"
          >
            RMS Δ
          </SectionLabel>
          <SectionLabel
            as="span"
            role="columnheader"
            className="w-16 shrink-0 text-right"
          >
            Gain
          </SectionLabel>
        </div>

        {JOINTS.map((joint, index) => {
          const channel = byJoint.get(joint);
          const reading = readings.get(joint);
          const delta = reading?.delta ?? null;
          const gain = reading?.gain ?? null;
          const tone = reading?.tone ?? "nominal";
          const flagged = subject === joint;

          return (
            <div
              role="row"
              key={joint}
              data-channel={joint}
              data-subject={flagged ? "" : undefined}
              className={cn(
                "flex items-center gap-4 border-b border-line py-2",
                flagged && "bg-alert-tint",
              )}
            >
              <div
                role="rowheader"
                className={cn(
                  "flex w-28 shrink-0 flex-col text-small text-ink",
                  flagged && "font-medium",
                )}
              >
                {jointLabel(joint)}
                {flagged ? (
                  <SectionLabel as="span" className="text-alert-ink">
                    Subject
                  </SectionLabel>
                ) : null}
              </div>

              <div role="cell" className="relative h-14 min-w-0 flex-1 overflow-hidden">
                <canvas
                  aria-hidden
                  ref={(el) => {
                    const rt = runtimes.current[index];
                    if (rt) {
                      rt.canvas = el;
                      rt.ctx = el?.getContext("2d") ?? null;
                      rt.drawnProgress = -1;
                    }
                  }}
                  className="absolute inset-0 block size-full"
                />
                {!channel ? (
                  <span className="absolute inset-0 flex items-center text-small text-muted">
                    —
                  </span>
                ) : null}
              </div>

              <div
                role="cell"
                className={cn(
                  "w-16 shrink-0 text-right tnum text-small",
                  delta === null ? "text-muted" : TONE_CLASS[tone],
                )}
              >
                {delta === null ? "—" : delta.toFixed(3)}
              </div>
              <div
                role="cell"
                className={cn(
                  "w-16 shrink-0 text-right tnum text-small",
                  gain === null ? "text-muted" : TONE_CLASS[tone],
                )}
              >
                {gain === null ? "—" : `${gain.toFixed(2)}×`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
