// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  clampColumn,
  COLUMN_MIN_REM,
  EMPTY_LAYOUT,
  isLegalColumn,
  maxColumnPx,
  parseStoredLayout,
  SCAN_STACKED_QUERY,
  serializeLayout,
  VERDICT_SHEET_QUERY,
  type ClampContext,
} from "./machine-layout";

/**
 * The drag controller cannot be re-rendered to inspect it, so the
 * arithmetic it runs on every frame is asserted here instead — in particular
 * the two cases that only show up on someone else's machine: a viewport too
 * narrow to seat all three floors, and a layout restored from a display that
 * is no longer attached.
 */

/** A 1440px board at a 16px root: the desk case. */
const desk: ClampContext = { total: 1440, rem: 16 };
/** Exactly 64rem, where the three floors seat with nothing to spare. */
const laptop: ClampContext = { total: 1024, rem: 16 };

const logMin = COLUMN_MIN_REM.log * 16; // 288
const sweepMin = COLUMN_MIN_REM.sweep * 16; // 320
const boardMin = COLUMN_MIN_REM.board * 16; // 384

describe("column clamps", () => {
  it("leaves a width inside the stops alone", () => {
    expect(clampColumn("log", 400, sweepMin, desk)).toBe(400);
    expect(clampColumn("sweep", 380, logMin, desk)).toBe(380);
  });

  it("holds each column at its own floor", () => {
    expect(clampColumn("log", 40, sweepMin, desk)).toBe(logMin);
    expect(clampColumn("sweep", 0, logMin, desk)).toBe(sweepMin);
  });

  it("stops a column before it eats the board", () => {
    // Everything that is not the sweep column, the two gaps, and a board.
    expect(clampColumn("log", 9_999, 368, desk)).toBe(1440 - 2 - 368 - boardMin);
    expect(maxColumnPx("log", 368, desk)).toBe(1440 - 2 - 368 - boardMin);
  });

  it("seats all three floors exactly at 64rem", () => {
    // 18 + 24 + 20 = 62rem, plus the two 1px gaps. This is why the three-column
    // layout begins at 1024px rather than at a rounder number.
    expect(maxColumnPx("log", sweepMin, laptop)).toBe(1024 - 2 - sweepMin - boardMin);
    expect(maxColumnPx("log", sweepMin, laptop)).toBe(318);
    expect(logMin + sweepMin + boardMin + 2).toBeLessThanOrEqual(1024);
  });

  it("keeps the dragged column readable when the ceiling drops below its floor", () => {
    // 900px cannot seat all three. The board is the `1fr` track, so it absorbs
    // the deficit rather than the column under the pointer collapsing.
    const cramped: ClampContext = { total: 900, rem: 16 };
    expect(maxColumnPx("log", sweepMin, cramped)).toBeLessThan(logMin);
    expect(clampColumn("log", 500, sweepMin, cramped)).toBe(logMin);
    expect(clampColumn("log", 10, sweepMin, cramped)).toBe(logMin);
  });

  it("scales the floors with the root font size rather than pinning pixels", () => {
    const large: ClampContext = { total: 1440, rem: 20 };
    expect(clampColumn("log", 100, 400, large)).toBe(COLUMN_MIN_REM.log * 20);
  });

  it("rounds to whole pixels, so a var write never carries drag jitter", () => {
    expect(clampColumn("log", 400.4, sweepMin, desk)).toBe(400);
    expect(clampColumn("log", 400.6, sweepMin, desk)).toBe(401);
  });
});

describe("isLegalColumn", () => {
  it("accepts what fits and rejects what does not, without rescuing it", () => {
    expect(isLegalColumn("log", 400, sweepMin, desk)).toBe(true);
    expect(isLegalColumn("log", 100, sweepMin, desk)).toBe(false);
    // A width saved on a wide display, reopened on a laptop.
    expect(isLegalColumn("log", 600, sweepMin, desk)).toBe(true);
    expect(isLegalColumn("log", 600, sweepMin, laptop)).toBe(false);
  });
});

/**
 * The 48/64rem breakpoints exist twice: as media blocks in app/styles/machine.css
 * (which owns the layout) and as the query constants here (which decide what
 * to render). Nothing at compile time ties the two together, so this is the
 * same guard shape descent-motion.test.ts gives EASE_WIPE — pin the values,
 * and read the stylesheet as text to prove its side of the pair is the literal
 * complement of ours.
 */
describe("breakpoint twins with app/styles/machine.css", () => {
  const css = readFileSync(
    new URL("../../app/styles/machine.css", import.meta.url),
    "utf8",
  );

  it("stacks the scan below 48rem on both sides of the wall", () => {
    expect(SCAN_STACKED_QUERY).toBe("(max-width: 47.999rem)");
    // The stylesheet's phone shape uses the query verbatim (the wave deck's
    // compressed strips)…
    expect(css).toContain("(max-width: 47.999rem)");
    // …and takes the two-column board at exactly the complement.
    expect(css).toContain("(min-width: 48rem)");
  });

  it("hands the verdict a sheet until the 64rem three-column board exists", () => {
    expect(VERDICT_SHEET_QUERY).toBe("(max-width: 63.999rem)");
    // The centre column a verdict card needs begins at exactly the complement.
    expect(css).toContain("(min-width: 64rem)");
  });
});

describe("stored layout", () => {
  it("round-trips a layout", () => {
    const layout = { log: 400, sweep: 360 };
    expect(parseStoredLayout(serializeLayout(layout))).toEqual(layout);
  });

  it("treats a reset column as absent rather than as zero", () => {
    expect(parseStoredLayout(serializeLayout({ log: 400, sweep: null }))).toEqual({
      log: 400,
      sweep: null,
    });
  });

  it("believes nothing that is not a positive finite number", () => {
    expect(parseStoredLayout(null)).toEqual(EMPTY_LAYOUT);
    expect(parseStoredLayout("not json")).toEqual(EMPTY_LAYOUT);
    expect(parseStoredLayout("[1,2]")).toEqual(EMPTY_LAYOUT);
    expect(parseStoredLayout('"400"')).toEqual(EMPTY_LAYOUT);
    expect(parseStoredLayout('{"log":"400","sweep":true}')).toEqual(EMPTY_LAYOUT);
    expect(parseStoredLayout('{"log":-5,"sweep":0}')).toEqual(EMPTY_LAYOUT);
    expect(parseStoredLayout('{"log":null}')).toEqual(EMPTY_LAYOUT);
  });
});
