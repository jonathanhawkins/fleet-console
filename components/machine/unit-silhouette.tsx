"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Our own robot, drawn front elevation.
 *
 * Original artwork, and it has to be: no third-party render and no EVA frame appears
 * anywhere in this product (CLAUDE.md, PRD §2). What it borrows instead is the
 * grammar already established by the fleet map's house glyph — hairline stroke,
 * no fill, geometric volumes, nothing shaded — so the machine's picture of
 * itself is recognisably from the same hand as the operator's picture of a
 * home.
 *
 * It is an *elevation*, not an illustration: a technical drawing of a
 * six-jointed leg assembly with the joints marked as the board's rows name
 * them, drawn flat and symmetrical, with L and R called out. That callout is
 * the one detail worth being pedantic about — this is a front view, so the
 * robot's left knee is on the *viewer's right*, and a diagnostic board that
 * silently mirrored the failing joint would be a genuinely dangerous
 * convenience. Engineering drawings label the sides; so does this.
 *
 * The joint markers are addressable by id so the board can measure one and run
 * a leader line to its manifest row.
 */

/** Joint marker positions in the 120×280 drawing space, keyed by wire name. */
const JOINT_MARKS: Record<string, { x: number; y: number }> = {
  hip_R: { x: 49, y: 146 },
  hip_L: { x: 71, y: 146 },
  knee_R: { x: 47, y: 194 },
  knee_L: { x: 73, y: 194 },
  ankle_R: { x: 45, y: 240 },
  ankle_L: { x: 75, y: 240 },
};

export const SILHOUETTE_VIEWBOX = { width: 120, height: 280 };

export interface UnitSilhouetteProps {
  /** Wire name of the joint to mark as damaged, e.g. "knee_L". */
  damagedJoint?: string | null;
  /** Ref onto the damaged joint's marker, for the board's leader line. */
  markRef?: React.Ref<SVGGElement>;
  className?: string;
}

export function UnitSilhouette({
  damagedJoint,
  markRef,
  className,
}: UnitSilhouetteProps) {
  const damaged = damagedJoint ? JOINT_MARKS[damagedJoint] : undefined;
  const hatchId = React.useId();

  return (
    <svg
      viewBox={`0 0 ${SILHOUETTE_VIEWBOX.width} ${SILHOUETTE_VIEWBOX.height}`}
      role="img"
      aria-label={
        damagedJoint
          ? `Unit elevation, ${damagedJoint.replace("_", " ")} marked damaged`
          : "Unit elevation"
      }
      className={cn("block h-full w-full", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.1}
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      <defs>
        {/*
          The reference fills its damaged regions with horizontal rules rather
          than with flat colour — which is what makes the damage read as
          *annotation over a drawing* instead of as part of the drawing. Same
          idea here, at 3px pitch.
        */}
        <pattern id={hatchId} width="4" height="3" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0.5" x2="4" y2="0.5" stroke="var(--alert)" strokeWidth="1" />
        </pattern>
      </defs>

      {/* -- head and neck -------------------------------------------------- */}
      <g className="text-ink-muted">
        <rect x="48" y="16" width="24" height="26" />
        <path d="M53 24h14M53 30h14" strokeWidth="0.7" />
        <path d="M60 42v10" />
      </g>

      {/* -- torso ----------------------------------------------------------- */}
      <g className="text-ink-soft">
        <path d="M38 52h44" />
        <path d="M41 52 L79 52 L76 122 L44 122 Z" />
        {/* chassis rules: three plates, the drawing's only interior detail */}
        <path
          d="M44 74h32M45 92h30M46 108h28"
          strokeWidth="0.6"
          className="text-ink-muted"
        />
        {/* pelvis */}
        <path d="M44 122 L76 122 L74 144 L46 144 Z" />
      </g>

      {/* -- arms ------------------------------------------------------------ */}
      <g className="text-ink-muted">
        <path d="M38 55 L31 96 L34 130" />
        <path d="M82 55 L89 96 L86 130" />
        <rect x="29" y="130" width="8" height="12" />
        <rect x="83" y="130" width="8" height="12" />
      </g>

      {/* -- legs ------------------------------------------------------------ */}
      <g className="text-ink-soft">
        {/* viewer-left = robot RIGHT */}
        <path d="M49 146 L47 194 L45 240" />
        <path d="M55 146 L53 194 L51 240" />
        <path d="M40 240 h18 v8 h-18 z" />
        {/* viewer-right = robot LEFT */}
        <path d="M71 146 L73 194 L75 240" />
        <path d="M65 146 L67 194 L69 240" />
        <path d="M62 240 h18 v8 h-18 z" />
      </g>

      {/* -- joint markers --------------------------------------------------- */}
      {Object.entries(JOINT_MARKS).map(([joint, p]) => {
        const isDamaged = joint === damagedJoint;
        return (
          <rect
            key={joint}
            x={p.x - 3.5}
            y={p.y - 3.5}
            width="7"
            height="7"
            className={isDamaged ? "text-alert" : "text-ink-muted"}
            strokeWidth={isDamaged ? 1.4 : 1}
          />
        );
      })}

      {/* -- damage annotation ------------------------------------------------ */}
      {damaged ? (
        <g ref={markRef} data-damage-mark>
          <rect
            x={damaged.x - 13}
            y={damaged.y - 15}
            width="26"
            height="30"
            fill={`url(#${hatchId})`}
            stroke="var(--alert)"
            strokeWidth="1"
            opacity={0.9}
          />
        </g>
      ) : null}

      {/* -- side callouts ---------------------------------------------------
          Front elevation: the robot's left is the viewer's right. Saying so is
          not pedantry on a board whose job is to point at one joint. */}
      <g className="text-ink-muted" strokeWidth="0.8">
        <text
          x="26"
          y="152"
          fill="currentColor"
          stroke="none"
          fontSize="7"
          letterSpacing="0.1em"
        >
          R
        </text>
        <text
          x="92"
          y="152"
          fill="currentColor"
          stroke="none"
          fontSize="7"
          letterSpacing="0.1em"
        >
          L
        </text>
      </g>
    </svg>
  );
}

/** Where a joint's marker sits, as a fraction of the drawing box. Board math. */
export function jointMarkFraction(joint: string): { x: number; y: number } | null {
  const p = JOINT_MARKS[joint];
  if (!p) return null;
  return { x: p.x / SILHOUETTE_VIEWBOX.width, y: p.y / SILHOUETTE_VIEWBOX.height };
}
