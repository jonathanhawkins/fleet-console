/**
 * The geometry behind the draggable column dividers — all of it, and none of
 * the DOM.
 *
 * The controller in scan-columns.tsx runs inside a pointermove handler and is
 * forbidden from re-rendering, which makes it exactly the kind of code that
 * quietly grows an off-by-a-gap bug nobody can see until a column collapses on
 * a demo machine. So every number it decides is decided here, in functions that
 * take widths and return widths, and asserted in machine-layout.test.ts.
 */

export type ScanEdge = "log" | "sweep";

/** Both draggable edges, in DOM order. */
export const SCAN_EDGES: readonly ScanEdge[] = ["log", "sweep"];

/** The custom property each edge drives on `.scan-grid`. */
export const EDGE_VAR: Record<ScanEdge, string> = {
  log: "--scan-log",
  sweep: "--scan-sweep",
};

/** The grid area whose width each edge controls. */
export const EDGE_AREA: Record<ScanEdge, "log" | "waves"> = {
  log: "log",
  sweep: "waves",
};

/**
 * Column floors, in rem, authored to the content rather than to a round number.
 *
 * `log` 18: the walk's longest node is `/sys/actuator_bus/knee_L/actuator_A07`
 * at 37 characters, which needs ~270 px of trace plus the ordinal gutter — the
 * point below which the one path the whole incident turns on starts to ellipsise.
 * `board` 24: the parts manifest is a two-column table with a status stamp and
 * it stops being a table before this. `sweep` 20: six strips need enough
 * horizontal run for a divergence to read as a divergence rather than as noise.
 *
 * They are rem, not px, so an operator running a larger root size gets larger
 * floors rather than the same pixels and smaller text.
 */
export const COLUMN_MIN_REM = { log: 18, board: 24, sweep: 20 } as const;

/** The two 1px gaps `.scan-grid` paints its dividers in. */
export const GRID_GAPS_PX = 2;

/**
 * Where the board stops being a board and becomes a phone.
 *
 * The twin of the `max-width: 47.999rem` block in app/globals.css, and it must
 * stay equal to it: below this the scan is one scrolling column framed by a
 * fixed session header and status line, and the two panels that only make
 * sense side by side (the turntable beside its manifest) give up the ghost.
 * The stylesheet owns the layout; this exists only for the handful of
 * decisions that are about *what to render*, not how to lay it out.
 */
export const SCAN_STACKED_QUERY = "(max-width: 47.999rem)";

/**
 * Where the verdict stops being a card in a column and becomes a sheet.
 *
 * Deliberately a different threshold from {@link SCAN_STACKED_QUERY}, because
 * it answers a different question. The stacked query asks "is this a phone" —
 * whether to draw the turntable, whether the walk is a tail. This one asks
 * whether there is a *centre column* for a conclusion to land in, and the answer
 * is no until 64rem: between 48 and 64 the grid is two columns deep
 * (`"log board" / "log waves"`, app/globals.css), the board shares its side with
 * the channel sweep, and a verdict appended under the manifest is taller than
 * the cell it is in. At 768–1023px the card ran past the
 * bottom of its column and RETURN's autofocus scrolled the headline out of view,
 * so an operator landed on evidence with the conclusion above the fold.
 *
 * The sheet is not a fallback for that; it is the correct shape for the same
 * reason it is correct on a phone. Where the board cannot hold the conclusion
 * beside its evidence, the conclusion takes the body of the instrument and the
 * evidence waits underneath it, one control away.
 */
export const VERDICT_SHEET_QUERY = "(max-width: 63.999rem)";

export interface ScanLayout {
  /** Column width in px, or null for "whatever the stylesheet says". */
  log: number | null;
  sweep: number | null;
}

export const EMPTY_LAYOUT: ScanLayout = { log: null, sweep: null };

export const MACHINE_LAYOUT_KEY = "machine-layout-v1";

export interface ClampContext {
  /** Total inner width of the grid, px. */
  total: number;
  /** Current root font size in px — the rem floors follow it. */
  rem: number;
}

/**
 * The widest this edge's column may be: everything that is not the other fixed
 * column, the two gaps, and a board still worth calling a board.
 */
export function maxColumnPx(edge: ScanEdge, other: number, ctx: ClampContext): number {
  return ctx.total - GRID_GAPS_PX - other - COLUMN_MIN_REM.board * ctx.rem;
}

export const minColumnPx = (edge: ScanEdge, ctx: ClampContext): number =>
  COLUMN_MIN_REM[edge] * ctx.rem;

/**
 * A width, brought inside the stops.
 *
 * `Math.max(min, max)` is not belt-and-braces. On a viewport too narrow to seat
 * all three floors at once the ceiling drops below the floor, and the honest
 * answer there is to hold this column at its floor and let the board — the one
 * track that is `minmax(0, 1fr)` — absorb the deficit, rather than to shrink a
 * readable column to satisfy arithmetic about a column nobody is dragging.
 */
export function clampColumn(
  edge: ScanEdge,
  px: number,
  other: number,
  ctx: ClampContext,
): number {
  const min = minColumnPx(edge, ctx);
  const max = Math.max(min, maxColumnPx(edge, other, ctx));
  return Math.round(Math.min(Math.max(px, min), max));
}

/** Whether a width is already inside the stops — no rounding, no rescue. */
export function isLegalColumn(
  edge: ScanEdge,
  px: number,
  other: number,
  ctx: ClampContext,
): boolean {
  return px >= minColumnPx(edge, ctx) && px <= maxColumnPx(edge, other, ctx);
}

const finiteWidth = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/**
 * What came back out of localStorage, believed only as far as its shape.
 *
 * Anything that is not a positive finite number is dropped rather than coerced.
 * Whether a well-formed number is *allowed* is a separate question, answered by
 * `isLegalColumn` against the viewport that is actually on screen: a layout
 * saved on a 27-inch display is well-formed and still wrong on a laptop.
 */
export function parseStoredLayout(raw: string | null): ScanLayout {
  if (!raw) return EMPTY_LAYOUT;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY_LAYOUT;
    const record = value as Record<string, unknown>;
    return { log: finiteWidth(record.log), sweep: finiteWidth(record.sweep) };
  } catch {
    // A corrupt entry is a default layout, not an error the operator has to
    // read: there is nothing they could do about it and nothing was lost.
    return EMPTY_LAYOUT;
  }
}

export const serializeLayout = (layout: ScanLayout): string => JSON.stringify(layout);
