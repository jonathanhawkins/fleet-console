import { type RingBuffer } from "@/lib/stores";

export type StripTone = "ink" | "warn" | "alert";

// 3 s at 10 Hz. Torque leaves its envelope on gait peaks, so a tint from the
// newest sample alone flickers; held, it says "out of band recently".
export const BREACH_SAMPLES = 30;

/** True when any of the last `samples` readings exceeded the healthy ceiling. */
export function breachedRecently(
  series: RingBuffer,
  healthy: number,
  samples = BREACH_SAMPLES,
): boolean {
  const from = Math.max(0, series.length - samples);
  for (let i = series.length - 1; i >= from; i -= 1) {
    if (series.at(i) > healthy) return true;
  }
  return false;
}

// Coloured by how bad the UNIT is, never by how far out the measure is: the
// alert already stated the severity, and a second scale is a second opinion.
export function stripTone(breached: boolean, status: string | undefined): StripTone {
  if (!breached) return "ink";
  return status === "red" ? "alert" : "warn";
}
