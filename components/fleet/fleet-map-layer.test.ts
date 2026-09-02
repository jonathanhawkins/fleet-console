import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UnitSummary } from "@/lib/schema";
import {
  createUnitLayer,
  FLEET_LAYER_ID,
  FLEET_SOURCE_ID,
  type UnitLayer,
} from "./fleet-map-layer";
import { approximatePosition } from "./fleet-map-privacy";
import { frameSubscriberCount } from "@/components/console";

/**
 * The circle-layer strategy — the map above MARKER_DOM_MAX units.
 * Like the DOM marker it replaces at scale, nothing here renders through
 * React, so nothing here has a component test to fall back on. What is worth
 * pinning: the wire vocabulary reaches the layer as the token vocabulary, the
 * two behaviors the golden path needs (click-to-navigate, the worsened ping)
 * survive the mode switch, dispose leaves the map clean, and the ping draws
 * from the app's one frame loop — subscribed while it rings, gone when it
 * fades — rather than from a scheduler of its own.
 */

const unit = (over: Partial<UnitSummary> = {}): UnitSummary => ({
  id: "N-07",
  name: "Sagebrush House",
  status: "nominal",
  battery: 82,
  pos: { lat: 44.0597, lng: -121.2793 },
  ...over,
});

interface FeatureLike {
  geometry: { coordinates: [number, number] };
  properties: Record<string, unknown>;
}

/** The slice of maplibregl.Map the layer strategy touches. */
function fakeMap() {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  const layers = new Map<string, unknown>();
  const handlers = new Map<string, Set<(ev: unknown) => void>>();
  const canvas = document.createElement("canvas");
  const container = document.createElement("div");

  const map = {
    addSource: vi.fn((id: string) => {
      sources.set(id, { setData: vi.fn() });
    }),
    addLayer: vi.fn((spec: { id: string }) => {
      layers.set(spec.id, spec);
    }),
    getSource: vi.fn((id: string) => sources.get(id)),
    getLayer: vi.fn((id: string) => layers.get(id)),
    removeLayer: vi.fn((id: string) => {
      layers.delete(id);
    }),
    removeSource: vi.fn((id: string) => {
      sources.delete(id);
    }),
    on: vi.fn((type: string, layer: string, fn: (ev: unknown) => void) => {
      const key = `${type}:${layer}`;
      handlers.set(key, (handlers.get(key) ?? new Set()).add(fn));
    }),
    off: vi.fn((type: string, layer: string, fn: (ev: unknown) => void) => {
      handlers.get(`${type}:${layer}`)?.delete(fn);
    }),
    getCanvas: () => canvas,
    getContainer: () => container,
  };

  const fire = (type: string, layer: string, ev: unknown): void => {
    for (const fn of handlers.get(`${type}:${layer}`) ?? []) fn(ev);
  };
  const data = (id: string): FeatureLike[] | undefined => {
    const source = sources.get(id);
    const last = source?.setData.mock.lastCall?.[0] as
      { features: FeatureLike[] } | undefined;
    return last?.features;
  };

  return { map, sources, layers, handlers, fire, data };
}

// A manual rAF pump: the ping animation must be stepped, not raced. The frame
// loop reads `requestAnimationFrame` off the global at schedule time, so the
// stub below is the one it drives from.
let rafQueue: FrameRequestCallback[] = [];
const pump = (): void => {
  const queue = rafQueue;
  rafQueue = [];
  for (const cb of queue) cb(performance.now());
};

let reducedMotion = false;

/** Every layer a test made, so the loop can be checked empty after each one. */
let created: UnitLayer[] = [];
const layerOn = (
  map: ReturnType<typeof fakeMap>["map"],
  navigate = vi.fn(),
): UnitLayer => {
  const layer = createUnitLayer(map as never, navigate);
  created.push(layer);
  return layer;
};

beforeEach(() => {
  rafQueue = [];
  reducedMotion = false;
  created = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reducedMotion })),
  );
});

afterEach(() => {
  for (const layer of created) layer.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Nothing a layer started may outlive it on the shared loop.
  expect(frameSubscriberCount()).toBe(0);
});

describe("createUnitLayer", () => {
  it("adds the unit + ping sources and layers once", () => {
    const { map, sources, layers } = fakeMap();
    layerOn(map);
    expect(sources.size).toBe(2);
    expect(layers.size).toBe(2);
    expect(sources.has(FLEET_SOURCE_ID)).toBe(true);
    expect(layers.has(FLEET_LAYER_ID)).toBe(true);
  });

  it("restates units as features in the token vocabulary, positions through the privacy transform", () => {
    const { map, data } = fakeMap();
    const layer = layerOn(map);
    layer.sync([unit(), unit({ id: "N-03", status: "red" })]);
    const features = data(FLEET_SOURCE_ID);
    expect(features).toHaveLength(2);
    expect(features?.[0]?.properties).toEqual({ id: "N-07", status: "nominal" });
    expect(features?.[1]?.properties).toEqual({ id: "N-03", status: "alert" });
    // the GeoJSON source receives the PRESENTED (grid-quantized)
    // position — the wire's true coordinates never reach MapLibre.
    const approx = approximatePosition("N-07", unit().pos);
    expect(features?.[0]?.geometry.coordinates).toEqual([approx.lng, approx.lat]);
    expect(features?.[0]?.geometry.coordinates).not.toEqual([-121.2793, 44.0597]);
  });

  it("navigates on a plain left click on a feature, and only then", () => {
    const { map, fire } = fakeMap();
    const navigate = vi.fn();
    layerOn(map, navigate);
    const click = (originalEvent: Partial<MouseEvent>) =>
      fire("click", FLEET_LAYER_ID, {
        originalEvent,
        features: [{ properties: { id: "N-42" } }],
      });
    click({ button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    expect(navigate).not.toHaveBeenCalled();
    click({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false });
    expect(navigate).toHaveBeenCalledWith("/unit/N-42");
  });

  it("rings once when a unit worsens — never for a unit first seen troubled", () => {
    const { map, data, sources } = fakeMap();
    const layer = layerOn(map);
    const pingSource = [...sources.keys()].find((k) => k !== FLEET_SOURCE_ID)!;

    // First sight already amber (page opened mid-incident): no ring.
    layer.sync([unit({ status: "amber" })]);
    expect(rafQueue).toHaveLength(0);

    // amber -> red is a worsening: one ping feature animates out.
    layer.sync([unit({ status: "red" })]);
    expect(rafQueue).toHaveLength(1);
    pump();
    const pings = data(pingSource);
    expect(pings).toHaveLength(1);
    expect(pings?.[0]?.properties.status).toBe("alert");
    // The ring haloes the dot as drawn: presented position, not the true one.
    const approx = approximatePosition("N-07", unit().pos);
    expect(pings?.[0]?.geometry.coordinates).toEqual([approx.lng, approx.lat]);

    // Same status restated: no new ring — and the one in flight is still on
    // the loop, which asked for its next frame itself.
    expect(frameSubscriberCount()).toBe(1);
    rafQueue = [];
    layer.sync([unit({ status: "red" })]);
    expect(rafQueue).toHaveLength(0);
  });

  it("leaves the shared loop when the last ring has faded, with the source emptied", () => {
    const { map, data, sources } = fakeMap();
    const layer = layerOn(map);
    const pingSource = [...sources.keys()].find((k) => k !== FLEET_SOURCE_ID)!;
    layer.sync([unit({ status: "nominal" })]);
    layer.sync([unit({ status: "red" })]);
    expect(frameSubscriberCount()).toBe(1);

    const started = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(started + 350);
    pump();
    expect(data(pingSource)).toHaveLength(1);
    expect(data(pingSource)?.[0]?.properties.p).toBeGreaterThan(0);
    expect(frameSubscriberCount()).toBe(1);

    // Past 700 ms the ring is gone: one last restatement with nothing in it,
    // and the loop is handed back.
    vi.spyOn(performance, "now").mockReturnValue(started + 800);
    pump();
    expect(data(pingSource)).toHaveLength(0);
    expect(frameSubscriberCount()).toBe(0);
  });

  it("stops a ring in flight when disposed", () => {
    const { map } = fakeMap();
    const layer = layerOn(map);
    layer.sync([unit({ status: "nominal" })]);
    layer.sync([unit({ status: "red" })]);
    expect(frameSubscriberCount()).toBe(1);
    layer.dispose();
    expect(frameSubscriberCount()).toBe(0);
  });

  it("respects prefers-reduced-motion: the ring resolves to nothing", () => {
    reducedMotion = true;
    const { map } = fakeMap();
    const layer = layerOn(map);
    layer.sync([unit({ status: "nominal" })]);
    layer.sync([unit({ status: "red" })]);
    expect(rafQueue).toHaveLength(0);
  });

  it("dispose removes everything it added and detaches its handlers", () => {
    const { map, sources, layers, handlers } = fakeMap();
    const layer = layerOn(map);
    layer.dispose();
    expect(sources.size).toBe(0);
    expect(layers.size).toBe(0);
    for (const set of handlers.values()) expect(set.size).toBe(0);
    // Idempotent — a Strict Mode double-cleanup cannot throw.
    layer.dispose();
  });
});
