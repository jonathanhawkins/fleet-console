"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  COMPONENT_LABELS,
  COMPONENT_ORDER,
  type ComponentHighlight,
  type ComponentId,
} from "./component-spec";

/**
 * The chassis as a front elevation, in operator space — the component view's
 * ground state and its honest fallback.
 *
 * It is on screen twice. Once for the second or two before the 3D chunk and
 * its GLB have landed, so the section is never a hole in the page or a
 * spinner; and permanently on any machine without WebGL, where it is not a
 * degraded experience but the same experience with fewer dimensions: the eight
 * components are here, they select the same way, they carry the same chip, and
 * the incident marks the same part. A section that showed a broken canvas
 * instead would be telling an operator their robot is unreadable because their
 * GPU is.
 *
 * The drawing grammar is the fleet map's house glyph and the machine board's
 * elevation: hairline stroke, no fill, geometric volumes, nothing shaded. It is
 * deliberately a separate file from components/machine/unit-silhouette.tsx
 * rather than a shared abstraction over it — that one is a *joint* diagram in
 * phosphor with damage hatching, this one is a *component* diagram in warm ink
 * with hit regions, and the only thing they genuinely share is a robot's
 * proportions. Merging them would mean one component with two vocabularies and
 * a space prop, which the token layer exists to avoid.
 */

/** The drawing, grouped the way the chassis is: one entry per selectable part. */
const PARTS: Record<ComponentId, { art: React.ReactNode; hit: React.ReactNode }> = {
  head: {
    art: (
      <>
        <rect x="48" y="16" width="24" height="26" />
        <path d="M53 24h14M53 30h14" strokeWidth="0.7" />
        <path d="M60 42v10" />
      </>
    ),
    hit: <rect x="44" y="12" width="32" height="42" />,
  },
  torso: {
    art: (
      <>
        <path d="M38 52h44" />
        <path d="M41 52 L79 52 L76 122 L44 122 Z" />
        <path d="M44 74h32M45 92h30M46 108h28" strokeWidth="0.6" opacity="0.7" />
        <path d="M44 122 L76 122 L74 144 L46 144 Z" />
      </>
    ),
    hit: <rect x="38" y="50" width="44" height="96" />,
  },
  // Front elevation: the robot's left limb is on the viewer's right.
  arm_L: {
    art: (
      <>
        <path d="M82 55 L89 96 L86 130" />
        <rect x="83" y="130" width="8" height="12" />
      </>
    ),
    hit: <rect x="80" y="52" width="14" height="92" />,
  },
  arm_R: {
    art: (
      <>
        <path d="M38 55 L31 96 L34 130" />
        <rect x="29" y="130" width="8" height="12" />
      </>
    ),
    hit: <rect x="26" y="52" width="14" height="92" />,
  },
  leg_L: {
    art: (
      <>
        <path d="M71 146 L73 194 L75 240" />
        <path d="M65 146 L67 194 L69 240" />
        <path d="M62 240 h18 v8 h-18 z" />
      </>
    ),
    hit: <rect x="61" y="146" width="20" height="102" />,
  },
  leg_R: {
    art: (
      <>
        <path d="M49 146 L47 194 L45 240" />
        <path d="M55 146 L53 194 L51 240" />
        <path d="M40 240 h18 v8 h-18 z" />
      </>
    ),
    hit: <rect x="39" y="146" width="20" height="102" />,
  },
  knee_actuator_L: {
    art: (
      <>
        <rect x="64.5" y="188" width="10" height="12" />
        <path d="M69.5 188v-4M69.5 200v4" strokeWidth="0.7" />
      </>
    ),
    hit: <rect x="62" y="184" width="15" height="20" />,
  },
  knee_actuator_R: {
    art: (
      <>
        <rect x="45.5" y="188" width="10" height="12" />
        <path d="M50.5 188v-4M50.5 200v4" strokeWidth="0.7" />
      </>
    ),
    hit: <rect x="43" y="184" width="15" height="20" />,
  },
};

/** Drawing box plus the margin that matches the 3D viewer's framing. */
const VIEW_BOX = "-32 -34 184 348";

export interface ComponentElevationProps {
  selected: ComponentId | null;
  highlight: ComponentHighlight | null;
  /** Null clears the selection; the same contract the 3D viewer uses. */
  onSelect?: (id: ComponentId | null) => void;
  /**
   * False while this is only holding the frame for a 3D viewer still loading:
   * the drawing renders, nothing responds, and screen readers skip it because
   * the interactive copy is about to replace it.
   */
  interactive?: boolean;
  className?: string;
}

export function ComponentElevation({
  selected,
  highlight,
  onSelect,
  interactive = true,
  className,
}: ComponentElevationProps) {
  return (
    <svg
      viewBox={VIEW_BOX}
      preserveAspectRatio="xMidYMid meet"
      role={interactive ? "img" : "presentation"}
      aria-hidden={interactive ? undefined : true}
      aria-label={interactive ? "Unit chassis, front elevation" : undefined}
      className={cn("block h-full w-full", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.1}
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      {COMPONENT_ORDER.map((id) => {
        const part = PARTS[id];
        const marked = highlight?.id === id;
        const isSelected = selected === id;
        return (
          <g key={id} data-component={id}>
            <g
              className={cn(
                "transition-colors duration-[var(--dur-enter)] ease-console",
                marked
                  ? highlight.tone === "alert"
                    ? "text-alert"
                    : "text-warn"
                  : isSelected
                    ? "text-ink"
                    : "text-ink-muted",
              )}
              strokeWidth={marked || isSelected ? 1.5 : 1.1}
            >
              {part.art}
            </g>
            {interactive ? (
              <g
                className="cursor-pointer text-transparent"
                fill="currentColor"
                stroke="none"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect?.(isSelected ? null : id);
                }}
              >
                <title>{COMPONENT_LABELS[id]}</title>
                {part.hit}
              </g>
            ) : null}
          </g>
        );
      })}

      {/* Front elevation, so the sides are called out — the same pedantry the
          machine board insists on, for the same reason. */}
      <g className="text-ink-muted" stroke="none" fill="currentColor">
        <text x="18" y="152" fontSize="7" letterSpacing="0.14em">
          R
        </text>
        <text x="96" y="152" fontSize="7" letterSpacing="0.14em">
          L
        </text>
      </g>
    </svg>
  );
}
