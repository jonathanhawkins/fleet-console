"use client";

import dynamic from "next/dynamic";
import { APPROX_NOTE } from "./fleet-map-privacy";
import { RegionNote } from "./region-note";

/**
 * The map's loading boundary.
 *
 * maplibre-gl is the single largest dependency in this product and it is
 * useless on the server — it wants a WebGL context and a real element. Loading
 * it through `next/dynamic` with `ssr: false` keeps it out of the fleet page's
 * initial JS (PRD §7 budgets: under 200 KB gzipped) and out of the server
 * render, and gives the region an honest thing to say while the chunk arrives.
 */
const FleetMapView = dynamic(() => import("./fleet-map-view"), {
  ssr: false,
  // The same frame the view renders into, minus the map: the card's surface
  // as ground and the privacy note already in its corner, so that when the
  // chunk lands nothing on the plate moves — the view takes over the frame
  // and adds the fleet (fleet-map-view.tsx, "the ground before the map").
  loading: () => (
    <div data-slot="fleet-map-frame" className="relative flex min-h-0 flex-1 flex-col">
      <RegionNote>Loading the fleet map.</RegionNote>
      <p data-slot="map-approx-note" className="fleet-map-note">
        {APPROX_NOTE}
      </p>
    </div>
  ),
});

export function FleetMap() {
  return <FleetMapView />;
}
