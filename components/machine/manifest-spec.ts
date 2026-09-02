import { type DiagSession } from "@/lib/stores";

/**
 * The parts manifest: what the scan checks, and how each row learns its state.
 *
 * This is the eva parts-status board (eva-parts-status-operating-damaged.png)
 * — a numbered inventory whose rows flip to OPERATING as the machine clears
 * them and to an inverted DAMAGED block where it does not. What that reference
 * does *not* have, and what this one must, is a rule for where each row's
 * answer comes from.
 *
 * **Every row is earned by an event.** Six of them are the actuator bus, and
 * they clear when their channel is measured; the other nine clear when the
 * subsystem walk reaches the node that checks them. Nothing is seeded
 * "OPERATING", nothing flips on a timer, and there is no row for a component
 * the wire never mentions.
 *
 * That last rule cost the board a `TORSO_YAW` row, which the design called for
 * and which would have added a pleasing amount of density. Nothing in the scan
 * checks a torso yaw. A row claiming OPERATING for it would have been the one
 * lie on a board whose entire job is to be true, so it is not here — and the
 * upper-body joints it would have brought with it are not here either. The
 * density comes from the nine subsystem rows instead, which have the added
 * virtue of making the walk log and the board reinforce each other: the paths
 * streaming down the left column are visibly the reason the chips on the right
 * are flipping.
 */

/**
 * `restored` is the fourth state and the newest: a row that was stamped DAMAGED
 * and whose channel the machine has since measured back inside its envelope.
 *
 * It is not folded into `operating`, and the distinction is the point. Fourteen
 * rows on this board cleared because the scan checked them and they answered;
 * this one cleared because a fault was found in it and then corrected. Printing
 * both as OPERATING would leave the board with no memory of the only row the
 * whole diagnostic was about — and would make the single most important state
 * change on the surface look like the fourteen that were never in doubt.
 */
export type ManifestState = "pending" | "operating" | "damaged" | "restored";

export interface ManifestRow {
  /** Uppercase wire-ish identifier, the row's display name. */
  id: string;
  /** Actuator tag where the component has one — the A-07 of the verdict. */
  tag?: string;
  group: ManifestGroup;
  /** Bus rows clear when this joint's channel is measured. */
  joint?: string;
  /** Structure rows clear when this exact walk path streams. */
  path?: string;
  /** …or when `count` paths under this prefix have. */
  prefix?: string;
  count?: number;
}

export type ManifestGroup = "bus" | "structure";

export const MANIFEST_GROUP_LABEL: Record<ManifestGroup, string> = {
  bus: "Actuator bus · locomotion",
  structure: "Structure · firmware",
};

/**
 * Ordinals are positional and start at 0001, exactly as the reference sets
 * them. The order is the order the scan clears them in — bus first because
 * that is what the six channels are, then the subsystems the walk covers.
 */
export const MANIFEST_ROWS: readonly ManifestRow[] = [
  { id: "HIP_L", tag: "A03", group: "bus", joint: "hip_L" },
  { id: "HIP_R", tag: "A04", group: "bus", joint: "hip_R" },
  { id: "KNEE_L", tag: "A07", group: "bus", joint: "knee_L" },
  { id: "KNEE_R", tag: "A08", group: "bus", joint: "knee_R" },
  { id: "ANKLE_L", tag: "A11", group: "bus", joint: "ankle_L" },
  { id: "ANKLE_R", tag: "A12", group: "bus", joint: "ankle_R" },

  { id: "SPINE_BUS", group: "structure", path: "/sys/actuator_bus/enumerate" },
  { id: "POWER_RAIL_48V", group: "structure", path: "/sys/core/power_rail/v48_main" },
  { id: "THERMAL_MAP", group: "structure", path: "/sys/core/thermal/zone_map.cfg" },
  { id: "HEARTBEAT_SVC", group: "structure", path: "/sys/core/heartbeat.svc" },
  { id: "PELVIS_PARK", group: "structure", path: "/firmware/gait/park_pose.ko" },
  { id: "GAIT_CYCLE", group: "structure", path: "/firmware/gait/walk_cycle.ko" },
  { id: "BALANCE_REFLEX", group: "structure", path: "/firmware/gait/balance_reflex.ko" },
  // One row for six nodes: the calibration tables are checked per joint but
  // read as one subsystem, and the fraction is worth more on the board than
  // six near-identical rows would be.
  { id: "GAIN_TABLES", group: "structure", prefix: "/calib/", count: 6 },
  { id: "IMU_FUSION", group: "structure", path: "/proprio/imu/fusion_state" },
];

export interface ManifestEntry {
  row: ManifestRow;
  /** 1-based position on the board — the 0001 in the gutter. */
  ordinal: number;
  state: ManifestState;
  /** Progress for a row that covers several nodes, e.g. "4/6". */
  detail?: string;
}

/**
 * Project the session onto the board.
 *
 * Pure, and derived on every render rather than latched, for the same reason
 * the log is: a session that gets its emitted prefix replayed after a
 * reconnect, or a page refreshed mid-scan that adopts a scan already running,
 * must produce exactly the board the events justify — no more (a latched chip
 * surviving an aborted session) and no less (a replayed channel counted twice).
 */
export function buildManifest(session: DiagSession | null): ManifestEntry[] {
  const walked = session?.walkLines ?? [];
  const channels = session?.channels ?? [];
  const flaggedJoint = session?.flag?.joint ?? null;
  /**
   * The board consumes the recalibration for the same reason it consumes the
   * flag: both are the machine's own judgement about a channel, arriving on the
   * same wire, and a manifest that took the first and ignored the second would
   * hold a row stamped DAMAGED under a verdict card saying the channel is back.
   *
   * Same rule as everywhere else here — earned by an event, derived on every
   * render, never latched. A session whose calibration is replayed after a
   * reconnect produces exactly this board again; one that is aborted produces
   * none of it.
   */
  const restoredJoint =
    session?.calibration?.outcome === "cleared" ? session.calibration.joint : null;

  return MANIFEST_ROWS.map((row, i) => {
    const ordinal = i + 1;

    if (row.group === "bus") {
      // The flag is the authoritative damage signal — the console does not
      // second-guess it from its own arithmetic, and the strip's colouring and
      // the log's RMS reading are the evidence beside it, not a rival verdict.
      if (flaggedJoint && row.joint === flaggedJoint) {
        // …and the re-measure is the authoritative *un*-damage signal, on the
        // one row it is about. The joint is checked rather than assumed: the
        // store already refuses a calibration that is not about the standing
        // verdict's joint, and a board that stamped RESTORED from a match it
        // never made would be one edit away from clearing the wrong row.
        return {
          row,
          ordinal,
          state:
            row.joint === restoredJoint ? ("restored" as const) : ("damaged" as const),
        };
      }
      const measured = channels.some((c) => c.joint === row.joint);
      return {
        row,
        ordinal,
        state: measured ? ("operating" as const) : ("pending" as const),
      };
    }

    if (row.prefix) {
      const need = row.count ?? 1;
      const have = walked.filter((p) => p.startsWith(row.prefix!)).length;
      return {
        row,
        ordinal,
        state: have >= need ? ("operating" as const) : ("pending" as const),
        detail: `${Math.min(have, need)}/${need}`,
      };
    }

    const hit = row.path !== undefined && walked.includes(row.path);
    return { row, ordinal, state: hit ? ("operating" as const) : ("pending" as const) };
  });
}

/** The row the board's leader line points at: the scan's subject, whatever became of it. */
export function subjectRowState(state: ManifestState): boolean {
  return state === "damaged" || state === "restored";
}

/** How many rows have cleared — the panel header's count. */
export function manifestCleared(entries: ManifestEntry[]): number {
  return entries.filter((e) => e.state !== "pending").length;
}
