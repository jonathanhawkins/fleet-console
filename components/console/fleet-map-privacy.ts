/**
 * Map privacy presentation.
 *
 * These markers are private homes. A fleet console's job is "is everything
 * okay", and that question is answerable at neighbourhood precision — a map
 * that renders rooftop-accurate dots is performing precision it does not need
 * over addresses it has no business advertising. So the console's DEFAULT
 * presentation is approximate, as product stance rather than as a rendering
 * accident (README, "Privacy stance"): precise location is modeled as a
 * permission-gated, time-limited, audited operation, and this demo simply
 * never takes that permission.
 *
 * Mechanism: every position the map draws — DOM marker, circle-layer feature,
 * ping, camera target, fit bounds — passes through `approximatePosition`,
 * which quantizes the true position to a ~500 m grid cell and places the
 * presented point INSIDE that cell by a deterministic per-unit jitter (an
 * fnv-1a hash of the unit id, the sessionTag idiom). Two properties matter:
 *
 * - Stable across loads: the presented point is a pure function of
 * (unit id, true cell). No Math.random — a marker that wandered between
 * refreshes would read as telemetry, and a re-roll per load would let an
 * observer average the jitter away.
 * - Bounded: the point stays within its own cell, so it is never more than
 * one cell diagonal (~700 m) from the truth and the town still reads as
 * the same town. The jitter (rather than cell-centre snapping) keeps
 * co-located units from stacking into one dot.
 *
 * The zoom cap is the other half: quantized positions at street zoom would
 * just read as a map with wrong pins, so the camera stops above the level
 * where individual rooftops resolve. Both marker modes (DOM ≤ 300 units,
 * WebGL circle layer above) share this module — the 500-unit generator's
 * positions flow through the identical transform.
 */

/** Presentation grid pitch, meters. Coarse enough that a cell is a block, not a house. */
export const APPROX_GRID_M = 500;

/**
 * The camera ceiling. Street furniture and building footprints resolve from
 * ~z15 in this basemap; 14 keeps the street *pattern* (the thing that says
 * "one town") while individual rooftops stay unresolved. The fit (13.6) and
 * the alert push-in (13.4) already sit under it.
 */
export const MAP_MAX_ZOOM = 14;

/** Meters per degree of latitude — constant enough everywhere the fleet lives. */
const M_PER_DEG_LAT = 111_120;

/** fnv-1a → [0, 1): deterministic, id-keyed, dependency-free. */
function hash01(key: string): number {
  let h = 0x811c9dc5;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return (h >>> 0) / 4_294_967_296;
}

const round5 = (v: number) => Math.round(v * 100_000) / 100_000;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * The one presentation transform. Pure: same unit, same true position → the
 * same presented position, on every load, in both marker modes.
 */
export function approximatePosition(id: string, pos: LatLng): LatLng {
  const latStep = APPROX_GRID_M / M_PER_DEG_LAT;
  const cellLat = Math.floor(pos.lat / latStep);
  // Longitude degrees shrink with latitude. The cosine is taken at the lat
  // CELL's centre, not at the raw latitude, so every position inside one cell
  // sees the identical longitude pitch — otherwise two truths metres apart
  // could present differently, which is sub-grid precision leaking back out.
  // Clamped so an absurd input near a pole degrades to "very coarse" instead
  // of dividing by zero.
  const lngStep =
    APPROX_GRID_M /
    (M_PER_DEG_LAT *
      Math.max(0.01, Math.cos(((cellLat + 0.5) * latStep * Math.PI) / 180)));
  const cellLng = Math.floor(pos.lng / lngStep);
  // Jitter inside the cell with a margin, so the point neither hugs a cell
  // edge (which would leak which side of the boundary the truth is on) nor
  // stacks on a shared centre.
  const jLat = 0.15 + 0.7 * hash01(`${id}:lat`);
  const jLng = 0.15 + 0.7 * hash01(`${id}:lng`);

  return {
    lat: round5((cellLat + jLat) * latStep),
    lng: round5((cellLng + jLng) * lngStep),
  };
}

/** The corner note's copy — asserted in tests, printed by the map region. */
export const APPROX_NOTE = "Locations approximate";
