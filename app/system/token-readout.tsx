"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The gallery reports what the browser actually resolved, never a hand-copied
 * hex. Half of these tokens are color-mix() expressions that no static table
 * could state correctly, and a swatch sheet that can drift from its stylesheet
 * is worse than no swatch sheet.
 */
function toHex(computed: string): string {
  const rgb = computed.match(/rgba?\(([^)]+)\)/);
  if (rgb?.[1]) {
    const parts = rgb[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return hex(parts.slice(0, 3));
  }
  // color-mix() resolves to the color() function in Chromium
  const srgb = computed.match(/color\(srgb\s+([^)]+)\)/);
  if (srgb?.[1]) {
    const parts = srgb[1]
      .split(/[\s/]+/)
      .filter(Boolean)
      .map((n) => Number(n) * 255);
    return hex(parts.slice(0, 3));
  }
  return computed;
}

function hex(channels: number[]): string {
  return (
    "#" +
    channels
      .map((c) =>
        Math.round(Math.max(0, Math.min(255, c)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase()
  );
}

export interface TokenSwatchProps {
  /** CSS custom property name, without the leading dashes. */
  token: string;
  /** What the token is for, in the space's own voice. */
  role: string;
  /** A usage ruling this token carries — printed with the swatch, not in a wiki. */
  note?: string;
}

export function TokenSwatch({ token, role, note }: TokenSwatchProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!ref.current) return;
    setValue(toHex(getComputedStyle(ref.current).backgroundColor));
  }, []);

  return (
    <div className="flex flex-col gap-2.5">
      <div
        ref={ref}
        className="h-20 w-full rounded-md border border-line-strong machine:h-12"
        style={{ backgroundColor: `var(--${token})` }}
      />
      <div className="flex flex-col gap-0.5">
        <span className="text-small text-ink">--{token}</span>
        {/* --ink-soft, not --muted: an 11px readout is exactly what the --muted
            ruling excludes (see app/globals.css). Machine space keeps its dim
            phosphor tier, which that ruling does not govern. */}
        <span className="tnum text-label text-ink-soft tabular-nums machine:text-ink-muted">
          {value || " "}
        </span>
        <span className="text-label text-ink-soft normal-case machine:text-ink-muted machine:uppercase">
          {role}
        </span>
        {note ? (
          <span className="mt-2 border-t border-line pt-2 text-label text-ink-soft normal-case machine:text-ink-muted machine:uppercase">
            {note}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Written out literally, never interpolated: Tailwind scans source text, so a
 * `text-${step}` template would compile to nothing at all.
 */
const STEP_CLASS = {
  display: "text-display case-heading",
  title: "text-title case-heading",
  heading: "text-heading case-heading",
  body: "text-body",
  small: "text-small",
  label: "text-label uppercase",
} as const;

export type TypeStep = keyof typeof STEP_CLASS;

export interface TypeSpecimenProps {
  /** Type step name — matches the `text-{step}` utility. */
  step: TypeStep;
  /** A sentence in the voice of whichever space this renders in. */
  children: React.ReactNode;
}

export function TypeSpecimen({ step, children }: TypeSpecimenProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [metrics, setMetrics] = useState("");

  useEffect(() => {
    if (!ref.current) return;
    const c = getComputedStyle(ref.current);
    // letter-spacing computes to the keyword `normal` at zero, not to "0px"
    const px = (v: string) => {
      const n = parseFloat(v);
      return `${Number.isNaN(n) ? 0 : Math.round(n * 100) / 100}px`;
    };
    setMetrics(
      [px(c.fontSize), px(c.lineHeight), px(c.letterSpacing), c.fontWeight].join("  "),
    );
  }, []);

  return (
    // three columns only from lg: at tablet the fixed-width metrics readout and
    // a 44px display specimen cannot share a row without overflowing the page
    <div className="grid items-baseline gap-x-8 gap-y-2 border-b border-line py-6 lg:grid-cols-[110px_1fr_auto] machine:py-3">
      <span className="text-label text-ink-soft machine:text-ink-muted">{step}</span>
      <p ref={ref} className={cn(STEP_CLASS[step], "text-ink")}>
        {children}
      </p>
      <span className="tnum text-label whitespace-pre text-ink-soft machine:text-ink-muted">
        {metrics || " "}
      </span>
    </div>
  );
}
