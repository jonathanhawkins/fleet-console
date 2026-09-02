/** mulberry32 — tiny seeded PRNG for per-unit character drawn at init. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless noise in [-1, 1): a pure function of its keys, so a sample never depends on call order. */
export function noise(
  seed: number,
  k1: number,
  k2: number,
  k3: number,
  k4: number,
): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (k1 + 0x9e3779b9), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (k2 + 0x9e3779b9), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16) ^ (k3 + 0x9e3779b9), 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15) ^ (k4 + 0x9e3779b9), 0x165667b1);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const round1 = (v: number) => Math.round(v * 10) / 10;
export const round2 = (v: number) => Math.round(v * 100) / 100;
export const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
export const smoothstep01 = (x: number) => x * x * (3 - 2 * x);
