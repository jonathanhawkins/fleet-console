"use client";

import * as React from "react";
import { bindTransport } from "@/lib/stores";
import {
  createTransport,
  type ConnectionStatusSource,
  type TelemetryTransport,
} from "@/lib/transport";
import {
  markIncidents,
  markStorylinePosition,
  readPersistedIncidents,
  readStorylineResumeMs,
} from "@/lib/session/storyline-session";
import { useIncidentStore, type IncidentRecord } from "@/lib/stores";
import { startStatusRecorder } from "./status-history";
import { setCommandTransport } from "./telemetry-command";

const isDev = process.env.NODE_ENV !== "production";

/**
 * How often the storyline position is written down. A second is finer than
 * anyone can perceive in a resume and coarse enough that the write is free;
 * losing up to a second of story on a reload is not a thing a reader can see.
 */
const POSITION_INTERVAL_MS = 1000;

/**
 * What `createTransport()` throwing becomes: a transport that never delivers
 * and reports itself closed from the first read. Routing the failure through
 * this stand-in — rather than an early return that skips setCommandTransport/
 * bindTransport/startStatusRecorder — keeps one code path instead of two: the
 * chip and every region's empty state get there the same way a transport that
 * failed after construction would take them, so there is no second, uncovered
 * branch for "no link at all" to drift out of sync with.
 */
function failedTransport(): TelemetryTransport & ConnectionStatusSource {
  return {
    connect() {},
    send() {},
    disconnect() {},
    getStatus: () => "closed",
    onStatus: () => () => {},
  };
}

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
 *
 * `createTransport()` itself is guarded: a worker chunk that 404s is reported
 * by WorkerTransport's own connect() (onerror/onmessageerror/a bounded open
 * timeout), but a throw from createTransport() happens before there is a
 * transport to ask — the one failure mode with no object to carry the status,
 * so it is caught here and turned into one (failedTransport, above).
 */
export function TelemetryProvider() {
  React.useEffect(() => {
    // Strict Mode mounts this twice in development: the returned teardown
    // disconnects the transport and detaches the status subscription, so the
    // second mount opens a clean socket rather than a second one.
    let transport: TelemetryTransport;
    try {
      transport = createTransport();
    } catch (err) {
      if (isDev) console.error("[telemetry] createTransport failed", err);
      transport = failedTransport();
    }
    setCommandTransport(transport);
    const unbind = bindTransport(transport);
    const stopRecorder = startStatusRecorder();

    /**
     * The reload contract, both halves of it.
     *
     * `createTransport()` has already told the sim where to pick up (the same
     * number read here); this keeps that number current as the run advances,
     * and re-hydrates the incidents that belong to it. Restoring the history
     * *after* the transport is bound is deliberate — a fresh snapshot restates
     * the fleet but never touches the incident store, so there is no race
     * between the two.
     */
    const resumedFrom = readStorylineResumeMs();
    const openedAt = Date.now();

    // The stored shape is validated field by field on the way in
    // (storyline-session.ts); `calibration` alone rides through opaquely,
    // which is what this cast is for and all it covers.
    const restored = readPersistedIncidents() as IncidentRecord[];
    if (restored.length > 0) useIncidentStore.setState({ history: restored });

    const tick = window.setInterval(() => {
      markStorylinePosition(resumedFrom + (Date.now() - openedAt));
    }, POSITION_INTERVAL_MS);

    const unwatchHistory = useIncidentStore.subscribe((state, prev) => {
      if (state.history !== prev.history) markIncidents(state.history);
    });

    return () => {
      window.clearInterval(tick);
      unwatchHistory();
      stopRecorder();
      setCommandTransport(null);
      unbind();
    };
  }, []);

  return null;
}
