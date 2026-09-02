// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GEN_REGION } from "@/sim/engine";
import {
  APPROX_GRID_M,
  APPROX_NOTE,
  approximatePosition,
  MAP_MAX_ZOOM,
  type LatLng,
} from "./fleet-map-privacy";

/**
 * the map's privacy presentation. What matters and is therefore
 * pinned: the transform is deterministic and stable (a marker that wandered
 * between loads would read as telemetry, and a re-rolled jitter could be
 * averaged away), bounded (~one grid cell — the town still reads as the same
 * town), coarse (sub-grid precision does not survive into the presentation),
 * and applied identically to handcrafted and generated units alike. The zoom
 * cap is the other half of the same stance.
 */

/** Meters between two nearby points, small-angle equirectangular — plenty here. */
function metersApart(a: LatLng, b: LatLng): number {
  const mPerDegLat = 111_120;
  const mPerDegLng = mPerDegLat * Math.cos((a.lat * Math.PI) / 180);
  const dLat = (a.lat - b.lat) * mPerDegLat;
  const dLng = (a.lng - b.lng) * mPerDegLng;
  return Math.hypot(dLat, dLng);
}

const SAGEBRUSH: LatLng = { lat: 44.0597, lng: -121.2793 };

describe("approximatePosition", () => {
  it("is deterministic and stable across loads: a pure function of (id, position)", () => {
    const a = approximatePosition("N-07", SAGEBRUSH);
    const b = approximatePosition("N-07", { ...SAGEBRUSH });
    expect(a).toEqual(b);
    // No hidden clock, counter, or Math.random — byte-stable however often
    // and in whatever order it is called.
    approximatePosition("N-01", { lat: 44.0662, lng: -121.3122 });
    expect(approximatePosition("N-07", SAGEBRUSH)).toEqual(a);
  });

  it("moves the point off the true position, but never further than ~one grid cell", () => {
    const presented = approximatePosition("N-07", SAGEBRUSH);
    const displaced = metersApart(presented, SAGEBRUSH);
    expect(displaced).toBeGreaterThan(0);
    // Within its own cell: at most one cell diagonal from the truth.
    expect(displaced).toBeLessThanOrEqual(APPROX_GRID_M * Math.SQRT2);
  });

  it("erases sub-grid precision: everywhere in a cell presents as one point", () => {
    // Two true positions ~100 m apart inside the same 500 m cell — a robot at
    // the front door vs the back garden — must present identically: the
    // presentation carries the cell, not the house.
    const base = approximatePosition("N-07", SAGEBRUSH);
    const nudged = approximatePosition("N-07", {
      lat: SAGEBRUSH.lat + 0.0006, // ~67 m north, same cell
      lng: SAGEBRUSH.lng + 0.0008,
    });
    expect(nudged).toEqual(base);
  });

  it("spreads distinct units by id instead of stacking them on cell centres", () => {
    // Same true position, different ids (two units in one building): the
    // id-seeded jitter keeps them from collapsing into a single dot.
    const a = approximatePosition("N-07", SAGEBRUSH);
    const b = approximatePosition("N-08", SAGEBRUSH);
    expect(a).not.toEqual(b);
  });

  it("transforms generated-fleet positions through the identical path, staying near the region", () => {
    // The 500-unit generator scatters across GEN_REGION; presentation must
    // hold every one of them to the same bound as the handcrafted eight.
    for (let i = 0; i < 50; i += 1) {
      const truth: LatLng = {
        lat:
          GEN_REGION.latMin +
          (((i * 37) % 100) / 100) * (GEN_REGION.latMax - GEN_REGION.latMin),
        lng:
          GEN_REGION.lngMin +
          (((i * 61) % 100) / 100) * (GEN_REGION.lngMax - GEN_REGION.lngMin),
      };
      const id = `N-${String(i + 9).padStart(3, "0")}`;
      const presented = approximatePosition(id, truth);
      expect(approximatePosition(id, truth)).toEqual(presented); // stable
      expect(metersApart(presented, truth)).toBeLessThanOrEqual(
        APPROX_GRID_M * Math.SQRT2,
      );
    }
  });
});

describe("the zoom cap and the note", () => {
  it("caps the camera below street-level detail", () => {
    // Rooftops and building footprints resolve from ~z15 in this basemap;
    // the ceiling stays under that, and above the fit (13.6) and the alert
    // push-in (13.4) so neither ever collides with it.
    expect(MAP_MAX_ZOOM).toBeLessThan(15);
    expect(MAP_MAX_ZOOM).toBeGreaterThanOrEqual(13.6);
  });

  it("says so on the map, in so many words", () => {
    expect(APPROX_NOTE).toBe("Locations approximate");
  });
});
