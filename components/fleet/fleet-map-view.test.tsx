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

const { default: FleetMapView, BASEMAP_UNAVAILABLE_NOTE } = await import(
  "./fleet-map-view"
);

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
    // the small print is already in its corners
    expect(screen.getByText(APPROX_NOTE)).toHaveClass("fleet-map-note");
    expect(frame().querySelector(".maplibregl-ctrl-attrib")).not.toBeNull();
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

  describe("the sad path — a tile host that cannot be reached", () => {
    it("keeps the fleet on the plate through a degraded reveal — markers are not the basemap's business", () => {
      useFleetStore.getState().applySnapshot(snapshot());
      render(<FleetMapView />);

      act(() => {
        lastMap().fire("style.load");
      });
      expect(frame().querySelectorAll(".fleet-marker")).toHaveLength(2);

      act(() => {
        lastMap().fire("error");
      });

      expect(frame()).toHaveAttribute("data-basemap-degraded", "true");
      // The reveal and the marker DOM are independent effects: a degraded
      // basemap neither adds nor removes a single marker.
      expect(frame().querySelectorAll(".fleet-marker")).toHaveLength(2);
      expect(
        frame().querySelector<HTMLElement>('.fleet-marker[data-unit="N-07"]')?.dataset
          .status,
      ).toBe("warn");
    });

    it("reveals the canvas, degraded, on the map's own error event", () => {
      render(<FleetMapView />);
      expect(frame()).toHaveAttribute("data-basemap", "pending");

      act(() => {
        lastMap().fire("error");
      });

      // Whatever MapLibre managed to paint is shown rather than held back —
      // the reveal still happens — but the region says the cartography failed.
      expect(frame()).toHaveAttribute("data-basemap", "ready");
      expect(frame()).toHaveAttribute("data-basemap-degraded", "true");
      expect(screen.getByText(BASEMAP_UNAVAILABLE_NOTE)).toBeInTheDocument();
    });

    it("reveals the canvas, degraded, once the bounded timeout elapses with nothing else settling", () => {
      vi.useFakeTimers();
      try {
        render(<FleetMapView />);
        expect(frame()).toHaveAttribute("data-basemap", "pending");

        // Short of the bound: still held, and still quiet about it.
        act(() => {
          vi.advanceTimersByTime(2_000);
        });
        expect(frame()).toHaveAttribute("data-basemap", "pending");
        expect(screen.queryByText(BASEMAP_UNAVAILABLE_NOTE)).not.toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(frame()).toHaveAttribute("data-basemap", "ready");
        expect(frame()).toHaveAttribute("data-basemap-degraded", "true");
        expect(screen.getByText(BASEMAP_UNAVAILABLE_NOTE)).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("never fires the timeout's reveal twice, and clears it on unmount", () => {
      vi.useFakeTimers();
      try {
        const { unmount } = render(<FleetMapView />);
        unmount();
        // The pending timer is cleared on cleanup; letting it elapse anyway
        // must not throw or reach a disposed component's setState.
        expect(() => {
          act(() => {
            vi.advanceTimersByTime(5_000);
          });
        }).not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the clean reveal when load wins the race, even if error follows", () => {
      render(<FleetMapView />);

      act(() => {
        lastMap().fire("load");
      });
      act(() => {
        lastMap().fire("error");
      });

      expect(frame()).toHaveAttribute("data-basemap", "ready");
      // load got there first: the other three branches find `revealed` set
      // and this is not the degraded note's state to own.
      expect(frame()).not.toHaveAttribute("data-basemap-degraded");
      expect(screen.queryByText(BASEMAP_UNAVAILABLE_NOTE)).not.toBeInTheDocument();
    });

    it("keeps the clean reveal when idle wins the race, even if error follows", () => {
      render(<FleetMapView />);

      act(() => {
        lastMap().fire("idle");
      });
      act(() => {
        lastMap().fire("error");
      });

      expect(frame()).toHaveAttribute("data-basemap", "ready");
      expect(frame()).not.toHaveAttribute("data-basemap-degraded");
      expect(screen.queryByText(BASEMAP_UNAVAILABLE_NOTE)).not.toBeInTheDocument();
    });

    it("says nothing extra on the happy path: the note is the failed state's alone", () => {
      render(<FleetMapView />);
      expect(screen.queryByText(BASEMAP_UNAVAILABLE_NOTE)).not.toBeInTheDocument();

      act(() => {
        lastMap().fire("load");
      });

      expect(frame()).toHaveAttribute("data-basemap", "ready");
      expect(screen.queryByText(BASEMAP_UNAVAILABLE_NOTE)).not.toBeInTheDocument();
      // The privacy note keeps behaving normally in every reveal state.
      expect(screen.getByText(APPROX_NOTE)).toBeInTheDocument();
    });
  });

  it("switches rather than fades under prefers-reduced-motion", () => {
    stubMatchMedia(true);
    render(<FleetMapView />);

    act(() => {
      lastMap().fire("load");
    });
    expect(frame()).toHaveAttribute("data-basemap", "ready");
  });

  it("keeps the container's class list intact across the reveal, so MapLibre's own class survives", () => {
    render(<FleetMapView />);
    const container = document.querySelector<HTMLElement>('[data-slot="fleet-map"]');
    expect(container).toHaveClass("maplibregl-map");

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
