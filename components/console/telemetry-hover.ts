"use client";

/**
 * One cursor for eighteen instruments.
 *
 * The complaint about the first joint grid was not that the traces were
 * wrong, it was that they could not be *read*: eighteen shapes with no way to
 * ask "what were all of these doing at the same instant". That question is the
 * whole reason this module exists, and it has exactly one answer at a time —
 * so the cursor is a module singleton rather than per-strip state.
 *
 * ## Why the shared coordinate is a sample offset, not a pixel
 *
 * Every strip on a unit page is drawn from the same batch cadence, so sample
 * *k from the newest* means the same wall-clock instant in all eighteen. Pixels
 * do not: the expanded strip is a different height, a narrower column is a
 * different width, and a shared pixel x would silently mean three different
 * timestamps across a responsive grid. Offsets survive every layout the grid
 * can take, and each strip converts back through its own x scale — the same
 * scale it draws the trace with, so the cursor cannot drift off the data.
 *
 * ## Why none of this is React state
 *
 * A pointer moves at 60–120 Hz. Eighteen strips subscribed to a React state
 * holding the cursor would be eighteen subtree re-renders per move, which is
 * the exact failure mode lib/stores/README.md forbids for telemetry text. So
 * the cursor lives here, in a plain module variable, and the strips read it in
 * the frame callback they already run — the move sets a number, the next frame
 * paints it, and React is never told. The tripwire in telemetry-strip.test.tsx
 * asserts the render count does not move across a hundred pointer events.
 */

export interface Cursor {
  unitId: string;
  /**
   * Sample offset from the newest sample: 0 is newest, negative is older.
   * Always an integer, always clamped to the samples that exist.
   */
  offset: number;
  /** A finger is dragging, as opposed to a mouse hovering. */
  scrubbing: boolean;
}

let cursor: Cursor | null = null;
const listeners = new Set<(cursor: Cursor | null) => void>();

/**
 * The read a frame callback makes: `null` when this unit has no cursor, an
 * integer offset when it does. A property read and two comparisons — cheap
 * enough that eighteen strips can each call it every frame.
 */
export function cursorOffsetFor(unitId: string): number | null {
  return cursor !== null && cursor.unitId === unitId ? cursor.offset : null;
}

export function currentCursor(): Cursor | null {
  return cursor;
}

/**
 * Move the cursor. No-ops when nothing changed, so a pointer that jitters
 * inside one sample's worth of pixels does not dirty eighteen canvases.
 */
export function setCursor(unitId: string, offset: number, scrubbing: boolean): void {
  if (
    cursor !== null &&
    cursor.unitId === unitId &&
    cursor.offset === offset &&
    cursor.scrubbing === scrubbing
  ) {
    return;
  }
  // One object per cursor *change*, not per pointer event: the no-op above
  // absorbs the moves that land on the sample already under the cursor, which
  // at 600 samples across a 330 px column is most of them.
  cursor = { unitId, offset, scrubbing };
  emit();
}

export function clearCursor(unitId?: string): void {
  if (cursor === null) return;
  if (unitId !== undefined && cursor.unitId !== unitId) return;
  cursor = null;
  emit();
}

function emit(): void {
  for (const listener of listeners) listener(cursor);
}

/**
 * For the chrome that lives outside the grid — the card's meta line, which
 * shows the cursor's timestamp. Called synchronously on change; keep the
 * callback to writes, never reads, so it cannot force layout mid-gesture.
 */
export function subscribeCursor(listener: (cursor: Cursor | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Pixel inside a strip's box → sample offset from the newest.
 *
 * The exact inverse of `stripScales().x`, which maps the domain
 * −(capacity−1)…0 onto 0…width with the newest sample on the right edge. Kept
 * here rather than inverting the d3 scale at the call site because the grid
 * does this per pointer event and `scale.invert` is a method call on an object
 * the grid has no reason to hold.
 *
 * `available` clamps to the samples that actually exist: a ring forty seconds
 * into a sixty-second window draws nothing in its left third, and a cursor
 * parked out there would read an em-dash while the operator watched a trace
 * two inches to the right. Sticking to the oldest real sample is the
 * conventional chart behaviour and stays honest, because the readout prints
 * the sample's own timestamp rather than the pointer's position.
 */
export function offsetFromLocalX(
  x: number,
  width: number,
  capacity: number,
  available: number,
): number | null {
  if (width <= 0 || available <= 0) return null;
  const span = capacity - 1;
  const raw = Math.round((x / width) * span - span);
  const oldest = -Math.min(span, available - 1);
  if (raw > 0) return 0;
  if (raw < oldest) return oldest;
  return raw;
}

/** Tests and teardown. */
export function resetCursor(): void {
  cursor = null;
  listeners.clear();
}
