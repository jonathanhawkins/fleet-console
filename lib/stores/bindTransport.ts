import { type FleetMessage } from "@/lib/schema";
import { hasConnectionStatus, type TelemetryTransport } from "@/lib/transport/types";
import { auditCohortDetections } from "./cohortStore";
import { useCommandStore } from "./commandStore";
import { useFleetStore } from "./fleetStore";
import { useIncidentStore } from "./incidentStore";

/**
 * Wire a transport into the stores. The app shell calls this exactly once
 * (client-side, on mount); everything downstream subscribes to the stores.
 *
 * Messages are already zod-validated by the transport, so routing is a plain
 * switch on the discriminant. Returns an unbind function that disconnects
 * the transport and detaches the status subscription — call it on unmount.
 */
export function bindTransport(transport: TelemetryTransport): () => void {
  let unbindStatus: (() => void) | undefined;

  if (hasConnectionStatus(transport)) {
    useFleetStore.getState().setConnection(transport.getStatus());
    unbindStatus = transport.onStatus((status) => {
      useFleetStore.getState().setConnection(status);
    });
  }

  transport.connect((msg: FleetMessage) => {
    switch (msg.t) {
      case "fleet_snapshot":
        useFleetStore.getState().applySnapshot(msg);
        // The snapshot restates the world for the command slice too: live
        // commands clear, and the host's replay of any still-in-flight sit's
        // command_events (sent right after) rebuilds the real ones.
        useCommandStore.getState().applySnapshot();
        break;
      case "telemetry":
        useFleetStore.getState().applyTelemetry(msg);
        break;
      case "unit_update":
        useFleetStore.getState().applyUnitUpdate(msg);
        // A firmware restatement can complete a cohort (a unit joining the
        // suspect build while already alerting), so this path checks too.
        auditCohortDetections();
        break;
      case "alert":
        useFleetStore.getState().applyAlert(msg);
        // Cohort detection is a derivation over fleet-store state
        // (cohortStore.ts); the raise path is where a group can cross the
        // threshold, so the once-per-instance audit hook runs here — on the
        // message path, never from render.
        auditCohortDetections();
        break;
      case "alert_clear":
        // The one resolution that arrives on the wire: the unit
        // cleared its own blockage. Recorded through the same idempotent
        // lifecycle action the UI's resolutions use — the alert stays in the
        // feed, meta marks it resolved, the audit logs it once. The nominal
        // `unit_update` the sim sends right after restores the unit's status
        // through its own case below.
        useFleetStore.getState().resolveAlert(msg.alertId, { via: msg.via });
        break;
      case "diag_event":
        useIncidentStore.getState().applyDiagEvent(msg);
        break;
      case "command_event":
        useCommandStore.getState().applyCommandEvent(msg);
        break;
      case "fleet_command_event":
        useCommandStore.getState().applyFleetCommandEvent(msg);
        break;
    }
  });

  return () => {
    unbindStatus?.();
    transport.disconnect();
  };
}
