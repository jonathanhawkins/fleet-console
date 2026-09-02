"use client";

import maplibregl from "maplibre-gl";
import { useRouter } from "next/navigation";
import * as React from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { type UnitSummary } from "@/lib/schema";
import { useFleetStore, type FleetState } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { selectCohortMembers } from "./cohort-membership";
import { createUnitLayer, type UnitLayer } from "./fleet-map-layer";
import { createUnitMarker, type UnitMarker } from "./fleet-map-marker";
import { approximatePosition, APPROX_NOTE, MAP_MAX_ZOOM } from "./fleet-map-privacy";
import { createMapReturn, troubledOffMap } from "./map-return";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/**
 * The fleet map — and the one component in this app that React does not render
 * continuously.
 *
 * The whole component tree below is a frame around a single `<div>`, and it
 * renders twice: once on mount, and once more when the basemap lands (the
 * `data-basemap` flip below). No store hook is called here on purpose: a 10 Hz
 * telemetry batch commits to the fleet store ten times a second, and if this
 * subtree subscribed to any of it, every batch would reconcile a map. Instead
 * the effect opens a raw `useFleetStore.subscribe` outside React, compares
 * object identity, and pokes eight DOM nodes when — and only when — a unit
 * summary actually changed (PRD §7: "map markers updated imperatively, not
 * re-rendered through React").
 *
 * Everything visual lives in public/map/fleet-light.json and in the
 * `.fleet-marker` rules in app/globals.css. This file is wiring.
 *
 * The ground before the map. For the seconds between the map mounting and its
 * first tiles arriving, MapLibre's canvas is transparent and the container
 * shows through — which used to be a bare cream rectangle that the basemap then
 * popped into. Now the frame lays the surface token down as ground, the privacy
 * note and the tile attribution sit in their final corners from the first
 * frame, the fleet's markers land on that ground as soon as the style parses,
 * and only the canvas fades in, on the map's first `load` (or `idle`, whichever
 * comes first). Under prefers-reduced-motion it switches instead of fading.
 * Nothing changes size at any point: the container is flex-sized by the card.
 */

/** Hand-authored near-monochrome style; see the metadata block inside it. */
const STYLE_URL = "/map/fleet-light.json";

/** San Carlos, California — where the eight simulated homes are. Replaced by fitBounds. */
const FALLBACK_CENTER: [number, number] = [-122.266, 37.503];
const FALLBACK_ZOOM = 11.4;

/** Room for a marker and its hover label at the edge of the frame. */
const FIT_PADDING = { top: 56, right: 56, bottom: 64, left: 56 };
/**
 * …but never more than this share of the box it is padding. On a 390px phone
 * the fixed figures above are 112px of a 390px width — nearly a third of the
 * map spent on margin — and eight houses squeezed into the remainder start
 * overlapping each other. The fraction keeps the *proportion* the desktop map
 * was designed with instead of the pixel count.
 */
const FIT_PADDING_MAX_FRACTION = 0.14;

/** Close enough to read the street pattern; never close enough to lose the fleet. */
const FIT_MAX_ZOOM = 13.6;

/** The push-in when a unit raises an alert: a nudge, not a swoop. */
const ALERT_ZOOM_STEP = 0.6;
const ALERT_MAX_ZOOM = 13.4;
const ALERT_EASE_MS = 1400;
/**
 * Below this the map does not push in on an incident at all.
 *
 * On a desk the push-in is a nudge: the frame leans toward the house that just
 * raised its hand and the other seven stay where they were. On a 390px map the
 * same 0.6 zoom steps most of the fleet off the edge — and the fleet page has
 * exactly one job, which is to answer "is everything okay" in one glance. A
 * phone cannot afford to trade seven answers for one emphasis, and it does not
 * need to: the marker has already gone amber and rung once, which is the whole
 * signal. The camera stays on the fleet.
 */
const ALERT_EASE_MIN_WIDTH = 640;

/**
 * The trip home when the operator clicks the return control. Slower than a
 * micro-transition because it is travel, not feedback; faster than the alert
 * push-in because the operator asked for it and is waiting. MapLibre skips
 * the travel entirely under prefers-reduced-motion (the animation is not
 * `essential`), so reduced motion gets the destination without the journey.
 */
const RETURN_EASE_MS = 800;

/**
 * Marker strategy cutover. At or below this many units the map
 * renders the designed DOM glyph markers (house, hover label, anchor
 * semantics); above it, fleet-map-layer.tsx's GeoJSON circle layer. The line
 * is drawn by measurement, not taste: MapLibre repositions every DOM marker
 * element on every render frame, so a camera move at 300 markers still holds
 * p95 9.9 ms/frame, while 500 measured p95 31 ms — and the circle layer at
 * 500 measures the same as 8 (receipts in docs/perf.md, "Scale + ordering").
 */
const MARKER_DOM_MAX = 300;

interface MarkerEntry {
  marker: maplibregl.Marker;
  unit: UnitMarker;
}

/**
 * What the basemap is doing: `pending` until the first fully-rendered frame,
 * `ready` from then on. Stamped on the frame as `data-basemap`, which is what
 * the canvas fade keys on — and the one piece of React state in this file.
 */
type BasemapState = "pending" | "ready";

export default function FleetMapView() {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [basemap, setBasemap] = React.useState<BasemapState>("pending");
  const reducedMotion = usePrefersReducedMotion();
  const router = useRouter();
  // The effect must not re-run when Next hands back a new router object, and it
  // must not close over a stale one either.
  const routerRef = React.useRef(router);
  routerRef.current = router;

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: FALLBACK_CENTER,
      zoom: FALLBACK_ZOOM,
      minZoom: 3,
      // The privacy ceiling: positions are presented on a coarse
      // grid, and the camera stops above the zoom where rooftops resolve —
      // a quantized pin at street zoom is just a wrong pin.
      maxZoom: MAP_MAX_ZOOM,
      // A site plan, not a flythrough: no tilt, no rotation, no compass.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      // Kept, but restyled to a muted line in app/globals.css. The tile credit
      // is a licence condition of OpenFreeMap/OpenMapTiles/OSM, not a widget.
      attributionControl: { compact: false },
    });
    map.touchZoomRotate.disableRotation();

    const markers = new Map<string, MarkerEntry>();
    let unitLayer: UnitLayer | null = null;
    let styleReady = false;
    let fitted = false;
    let easedToIncident = false;

    const navigate = (href: string): void => {
      routerRef.current.push(new URL(href, window.location.origin).pathname);
    };

    /**
     * Every coordinate this map draws or aims at — markers, fit bounds, the
     * alert push-in — goes through the privacy transform. The true positions
     * never reach MapLibre (fleet-map-privacy.ts; the circle layer applies
     * the same transform on its side).
     */
    const presented = (u: UnitSummary): [number, number] => {
      const p = approximatePosition(u.id, u.pos);
      return [p.lng, p.lat];
    };

    /** The designed inset, or the largest one this box can spare. */
    const fitPadding = () => {
      const el = map.getContainer();
      const capX = Math.round(el.clientWidth * FIT_PADDING_MAX_FRACTION);
      const capY = Math.round(el.clientHeight * FIT_PADDING_MAX_FRACTION);
      return {
        top: Math.min(FIT_PADDING.top, capY),
        right: Math.min(FIT_PADDING.right, capX),
        bottom: Math.min(FIT_PADDING.bottom, capY),
        left: Math.min(FIT_PADDING.left, capX),
      };
    };

    const fitToFleet = (units: UnitSummary[], durationMs = 0): void => {
      if (units.length === 0) return;
      const bounds = new maplibregl.LngLatBounds();
      for (const u of units) bounds.extend(presented(u));
      map.fitBounds(bounds, {
        padding: fitPadding(),
        maxZoom: FIT_MAX_ZOOM,
        // Instant by default: the fleet is simply *there* when the page
        // settles. An opening swoop would be the map talking about itself.
        // The return control passes RETURN_EASE_MS — travel the operator
        // asked for is allowed to look like travel.
        duration: durationMs,
      });
    };

    const fleetUnits = (state: FleetState): UnitSummary[] =>
      state.unitIds
        .map((id) => state.units[id])
        .filter((u): u is UnitSummary => u !== undefined);

    /**
     * The way home (map-return.ts). `away` flips on the first *user* camera
     * gesture — programmatic moves (the opening fit, the alert push-in, the
     * return trip itself) never carry an `originalEvent`, so the map's own
     * choreography can never make the control appear and the operator's hand
     * always can.
     */
    let away = false;

    const mapReturn = createMapReturn(() => {
      away = false;
      fitToFleet(fleetUnits(useFleetStore.getState()), RETURN_EASE_MS);
      restateReturn();
    });
    container.appendChild(mapReturn.el);

    /** Recompute the control from the camera and the fleet. Runs on camera
     * settle and on fleet commits — never per frame, never per batch. */
    const restateReturn = (): void => {
      const bounds = map.getBounds();
      const offMap = troubledOffMap(
        fleetUnits(useFleetStore.getState()),
        (lng, lat) => bounds.contains([lng, lat]),
        presented,
      );
      mapReturn.update({ away, offMap });
    };

    map.on("movestart", (ev) => {
      if (ev.originalEvent) away = true;
    });
    map.on("moveend", restateReturn);

    const easeToIncident = (unit: UnitSummary): void => {
      if (map.getContainer().clientWidth < ALERT_EASE_MIN_WIDTH) return;
      // `essential` is left false on purpose: MapLibre skips a non-essential
      // camera animation outright under prefers-reduced-motion, which is the
      // behaviour we want — the map still ends up on the alerting unit, it
      // just gets there without the travel.
      map.easeTo({
        center: presented(unit),
        zoom: Math.min(map.getZoom() + ALERT_ZOOM_STEP, ALERT_MAX_ZOOM),
        duration: ALERT_EASE_MS,
      });
    };

    /** Reconcile marker DOM (or the circle layer) against a fleet snapshot.
     * Called on real changes only. */
    const sync = (state: FleetState): void => {
      const { units, unitIds } = state;
      /**
       * Which houses are in the fleet incident. Derived, memoized and
       * identity-stable (cohort-membership.ts), so this costs a map lookup per
       * marker on the commits that reach here and nothing at all in between.
       * The circle layer above 300 units does not carry the mark: at that scale
       * a hairline ring around four dots in five hundred is not a signal, and
       * the card's member chips are.
       */
      const cohortOf = selectCohortMembers(state);

      // Strategy by fleet size, decided per snapshot (see MARKER_DOM_MAX). A
      // mode flip mid-run tears the other mode down first — in practice the
      // fleet size is fixed per run, so this is one branch, not churn.
      if (unitIds.length > MARKER_DOM_MAX) {
        if (markers.size > 0) {
          for (const entry of markers.values()) entry.marker.remove();
          markers.clear();
        }
        unitLayer ??= createUnitLayer(map, navigate);
        unitLayer.sync(unitIds.map((id) => units[id]).filter((u) => u !== undefined));
      } else {
        if (unitLayer) {
          unitLayer.dispose();
          unitLayer = null;
        }
        for (const id of unitIds) {
          const unit = units[id];
          if (!unit) continue;
          const entry = markers.get(id);
          if (entry) {
            entry.unit.update(unit, cohortOf.get(id));
            entry.marker.setLngLat(presented(unit));
            continue;
          }
          const unitMarker = createUnitMarker(unit, navigate, cohortOf.get(id));
          const marker = new maplibregl.Marker({ element: unitMarker.el })
            .setLngLat(presented(unit))
            .addTo(map);
          markers.set(id, { marker, unit: unitMarker });
        }

        for (const [id, entry] of markers) {
          if (units[id]) continue;
          entry.marker.remove();
          markers.delete(id);
        }
      }

      const flagged = unitIds
        .map((id) => units[id])
        .find((u) => u !== undefined && u.status !== "nominal");

      if (!fitted && unitIds.length > 0) {
        fitted = true;
        fitToFleet(unitIds.map((id) => units[id]).filter((u) => u !== undefined));
        // A client that joins mid-incident gets the fit and nothing more: the
        // ease is a response to an alert *arriving*, not to one existing.
        if (flagged) easedToIncident = true;
        return;
      }

      if (!easedToIncident && flagged) {
        easedToIncident = true;
        easeToIncident(flagged);
      }

      // A unit can go red while the camera sits still — the chip must not
      // wait for a moveend that may never come.
      restateReturn();
    };

    /**
     * `style.load`, not `load`.
     *
     * MapLibre's `load` waits for the last resource of the initial view —
     * which means the tiles. The markers need none of them: a marker is a DOM
     * element pinned to a coordinate, and the coordinate system exists the
     * moment the style is parsed. Gating on `load` meant that a slow or
     * rate-limited tile origin — the normal condition on a phone with two bars,
     * and the whole reason someone is looking at this on a phone — produced not
     * a fleet on a blank plate but an empty rectangle: no houses, no alert, no
     * answer to "is everything okay". The basemap is context; the eight units
     * are the content, and the content no longer waits for the context.
     */
    map.on("style.load", () => {
      styleReady = true;
      sync(useFleetStore.getState());
    });

    /**
     * The reveal. `load` is MapLibre's "first visually complete render" — the
     * initial view's tiles are in — and the moment the basemap has something
     * to fade in *to*. `idle` is the belt to that brace: it fires once the
     * map has nothing left to fetch or animate, which covers a tile origin
     * that answered some requests with errors (those still count as settled)
     * and would otherwise leave the canvas held at zero for good. Whichever
     * fires first wins; the other finds the flag set.
     */
    let disposed = false;
    let revealed = false;
    const reveal = (): void => {
      if (disposed || revealed) return;
      revealed = true;
      setBasemap("ready");
    };
    map.once("load", reveal);
    map.once("idle", reveal);

    // Outside React by design. Fires on every store commit — including ten
    // telemetry batches a second — so the first thing it does is prove nothing
    // it cares about moved. Two reference comparisons is the whole cost.
    const unsubscribe = useFleetStore.subscribe((state, prev) => {
      if (!styleReady) return;
      // Four reference comparisons now, not two: cohort membership is derived
      // from `alerts` and `alertMeta` as well, so a group forming or a member's
      // alert closing has to be able to reach the markers. Those two slices move
      // on alert raise/resolve only — never on a telemetry batch (its
      // in-place discipline), so the guard is still doing its original job.
      if (
        state.units === prev.units &&
        state.unitIds === prev.unitIds &&
        state.alerts === prev.alerts &&
        state.alertMeta === prev.alertMeta
      ) {
        return;
      }
      sync(state);
    });

    return () => {
      disposed = true;
      unsubscribe();
      mapReturn.el.remove();
      for (const entry of markers.values()) entry.marker.remove();
      markers.clear();
      unitLayer?.dispose();
      unitLayer = null;
      // Idempotent, and the reason a Strict Mode double-mount cannot leave two
      // maps (or two WebGL contexts) behind.
      map.remove();
    };
  }, []);

  return (
    // The frame owns the reveal so the map container's class list can stay
    // constant: MapLibre stamps its own `maplibregl-map` class onto the
    // container at construction, and a className prop that changed between
    // renders would have React write over it. The canvas rules are written as
    // descendant variants here rather than in the `.fleet-map` block because
    // the fade is the frame's state, not the map's; the selectors are the
    // rules those variants compile to.
    <div
      data-slot="fleet-map-frame"
      data-basemap={basemap}
      className={cn(
        "relative flex min-h-0 flex-1 flex-col",
        // Only the canvas is held — the markers, in the same canvas container,
        // are not: the fleet is the content and the basemap is its context,
        // and a phone on two bars must still get the eight houses and the
        // amber one before it gets the streets (see the `style.load` note).
        "[&_.maplibregl-canvas]:opacity-0 [&[data-basemap=ready]_.maplibregl-canvas]:opacity-100",
        reducedMotion
          ? "[&_.maplibregl-canvas]:transition-none"
          : "[&_.maplibregl-canvas]:transition-opacity [&_.maplibregl-canvas]:duration-[var(--dur-enter)] [&_.maplibregl-canvas]:ease-console",
      )}
    >
      <div
        ref={containerRef}
        data-slot="fleet-map"
        // `bg-surface` over the `.fleet-map` block's `--bg`: the ground under
        // a held canvas is the card's surface, not the page's white, so the
        // waiting map reads as a plate the fleet stands on rather than a hole
        // in the card. Constant — see the frame note above.
        className="fleet-map min-h-0 flex-1 bg-surface"
      />
      {/* The privacy stance, stated where the presentation applies:
          positions are grid-quantized and the zoom is capped, and a map that
          quietly blurred the truth without saying so would read as a map with
          bad data. Styled as the attribution's mirror — same plate, same type
          size, opposite corner — because it is the same kind of small print. */}
      <p data-slot="map-approx-note" className="fleet-map-note">
        {APPROX_NOTE}
      </p>
    </div>
  );
}
