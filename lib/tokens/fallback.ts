/**
 * Token fallbacks for the surfaces that cannot read CSS.
 *
 * Canvas 2D, MapLibre's paint expressions and three.js materials take concrete
 * colour strings, not `var(--ink)`. Every such surface samples the token layer
 * off its own element with `getComputedStyle` — so it picks up whichever space
 * it renders inside, with no prop, like any DOM component in this library —
 * and reaches for the values here only when the variable is absent: jsdom,
 * or a canvas mounted outside any `[data-space]` root.
 *
 * These are the values app/globals.css declares, and fallback.test.ts parses
 * that file to prove it, so a retuned token cannot leave a stale hex behind
 * in five instruments. Nothing here is a second palette: a fallback that
 * disagrees with the stylesheet is a bug the test reports. Where the
 * stylesheet mixes (`color-mix()`), the fallback is the mix resolved in sRGB.
 */

export const TOKEN_FALLBACK = {
  operator: {
    "--bg": "#fafaf9",
    "--ink": "#171715",
    "--ink-soft": "#57564f",
    "--muted": "#8b8a84",
    "--line": "#e4e2dc",
    "--nominal": "#5e7d5a",
    "--warn": "#b8862f",
    "--alert": "#b5473a",
    // Layer-1 primitives, for the one surface (the component scene) whose
    // materials want a literal hue rather than a semantic slot.
    "--charcoal": "#171715",
    "--stone": "#57564f",
    "--warm-white": "#fafaf9",
    "--greige-deep": "#eae8e2",
    "--amber": "#b8862f",
    "--clay": "#b5473a",
  },
  machine: {
    "--bg": "#060606",
    "--ink": "#3bff6f",
    "--ink-soft": "#2aaf4d",
    "--muted": "#22873d",
    "--line": "#1c1c1c",
    "--nominal": "#3bff6f",
    "--warn": "#ffb000",
    "--alert": "#ff3b30",
  },
} as const;

export type Space = keyof typeof TOKEN_FALLBACK;

/** The token names a given space has a fallback for. */
export type TokenName<S extends Space = Space> = keyof (typeof TOKEN_FALLBACK)[S] &
  string;

/**
 * The computed value of a custom property, or its fallback.
 *
 * `style` is the element's computed style, sampled once by the caller: forcing
 * style resolution has no business in a frame callback, and a palette is
 * static per space.
 */
export function readToken<S extends Space>(
  style: CSSStyleDeclaration,
  name: TokenName<S>,
  space: S,
): string {
  const value = style.getPropertyValue(name).trim();
  if (value !== "") return value;
  // `name` is typed against this space's table, which is what guarantees the
  // entry; TS cannot index a per-space literal through the generic itself.
  const table: Readonly<Record<string, string>> = TOKEN_FALLBACK[space];
  return table[name]!;
}
