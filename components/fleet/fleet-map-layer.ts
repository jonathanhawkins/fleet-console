import type maplibregl from "maplibre-gl";
import { type UnitSummary } from "@/lib/schema";
import { readToken } from "@/lib/tokens/fallback";
import { isPlainLeftClick, unitHref } from "./fleet-map-marker";
import { registerFrame, unitStatusChip } from "@/components/console";
import { approximatePosition } from "./fleet-map-privacy";

/**
 * The map's scale strategy: one GeoJSON source and one circle layer instead of
 * one DOM node per unit.
 *
 * DOM glyph markers are the designed experience — the house, the hover label,
 * the anchor semantics — and they hold their frame budget comfortably into the
 * hundreds (measured: pan p95 9.9 ms at 300 markers). At 500 they do not:
 * MapLibre repositions every marker element on every render frame, and 500
 * per-frame style writes measured pan at p95 31 ms (docs/perf.md, "Scale +
 * ordering"). So above `MARKER_DOM_MAX` units fleet-map-view.tsx swaps this
 * module in: units become status-colored circles drawn inside the map's own
 * WebGL pass, and a camera move costs the same whether the fleet is 8 or 500.
 *
 * The discipline is unchanged (PRD §7): nothing here renders through React.
 * `sync` is called from the same store subscription that pokes the DOM
 * markers, on real unit changes only, and restates the source imperatively
 * via `setData`. Telemetry batches still touch nothing.
 *
 * What scale trades away, documented rather than hidden:
 *  - the house glyph and the hover identity label (a circle is a mark, not a
 *    nameplate — identity at 500 lives in the rail and on click-through);
 *  - anchor semantics (cmd-click new tab, focusability). Canvas features are
 *    not in the accessibility tree, so the virtualized rail is the accessible
 *    enumeration of the fleet in this mode.
 * The alert ping and click-to-navigate — the two behaviors the golden path
 * needs from the map — work identically in both modes.
 */

export const FLEET_SOURCE_ID = "fleet-units";
export const FLEET_LAYER_ID = "fleet-units-circles";
const PING_SOURCE_ID = "fleet-unit-ping";
const PING_LAYER_ID = "fleet-unit-ping-ring";

/** Mirrors the DOM ping: 700 ms, ring grows ~2x while fading out. */
const PING_MS = 700;
const PING_RADIUS_FROM = 6;
const PING_RADIUS_TO = 22;

export interface UnitLayer {
  /** Restate every unit from a fresh snapshot slice. Cheap; identity-driven. */
  sync(units: UnitSummary[]): void;
  /** Remove layers, sources and listeners. Idempotent. */
  dispose(): void;
}

interface PointFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Record<string, string | number>;
}

const collection = (features: PointFeature[]) =>
  ({ type: "FeatureCollection", features }) as const;

/**
 * The tokens the DOM marker gets from `.fleet-marker` CSS, resolved once to
 * concrete values a WebGL layer can hold. Same source of truth (the
 * stylesheet), one indirection later — MapLibre's color parser does not read
 * custom properties. The palette is static per space and the fleet map lives
 * in operator space, so once is enough.
 */
function resolveTokens(container: HTMLElement) {
  const styles = getComputedStyle(container);
  return {
    nominal: readToken(styles, "--nominal", "operator"),
    warn: readToken(styles, "--warn", "operator"),
    alert: readToken(styles, "--alert", "operator"),
    bg: readToken(styles, "--bg", "operator"),
  };
}

export function createUnitLayer(
  map: maplibregl.Map,
  onNavigate: (href: string) => void,
): UnitLayer {
  const tokens = resolveTokens(map.getContainer());

  map.addSource(FLEET_SOURCE_ID, {
    type: "geojson",
    data: collection([]),
  });
  map.addLayer({
    id: FLEET_LAYER_ID,
    type: "circle",
    source: FLEET_SOURCE_ID,
    layout: {
      // Troubled units draw above the quiet fleet — the z-index rule the DOM
      // markers express in CSS.
      "circle-sort-key": ["match", ["get", "status"], "alert", 2, "warn", 1, 0],
    },
    paint: {
      // The dial, restated at map scale: bg fill, 1.5px status ring. Radius
      // leans slightly on zoom so the fleet reads at the fit and a street
      // reads on approach.
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3.5, 14, 6],
      "circle-color": tokens.bg,
      "circle-stroke-width": 1.5,
      "circle-stroke-color": [
        "match",
        ["get", "status"],
        "warn",
        tokens.warn,
        "alert",
        tokens.alert,
        tokens.nominal,
      ],
    },
  });
  map.addSource(PING_SOURCE_ID, { type: "geojson", data: collection([]) });
  map.addLayer({
    id: PING_LAYER_ID,
    type: "circle",
    source: PING_SOURCE_ID,
    paint: {
      "circle-radius": [
        "+",
        PING_RADIUS_FROM,
        ["*", ["get", "p"], PING_RADIUS_TO - PING_RADIUS_FROM],
      ],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-width": 1,
      "circle-stroke-color": [
        "match",
        ["get", "status"],
        "warn",
        tokens.warn,
        tokens.alert,
      ],
      "circle-stroke-opacity": ["*", 0.9, ["-", 1, ["get", "p"]]],
    },
  });

  // -- interaction ----------------------------------------------------------

  const onClick = (
    e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] },
  ): void => {
    if (!isPlainLeftClick(e.originalEvent)) return;
    const id = e.features?.[0]?.properties?.id;
    if (typeof id === "string") onNavigate(unitHref(id));
  };
  const onEnter = (): void => {
    map.getCanvas().style.cursor = "pointer";
  };
  const onLeave = (): void => {
    map.getCanvas().style.cursor = "";
  };
  map.on("click", FLEET_LAYER_ID, onClick);
  map.on("mouseenter", FLEET_LAYER_ID, onEnter);
  map.on("mouseleave", FLEET_LAYER_ID, onLeave);

  // -- ping (status worsened: ring once, then quiet — same event contract as
  //    the DOM marker's data-ping) -------------------------------------------

  interface Ping {
    lng: number;
    lat: number;
    status: string;
    startedAt: number;
  }
  let pings: Ping[] = [];
  /**
   * The ring animates on the app's one frame loop (frame-loop.ts), subscribed
   * only while a ping is alive: the map is a canvas instrument like the
   * telemetry strips beside it, and gets no scheduler of its own.
   */
  let leaveLoop: (() => void) | null = null;
  let disposed = false;

  const stopPings = (): void => {
    leaveLoop?.();
    leaveLoop = null;
  };

  const drawPings = (now: number): void => {
    pings = pings.filter((p) => now - p.startedAt < PING_MS);
    const source = map.getSource(PING_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(
        collection(
          pings.map((p) => {
            const t = Math.min(1, (now - p.startedAt) / PING_MS);
            const eased = 1 - (1 - t) ** 3; // the tail of --ease-console, near enough
            return {
              type: "Feature",
              geometry: { type: "Point", coordinates: [p.lng, p.lat] },
              properties: { p: eased, status: p.status },
            };
          }),
        ) as never,
      );
    }
    if (pings.length === 0 || !source) stopPings();
  };

  const ring = (unit: UnitSummary, status: string): void => {
    // The DOM ping resolves to nothing under prefers-reduced-motion (the CSS
    // clamp); the layer ping honors the same preference at the same beat.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Ring where the circle is drawn, not where the unit is: the ping and the
    // dot it haloes must share the presented (privacy-quantized) position.
    const pos = approximatePosition(unit.id, unit.pos);
    pings.push({
      lng: pos.lng,
      lat: pos.lat,
      status,
      startedAt: performance.now(),
    });
    leaveLoop ??= registerFrame(drawPings);
  };

  // -- sync -----------------------------------------------------------------

  /** Last seen chip status per unit — the "worsened" edge detector. */
  const lastStatus = new Map<string, string>();

  const sync = (units: UnitSummary[]): void => {
    const features: PointFeature[] = [];
    for (const unit of units) {
      const status = unitStatusChip(unit.status);
      const prev = lastStatus.get(unit.id);
      // Same rule as the DOM marker: a unit first seen already-troubled (a
      // page opened mid-incident) must not ring for old news.
      if (prev !== undefined && prev !== status && status !== "nominal") {
        ring(unit, status);
      }
      lastStatus.set(unit.id, status);
      // The presentation transform (fleet-map-privacy.ts): the true position
      // never reaches the GeoJSON source, in this mode exactly as in the DOM
      // marker mode — the 500-unit generator's positions included.
      const pos = approximatePosition(unit.id, unit.pos);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [pos.lng, pos.lat] },
        properties: { id: unit.id, status },
      });
    }
    const source = map.getSource(FLEET_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    source?.setData(collection(features) as never);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopPings();
    map.off("click", FLEET_LAYER_ID, onClick);
    map.off("mouseenter", FLEET_LAYER_ID, onEnter);
    map.off("mouseleave", FLEET_LAYER_ID, onLeave);
    onLeave();
    for (const layer of [PING_LAYER_ID, FLEET_LAYER_ID]) {
      if (map.getLayer(layer)) map.removeLayer(layer);
    }
    for (const source of [PING_SOURCE_ID, FLEET_SOURCE_ID]) {
      if (map.getSource(source)) map.removeSource(source);
    }
  };

  return { sync, dispose };
}
