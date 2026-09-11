"use client";

/**
 * Machine space's typeface, pulled into cache before its first glyph paints.
 *
 * The mono face ships `preload: false` (app/layout.tsx) because machine space
 * is opt-in and most visitors never open it — so the browser is left to fetch
 * it the first time mono text renders. That moment is the descent's own
 * boot-in, which makes the one sequence someone came to watch also the one
 * that renders in fallback and snaps a beat later. Warming the face from the
 * same two controls that already warm the machine chunk closes the gap
 * without putting the fetch back on the critical path of every visit.
 *
 * The family is read off the cascade rather than spelled out here: next/font
 * mints the family string, so a copy of it in this file would quietly become
 * a no-op the day the face changes.
 */

const MACHINE_FONT_VAR = "--font-jetbrains-mono";

/**
 * Both declared weights resolve to the same files, so the second call is a
 * cache hit — but a face the browser has bytes for is not yet a face it
 * considers loaded, and the boot-in sets label rows in the heavier one.
 */
const MACHINE_FONT_WEIGHTS = [400, 500] as const;

/**
 * Idempotent in the only sense that matters: a face already in cache resolves
 * immediately, so callers may fire this on hover, on mount, or on both.
 */
export function warmMachineFont(): void {
  if (typeof document === "undefined" || !("fonts" in document)) return;

  const family = getComputedStyle(document.documentElement)
    .getPropertyValue(MACHINE_FONT_VAR)
    .trim();
  if (!family) return;

  for (const weight of MACHINE_FONT_WEIGHTS) {
    // A face that fails to load is a face that arrives late; nothing on
    // screen is waiting on this promise.
    void document.fonts.load(`${weight} 1em ${family}`).catch(() => {});
  }
}
