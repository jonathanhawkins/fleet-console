"use client";

import * as React from "react";
import { bindTransport } from "@/lib/stores";
import { createTransport } from "@/lib/transport";
import { startStatusRecorder } from "./status-history";
import { setCommandTransport } from "./telemetry-command";

/**
 * The one place the app opens a telemetry link.
 *
 * Mounted in the root layout rather than on the fleet page, and that placement
 * is the point: a root layout survives navigation, so walking from the fleet
 * map to `/unit/N-07` and back keeps a single socket, a single snapshot and an
 * unbroken alert feed. Mounting it per page would drop and re-open the
 * connection on every click — which the stores would handle correctly (a fresh
 * snapshot restates the world) and which the operator would read as a fault.
 *
 * Renders nothing. Everything downstream reads the stores.
 *
 * Three things are wired here, all for the same reason — they must outlive a
 * route change: the inbound binding (messages into the stores), the outbound
 * one (`setCommandTransport`, so "Run diagnostic" on /unit/[id] has a socket
 * to send on), and the status recorder that the unit page's timeline reads
 * back. The recorder starts here rather than on the unit page so that a
 * status change the operator watched happen on the fleet map is still in the
 * timeline when they drill in.
 */
export function TelemetryProvider() {
  React.useEffect(() => {
    // Strict Mode mounts this twice in development: the returned teardown
    // disconnects the transport and detaches the status subscription, so the
    // second mount opens a clean socket rather than a second one.
    const transport = createTransport();
    setCommandTransport(transport);
    const unbind = bindTransport(transport);
    const stopRecorder = startStatusRecorder();
    return () => {
      stopRecorder();
      setCommandTransport(null);
      unbind();
    };
  }, []);

  return null;
}
