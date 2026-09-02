import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FleetSnapshotMessage } from "@/lib/schema";
import { useFleetStore } from "@/lib/stores";
import { APPROX_NOTE } from "./fleet-map-privacy";

/**
 * The map's waiting state — the seconds between the component mounting and
 * MapLibre's first tiles — and what it promises: a designed ground rather than
 * a blank, the small print already in its corners, the fleet on the plate
 * before the streets, and a basemap that fades in once (and switches, under
 * reduced motion) without moving anything.
 *
 * maplibre-gl is replaced whole: jsdom has no WebGL, and the contract under
 * test is the frame around the map, not the map. The fake reproduces exactly
 * the DOM MapLibre builds inside the container — canvas container, canvas,
 * control container with the attribution — because that structure is what the
 * frame's selectors address.
 */

const fakes = vi.hoisted(() => {
  type Handler = (ev: unknown) => void;

  class FakeMap {
    static instances: FakeMap[] = [];
    readonly container: HTMLElement;
    readonly canvasContainer: HTMLElement;
    readonly canvas: HTMLCanvasElement;
    readonly handlers = new Map<string, Set<Handler>>();
    readonly touchZoomRotate = { disableRotation: () => {} };
    removed = false;

    constructor(opts: { container: HTMLElement }) {
      this.container = opts.container;
      this.container.classList.add("maplibregl-map");
      this.canvasContainer = document.createElement("div");
      this.canvasContainer.className = "maplibregl-canvas-container";
      this.canvas = document.createElement("canvas");
      this.canvas.className = "maplibregl-canvas";
      this.canvasContainer.appendChild(this.canvas);
      const controls = document.createElement("div");
      controls.className = "maplibregl-control-container";
      const corner = document.createElement("div");
      corner.className = "maplibregl-ctrl-bottom-right";
      const attrib = document.createElement("details");
      attrib.className = "maplibregl-ctrl maplibregl-ctrl-attrib";
      attrib.textContent = "Tiles";
      corner.appendChild(attrib);
      controls.appendChild(corner);
      this.container.append(this.canvasContainer, controls);
      FakeMap.instances.push(this);
    }

    on(type: string, fn: Handler): this {
      this.handlers.set(type, (this.handlers.get(type) ?? new Set()).add(fn));
      return this;
    }
    once(type: string, fn: Handler): this {
      const wrapped: Handler = (ev) => {
        this.off(type, wrapped);
        fn(ev);
      };
      return this.on(type, wrapped);
    }
    off(type: string, fn: Handler): this {
      this.handlers.get(type)?.delete(fn);
      return this;
    }
    fire(type: string): void {
      for (const fn of [...(this.handlers.get(type) ?? [])]) fn({ type });
    }

    getContainer(): HTMLElement {
      return this.container;
    }
    getCanvasContainer(): HTMLElement {
      return this.canvasContainer;
    }
    getCanvas(): HTMLCanvasElement {
      return this.canvas;
    }
    fitBounds(): this {
      return this;
    }
    easeTo(): this {
      return this;
    }
    getZoom(): number {
      return 11;
    }
    getBounds(): { contains: () => boolean } {
      return { contains: () => true };
    }
    remove(): void {
      this.removed = true;
      this.handlers.clear();
    }
  }

  class FakeMarker {
    private readonly el: HTMLElement;
    constructor(opts: { element: HTMLElement }) {
      this.el = opts.element;
    }
    setLngLat(): this {
      return this;
    }
    addTo(map: FakeMap): this {
      map.getCanvasContainer().appendChild(this.el);
      return this;
    }
    remove(): void {
      this.el.remove();
    }
  }

  class FakeBounds {
    extend(): this {
      return this;
    }
  }

  return { FakeMap, FakeMarker, FakeBounds };
});

vi.mock("maplibre-gl", () => ({
  default: {
    Map: fakes.FakeMap,
    Marker: fakes.FakeMarker,
    LngLatBounds: fakes.FakeBounds,
  },
}));

// The view imports MapLibre's stylesheet for the browser; under vitest that
// import would route through the project's PostCSS config, which is Next's
// concern and not this test's.
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { default: FleetMapView } = await import("./fleet-map-view");

const REDUCED = "(prefers-reduced-motion: reduce)";

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === REDUCED ? matches : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
      onchange: null,
    })),
  );
}

function snapshot(): FleetSnapshotMessage {
  return {
    t: "fleet_snapshot",
    units: [
      {
        id: "N-01",
        name: "Cedar Row",
        status: "nominal",
        battery: 80,
        pos: { lat: 37.5, lng: -122.26 },
      },
      {
        id: "N-07",
        name: "Sagebrush House",
        status: "amber",
        battery: 61,
        pos: { lat: 37.51, lng: -122.27 },
      },
    ],
  };
}

const lastMap = (): InstanceType<typeof fakes.FakeMap> => {
  const map = fakes.FakeMap.instances.at(-1);
  if (!map) throw new Error("no map constructed");
  return map;
};

const frame = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[data-slot="fleet-map-frame"]');
  if (!el) throw new Error("no frame");
  return el;
};

beforeEach(() => {
  useFleetStore.getState().reset();
  fakes.FakeMap.instances.length = 0;
  stubMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FleetMapView — the ground before the map", () => {
  it("lays the surface, the note and the attribution down before any tile, and holds the canvas", () => {
    render(<FleetMapView />);

    expect(frame()).toHaveAttribute("data-basemap", "pending");
    // the ground is the card's surface token, not the page's white
    expect(screen.getByText(APPROX_NOTE).previousElementSibling).toHaveClass(
      "bg-surface",
    );
    // the small print is already in its corners
    expect(screen.getByText(APPROX_NOTE)).toHaveClass("fleet-map-note");
    expect(frame().querySelector(".maplibregl-ctrl-attrib")).not.toBeNull();
    // the canvas is the only thing held, and it is held at zero
    expect(frame().className).toContain("[&_.maplibregl-canvas]:opacity-0");
    expect(frame().className).toContain(
      "[&[data-basemap=ready]_.maplibregl-canvas]:opacity-100",
    );
  });

  it("puts the fleet on the tinted ground as soon as the style parses — before the tiles", () => {
    useFleetStore.getState().applySnapshot(snapshot());
    render(<FleetMapView />);

    act(() => {
      lastMap().fire("style.load");
    });

    // still waiting on tiles…
    expect(frame()).toHaveAttribute("data-basemap", "pending");
    // …and the houses are already there, the one raising its hand included
    // (amber on the wire is the `warn` token on the marker)
    const markers = frame().querySelectorAll<HTMLElement>(".fleet-marker");
    expect(markers).toHaveLength(2);
    expect(
      frame().querySelector<HTMLElement>('.fleet-marker[data-unit="N-07"]')?.dataset
        .status,
    ).toBe("warn");
  });

  it("reveals the basemap with a fade on the map's first load", () => {
    render(<FleetMapView />);
    expect(frame().className).toContain("[&_.maplibregl-canvas]:transition-opacity");
    expect(frame().className).toContain(
      "[&_.maplibregl-canvas]:duration-[var(--dur-enter)]",
    );

    act(() => {
      lastMap().fire("load");
    });
    expect(frame()).toHaveAttribute("data-basemap", "ready");

    // a later idle is not a second reveal
    act(() => {
      lastMap().fire("idle");
    });
    expect(frame()).toHaveAttribute("data-basemap", "ready");
  });

  it("settles on idle when load never comes (a tile origin that errors still settles)", () => {
    render(<FleetMapView />);
    act(() => {
      lastMap().fire("idle");
    });
    expect(frame()).toHaveAttribute("data-basemap", "ready");
  });

  it("switches rather than fades under prefers-reduced-motion", () => {
    stubMatchMedia(true);
    render(<FleetMapView />);

    expect(frame().className).toContain("[&_.maplibregl-canvas]:transition-none");
    expect(frame().className).not.toContain("transition-opacity");

    act(() => {
      lastMap().fire("load");
    });
    expect(frame()).toHaveAttribute("data-basemap", "ready");
  });

  it("keeps the container's class list intact across the reveal, so MapLibre's own class survives", () => {
    render(<FleetMapView />);
    const container = document.querySelector<HTMLElement>('[data-slot="fleet-map"]');
    expect(container).toHaveClass("maplibregl-map");
    expect(container).toHaveClass("bg-surface");

    act(() => {
      lastMap().fire("load");
    });
    // React re-rendered the frame; the container's className prop did not
    // change, so the class MapLibre added at construction is still there.
    expect(container).toHaveClass("maplibregl-map");
    expect(container).toHaveClass("fleet-map");
  });

  it("does not set state after unmount if the map settles late", () => {
    const { unmount } = render(<FleetMapView />);
    const map = lastMap();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    unmount();
    expect(map.removed).toBe(true);
    // the fake clears its listeners on remove, as MapLibre does; a stray
    // reveal after that must be a no-op rather than a state update
    map.fire("load");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
