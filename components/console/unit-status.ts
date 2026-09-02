import { type AlertSeverity, type UnitStatus } from "@/lib/schema";
import { type StatusChipStatus } from "./status-chip";

/**
 * One translation table, used by the map marker, the rail row and the alert
 * feed — so a unit cannot be amber in one region and warn in another.
 *
 * The wire says `nominal | amber | red`, which is the *sim's* vocabulary. The
 * design system says `nominal | warn | alert`, which is the token vocabulary
 * (--nominal / --warn / --alert). Keeping the two apart means the palette can
 * be renamed without touching the message contract, and it is why every
 * status-bearing element in this phase carries `data-status` in design-system
 * terms: one CSS rule per token, no per-component mapping.
 *
 * `AlertSeverity` ("amber" | "red") is a subset of `UnitStatus`, so severities
 * read from the same table rather than a parallel one that could drift.
 */
export const UNIT_STATUS_CHIP: Record<UnitStatus, StatusChipStatus> = {
  nominal: "nominal",
  amber: "warn",
  red: "alert",
};

/**
 * Operator-space copy: plain words a homeowner would use, sentence case, no
 * jargon and no severity codes. "Attention" rather than WARN because the
 * operator's question is "does this need me?", not "what enum is this?".
 */
export const UNIT_STATUS_COPY: Record<UnitStatus, string> = {
  nominal: "Nominal",
  amber: "Attention",
  red: "Alert",
};

export function unitStatusChip(status: UnitStatus): StatusChipStatus {
  return UNIT_STATUS_CHIP[status];
}

export function unitStatusCopy(status: UnitStatus): string {
  return UNIT_STATUS_COPY[status];
}

export function alertSeverityChip(severity: AlertSeverity): StatusChipStatus {
  return UNIT_STATUS_CHIP[severity];
}

export function alertSeverityCopy(severity: AlertSeverity): string {
  return UNIT_STATUS_COPY[severity];
}

/** A unit that is neither amber nor red needs nothing from the operator. */
export function needsAttention(status: UnitStatus): boolean {
  return status !== "nominal";
}
