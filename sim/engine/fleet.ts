import { type Posture, type UnitStatus } from "@/lib/schema";
import { JOINTS, type Joint } from "./constants";
import { mulberry32, round4 } from "./rng";
import { FW_ROLLOUT, FW_STABLE, PENDING_UNIT_ID, ROLLOUT_UNIT_IDS } from "./rollout";
import { type UnitState } from "./state";

/**
 * The core eight. `unitCount` appends generated units after these — the eight
 * are always present and always first, so every scripted storyline survives
 * any fleet size.
 */
export const FLEET_UNITS: ReadonlyArray<{
  id: string;
  name: string;
  pos: { lat: number; lng: number };
}> = [
  // Each home is named for the real street its (quantized) pin sits near.
  { id: "N-01", name: "Prospect Row", pos: { lat: 37.511, lng: -122.272 } },
  { id: "N-02", name: "Cedar Hollow", pos: { lat: 37.4937, lng: -122.2549 } },
  { id: "N-03", name: "Carmelita Drive", pos: { lat: 37.4999, lng: -122.2776 } },
  { id: "N-04", name: "Taylor Bend", pos: { lat: 37.5152, lng: -122.2635 } },
  { id: "N-05", name: "Regent Court", pos: { lat: 37.4861, lng: -122.2864 } },
  { id: "N-06", name: "Hill Crossing", pos: { lat: 37.5202, lng: -122.2789 } },
  { id: "N-07", name: "Elm House", pos: { lat: 37.5018, lng: -122.2591 } },
  { id: "N-08", name: "Hubbard Farm", pos: { lat: 37.4803, lng: -122.2617 } },
];

/** unitCount clamps to [8, 500]: the core eight always exist; 500 is the stress ceiling. */
export const MIN_UNIT_COUNT = FLEET_UNITS.length;
export const MAX_UNIT_COUNT = 500;

/**
 * Generated house names: 24 x 21 = 504 unique combinations — enough for the
 * 492 generated units at MAX_UNIT_COUNT, with the second-word list disjoint
 * from every handcrafted suffix so no generated name collides with the core
 * eight. Pure index math, no PRNG draws: names are stable per index.
 */
const GEN_NAME_FIRST: readonly string[] = [
  "Alder",
  "Aspen",
  "Birch",
  "Bristle",
  "Camas",
  "Cinder",
  "Dogwood",
  "Elm",
  "Fern",
  "Hazel",
  "Juniper",
  "Larch",
  "Lupine",
  "Mesa",
  "Obsidian",
  "Pine",
  "Ponderosa",
  "Quartz",
  "Rimrock",
  "Sierra",
  "Tamarack",
  "Thistle",
  "Timber",
  "Tumalo",
];
const GEN_NAME_SECOND: readonly string[] = [
  "Court",
  "Terrace",
  "Ridge",
  "Meadow",
  "Point",
  "Way",
  "Loop",
  "Green",
  "Rise",
  "Hill",
  "Grove",
  "Park",
  "Path",
  "Walk",
  "Run",
  "View",
  "Gate",
  "Yard",
  "Commons",
  "Corner",
  "Place",
];

/** Name for the i-th generated unit (0-based over the generated tail). */
function generatedName(i: number): string {
  const first = GEN_NAME_FIRST[i % GEN_NAME_FIRST.length]!;
  const second =
    GEN_NAME_SECOND[Math.floor(i / GEN_NAME_FIRST.length) % GEN_NAME_SECOND.length]!;
  return `${first} ${second}`;
}

/**
 * The service region generated homes scatter across — a box a little wider
 * than the handcrafted eight, narrower east–west than it is tall so nothing
 * lands in the water.
 */
export const GEN_REGION = {
  latMin: 37.455,
  latMax: 37.555,
  lngMin: -122.315,
  lngMax: -122.245,
} as const;

/** Ids: core eight keep N-0X; generated units pad to the fleet's widest index. */
function unitIdFor(index: number, unitCount: number): string {
  const width = unitCount > 99 ? 3 : 2;
  return `N-${String(index + 1).padStart(width, "0")}`;
}

/**
 * Draw order is the determinism contract: the core eight consume exactly the
 * PRNG draws they always have (11 per unit, in this order), THEN each
 * generated unit draws 2 position jitters + the same 11 — so the eight-unit
 * stream is byte-identical whatever `unitCount` is. Firmware distribution is
 * pure id lookup, zero draws.
 */
export function initUnits(seed: number, unitCount: number): UnitState[] {
  const rand = mulberry32(seed);

  const drawCharacter = (
    u: { id: string; name: string; pos: { lat: number; lng: number } },
    unitIndex: number,
  ): UnitState => {
    const baseTemp = {} as Record<Joint, number>;
    for (const j of JOINTS) baseTemp[j] = 30 + rand() * 5; // 30–35 C at rest
    const batteryStart = 62 + rand() * 34; // 62–96 %
    return {
      ...u,
      status: "nominal" as UnitStatus,
      batteryStart,
      battery: batteryStart,
      baseTemp,
      gaitFreqHz: 0.8 + rand() * 0.3, // step cadence
      gaitPhase: rand() * Math.PI * 2,
      activityPeriodMs: 40_000 + rand() * 50_000, // walk / rest cycles
      activityPhase: rand() * Math.PI * 2,
      unitIndex,
      posture: "walking" as Posture,
      sitStartMs: null,
      // Generated units (beyond the core eight) all run the baseline: the
      // rollout wave touched only the named fleet.
      fw: ROLLOUT_UNIT_IDS.includes(u.id) ? FW_ROLLOUT : FW_STABLE,
      fwPending: u.id === PENDING_UNIT_ID ? FW_ROLLOUT : null,
    };
  };

  const units = FLEET_UNITS.map((u, i) => drawCharacter(u, i));

  // Generated tail: a seeded grid-jitter scatter over GEN_REGION. Grid cells
  // keep density even at 500; the jitter keeps it from reading as a lattice.
  const extra = unitCount - FLEET_UNITS.length;
  if (extra > 0) {
    const cols = Math.ceil(Math.sqrt(extra));
    const rows = Math.ceil(extra / cols);
    const latStep = (GEN_REGION.latMax - GEN_REGION.latMin) / rows;
    const lngStep = (GEN_REGION.lngMax - GEN_REGION.lngMin) / cols;
    for (let i = 0; i < extra; i += 1) {
      const unitIndex = FLEET_UNITS.length + i;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const jLat = rand() * 2 - 1;
      const jLng = rand() * 2 - 1;
      const pos = {
        lat: round4(GEN_REGION.latMin + (row + 0.5 + 0.45 * jLat) * latStep),
        lng: round4(GEN_REGION.lngMin + (col + 0.5 + 0.45 * jLng) * lngStep),
      };
      units.push(
        drawCharacter(
          { id: unitIdFor(unitIndex, unitCount), name: generatedName(i), pos },
          unitIndex,
        ),
      );
    }
  }

  return units;
}
