import { type FleetMessage } from "@/lib/schema";

/**
 * Out-of-order policy, enforced at the transport boundary —
 * the same choke point that zod-validates. The stores stay pure reducers of
 * ordered, contract-true input; both transports (and any future one) wrap
 * their delivery callback in this gate.
 *
 * Rules, per unit:
 * - `telemetry`: a batch whose ts is <= the newest admitted ts is stale and
 * is dropped whole — a sparkline must never travel backwards in time.
 * - `command_event`: an event whose seq is <= the newest admitted seq is
 * stale (late delivery or duplicate) and is dropped — seq, not arrival
 * order and not ts, is the ordering authority for command lifecycles.
 * - `fleet_command_event`: same seq rule, but the scope is the
 * fleet, so the lane is a single scalar instead of a per-unit map — one
 * fleet, one command lifecycle stream, one gate. The engine draws fleet
 * seqs from the same monotonic counter as per-unit ones, so the lane's
 * seqs strictly ascend even as HALT_ROLLOUT and ROLLBACK_COHORT
 * lifecycles interleave; a per-unit seq never gates a fleet event or vice
 * versa (different lanes, deliberately — a fleet command is not "unit
 * undefined's command").
 * - `fleet_snapshot`: resets every gate (both maps and the fleet lane). The
 * snapshot restates the world (fresh connect, reconnect, RESET_SIM), and
 * the host replays still-active alerts / diag_events / command_events /
 * fleet_command_events right after it — those replays must pass, so the
 * gates start over with the world.
 * - `alert` / `diag_event`: pass through untouched; they are identity-deduped
 * in their reducers (alert id; walked path / channel joint).
 * - `alert_clear`: passes through untouched. `resolveAlert` is idempotent
 * (first resolution wins) and a clear for an alert the feed no longer holds
 * is a no-op, so duplicates and post-snapshot stragglers cost nothing.
 * - `unit_update`: passes through untouched. It restates one unit's summary
 * (the settle-beat posture flip today); the fleet store applies it
 * idempotently — a content-equal restatement is a no-op — so duplicates
 * cost nothing, and both transports deliver in order.
 *
 * `onDrop` is an observability hook for the stress lane — receipts
 * for dropped messages; transports use it for dev warnings.
 */
export function createOrderingGate(
  onMessage: (msg: FleetMessage) => void,
  onDrop?: (msg: FleetMessage) => void,
): (msg: FleetMessage) => void {
  const lastTelemetryTs = new Map<string, number>();
  const lastCommandSeq = new Map<string, number>();
  /** The fleet-scoped command lane: one scope, one scalar (see header). */
  let lastFleetCommandSeq: number | undefined;

  return (msg) => {
    switch (msg.t) {
      case "fleet_snapshot":
        lastTelemetryTs.clear();
        lastCommandSeq.clear();
        lastFleetCommandSeq = undefined;
        break;
      case "telemetry": {
        const last = lastTelemetryTs.get(msg.unitId);
        if (last !== undefined && msg.ts <= last) {
          onDrop?.(msg);
          return;
        }
        lastTelemetryTs.set(msg.unitId, msg.ts);
        break;
      }
      case "command_event": {
        const last = lastCommandSeq.get(msg.unitId);
        if (last !== undefined && msg.seq <= last) {
          onDrop?.(msg);
          return;
        }
        lastCommandSeq.set(msg.unitId, msg.seq);
        break;
      }
      case "fleet_command_event": {
        if (lastFleetCommandSeq !== undefined && msg.seq <= lastFleetCommandSeq) {
          onDrop?.(msg);
          return;
        }
        lastFleetCommandSeq = msg.seq;
        break;
      }
      case "alert":
      case "alert_clear":
      case "diag_event":
      case "unit_update":
        break;
    }
    onMessage(msg);
  };
}
