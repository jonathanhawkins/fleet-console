"use client";

import Link from "next/link";
import { type UnitStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { unitStatusChip, unitStatusCopy } from "@/components/console";

const DOT_TONE = {
  nominal: "bg-nominal",
  warn: "bg-warn",
  alert: "bg-alert",
} as const;

/**
 * A member, as a door to its unit page. A white pill rather than a StatusChip:
 * a warn-tinted chip on a warn-tinted card is invisible. The status survives
 * as a dot; the accessible name carries the word behind the colour.
 */
export function MemberChip({
  unitId,
  status,
}: {
  unitId: string;
  status: UnitStatus | undefined;
}) {
  const chip = status ? unitStatusChip(status) : "nominal";
  return (
    <Link
      href={`/unit/${unitId}`}
      data-slot="cohort-member"
      data-status={chip}
      // Visible id leads so the accessible name and the label agree (WCAG 2.5.3).
      aria-label={status ? `${unitId}, ${unitStatusCopy(status)}` : unitId}
      className={cn(
        "inline-flex items-center gap-2 rounded-pill border border-line-strong bg-bg px-2.5 py-1",
        "tnum text-label tracking-normal text-ink",
        "transition-colors duration-[var(--dur-micro)] ease-console hover:bg-surface",
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", DOT_TONE[chip])}
      />
      {unitId}
    </Link>
  );
}
