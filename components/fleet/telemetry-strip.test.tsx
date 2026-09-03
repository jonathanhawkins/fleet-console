import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TelemetryMessage } from "@/lib/schema";
import { RingBuffer, useFleetStore } from "@/lib/stores";
import { TOKEN_FALLBACK } from "@/lib/tokens/fallback";
import { envelope, setDescentOccluded, stripScales } from "@/components/console";
import { resetCursor, setCursor } from "./telemetry-hover";
// Type-only, so it is erased before the hoisted vi.mock below takes effect.
import { type TelemetryStripProps } from "./telemetry-strip";

/**
 * The strip's two contracts.
 *
 * The visible one: sixty seconds of a ring buffer, right-anchored, inside a
 * fixed envelope, with a guide at the joint's healthy ceiling and the trace
 * tinted only when the measure has actually left it.
 *
 * The invisible one, and the reason this file exists: **a telemetry batch must
 * not render React.** Eighteen of these are mounted at once and the channel
 * notifies the unit's subscribers ten times a second; if a strip ever picks up
 * a reactive subscription — a `useUnitTelemetryVersion(...)` added for
 * convenience, a piece of state lifted for a tooltip — the page quietly
 * starts re-rendering 180 times a second and nothing fails except the frame
 * budget. The counter below is the tripwire, same technique as
 * fleet-rail.test.tsx.
 */

const CANVAS_W = 300;
const CANVAS_H = 56;

/**
 * The palette the strip is asked to draw with. jsdom has no cascade, so
 * `getComputedStyle` is stubbed below to answer the token names with these —
 * the *machine* tokens, which the strip's own operator fallbacks never
 * contain. Every colour assertion in this file is therefore proof that the
 * token path was taken, not the fallback; the fallback gets one test of its
 * own at the end.
 */
const TOKENS: Readonly<Record<string, string>> = {
  ...TOKEN_FALLBACK.machine,
  "--fs-label": "0.625rem",
};
const INK = TOKENS["--ink"]!;
const WARN = TOKENS["--warn"]!;
const ALERT = TOKENS["--alert"]!;
const GUIDE = TOKENS["--line"]!;

/**
 * The real computed style — jest-dom's `toBeVisible` needs it — with the token
 * layer laid over `getPropertyValue`. An empty table is the cascade saying
 * nothing, which is what jsdom does unstubbed.
 */
const realComputedStyle = window.getComputedStyle.bind(window);
function stubCascade(tokens: Readonly<Record<string, string>>): void {
  vi.stubGlobal("getComputedStyle", (el: Element, pseudo?: string | null) => {
    const style = realComputedStyle(el, pseudo);
    const read = style.getPropertyValue.bind(style);
    Object.defineProperty(style, "getPropertyValue", {
      configurable: true,
      value: (name: string) => tokens[name] ?? read(name),
    });
    return style;
  });
}

interface StripModule {
  TelemetryStrip: (props: TelemetryStripProps) => React.ReactElement;
  breachedRecently: (s: RingBuffer, healthy: number, samples?: number) => boolean;
  stripTone: (breached: boolean, status: string | undefined) => string;
  TELEMETRY_STRIP_HEIGHT: number;
  TELEMETRY_STRIP_EXPANDED_HEIGHT: number;
}

const renders = { count: 0 };

vi.mock("./telemetry-strip", async () => {
  const actual = await vi.importActual<StripModule>("./telemetry-strip");
  return {
    ...actual,
    TelemetryStrip: (props: TelemetryStripProps) => {
      renders.count += 1;
      return actual.TelemetryStrip(props);
    },
  };
});

const {
  TelemetryStrip,
  breachedRecently,
  stripTone,
  TELEMETRY_STRIP_HEIGHT,
  TELEMETRY_STRIP_EXPANDED_HEIGHT,
} = await import("./telemetry-strip");

// ---------------------------------------------------------------------------
// scaffolding: a recording 2d context, an eager ResizeObserver, a hand-cranked
// animation frame

export interface FakeRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  alpha: number;
}

export interface FakeCtx {
  calls: {
    clearRect: number;
    beginPath: number;
    moveTo: number;
    lineTo: number;
    arc: number;
  };
  strokes: string[];
  widths: number[];
  points: Array<[number, number]>;
  rects: FakeRect[];
  texts: Array<{ text: string; x: number; y: number }>;
  /** Every `setLineDash` argument, by reference — the zero-alloc claim needs it. */
  dashes: number[][];
  setLineDash: (segments: number[]) => void;
  setTransform: ReturnType<typeof vi.fn>;
  reset: () => void;
  clearRect: () => void;
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  arc: (x: number, y: number, r: number) => void;
  fill: () => void;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  fillText: (text: string, x: number, y: number) => void;
  measureText: (text: string) => { width: number };
  stroke: () => void;
  strokeStyle: string;
  fillStyle: string;
  globalAlpha: number;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  font: string;
  textAlign: string;
  textBaseline: string;
}

let ctx: FakeCtx;
let frames: FrameRequestCallback[] = [];

export function makeCtx(): FakeCtx {
  const calls = { clearRect: 0, beginPath: 0, moveTo: 0, lineTo: 0, arc: 0 };
  const strokes: string[] = [];
  const widths: number[] = [];
  const points: Array<[number, number]> = [];
  const rects: FakeRect[] = [];
  const texts: Array<{ text: string; x: number; y: number }> = [];
  const dashes: number[][] = [];
  let fillStyle = "";
  let globalAlpha = 1;
  // One literal, no spreads: object spread copies accessors *by value*, which
  // would silently turn `strokeStyle` back into a plain field and record
  // nothing.
  return {
    calls,
    strokes,
    widths,
    points,
    rects,
    texts,
    dashes,
    // Kept by reference, not copied: "a frame allocates no dash array" is only
    // checkable if the recorder can be asked whether it saw the same object.
    setLineDash: (segments: number[]) => {
      dashes.push(segments);
    },
    setTransform: vi.fn(),
    reset() {
      calls.clearRect = 0;
      calls.beginPath = 0;
      calls.moveTo = 0;
      calls.lineTo = 0;
      calls.arc = 0;
      strokes.length = 0;
      widths.length = 0;
      points.length = 0;
      rects.length = 0;
      texts.length = 0;
      dashes.length = 0;
    },
    clearRect: () => (calls.clearRect += 1),
    beginPath: () => (calls.beginPath += 1),
    moveTo: (x: number, y: number) => {
      calls.moveTo += 1;
      points.push([x, y]);
    },
    lineTo: (x: number, y: number) => {
      calls.lineTo += 1;
      points.push([x, y]);
    },
    arc: (x: number, y: number) => {
      calls.arc += 1;
      points.push([x, y]);
    },
    fill: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h, fill: fillStyle, alpha: globalAlpha });
    },
    fillText: (text: string, x: number, y: number) => {
      texts.push({ text, x, y });
    },
    measureText: (text: string) => ({ width: text.length * 6 }),
    stroke: () => {},
    set strokeStyle(v: string) {
      strokes.push(v);
    },
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: string) {
      fillStyle = v;
    },
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(v: number) {
      globalAlpha = v;
    },
    set lineWidth(v: number) {
      widths.push(v);
    },
    set lineJoin(_v: string) {},
    set lineCap(_v: string) {},
    set font(_v: string) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
  };
}

function frame(now = 0): void {
  const due = frames;
  frames = [];
  for (const cb of due) cb(now);
}

/**
 * Render, then forget everything the mount painted.
 *
 * The strip repaints *synchronously* from its ResizeObserver (see the comment
 * on `resize` in telemetry-strip.tsx: observers run after layout and before
 * paint, so an invalidate-only resize hands the compositor a canvas the
 * browser has just cleared). That first paint is real behaviour and is
 * asserted once, below; every other test here is about what happens after
 * mount, so they start from a clean recorder.
 */
function mount(ui: React.ReactElement) {
  const view = render(ui);
  ctx.reset();
  return view;
}

function telemetry(
  unitId: string,
  point: { tempC: number; torqueNm: number; currentA: number },
  ts = Date.now(),
): TelemetryMessage {
  return {
    t: "telemetry",
    unitId,
    ts,
    batch: [{ joint: "knee_L", battery: 80, ...point }],
  };
}

function push(n: number, tempC = 34): void {
  act(() => {
    for (let i = 0; i < n; i += 1) {
      useFleetStore
        .getState()
        .applyTelemetry(telemetry("N-07", { tempC, torqueNm: 12, currentA: 1.6 }));
    }
  });
}

/** A unit in trouble, so the strip has a severity to borrow. */
function amber(): void {
  act(() => {
    useFleetStore.getState().applySnapshot({
      t: "fleet_snapshot",
      units: [
        {
          id: "N-07",
          name: "Sagebrush House",
          status: "amber",
          battery: 80,
          pos: { lat: 44, lng: -121 },
        },
      ],
    });
  });
}

beforeEach(() => {
  useFleetStore.getState().reset();
  resetCursor();
  renders.count = 0;
  frames = [];
  ctx = makeCtx();

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  stubCascade(TOKENS);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        // Real observers fire once on observe; the strip sizes itself from that
        // callback and never touches layout, which is what makes it testable
        // in a DOM with no layout engine at all.
        this.cb(
          [{ contentRect: { width: CANVAS_W, height: CANVAS_H } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  setDescentOccluded(false);
  resetCursor();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("strip scales", () => {
  const env = envelope("knee_L", "tempC"); // 26 floor / 44 healthy / 60 top

  it("puts the newest sample on the right edge and the window's start on the left", () => {
    const { x } = stripScales(600, CANVAS_W, CANVAS_H, env);
    expect(x(0)).toBeCloseTo(CANVAS_W); // newest
    expect(x(-599)).toBeCloseTo(0); // sixty seconds ago
    expect(x(-299.5)).toBeCloseTo(CANVAS_W / 2);
  });

  it("maps the envelope to the box, floor down, with a pixel of headroom", () => {
    const { y } = stripScales(600, CANVAS_W, CANVAS_H, env);
    expect(y(env.floor)).toBeCloseTo(CANVAS_H - 1);
    expect(y(env.top)).toBeCloseTo(1);
    expect(y(env.healthy)).toBeCloseTo(26.41, 1);
    // higher value, higher on screen
    expect(y(50)).toBeLessThan(y(30));
  });

  it("scales a pair of joints identically and the classes differently", () => {
    expect(envelope("knee_L", "torqueNm")).toEqual(envelope("knee_R", "torqueNm"));
    expect(envelope("hip_L", "torqueNm").healthy).toBeGreaterThan(
      envelope("ankle_L", "torqueNm").healthy,
    );
  });
});

describe("breach detection", () => {
  const ring = (values: number[]) => {
    const r = new RingBuffer(600);
    for (const v of values) r.push(v);
    return r;
  };

  it("is true while an excursion is inside the hold window and false once it ages out", () => {
    const spike = ring([30, 30, 99, ...Array<number>(10).fill(30)]);
    expect(breachedRecently(spike, 44, 30)).toBe(true);
    expect(breachedRecently(spike, 44, 5)).toBe(false); // older than the window
  });

  it("says nothing about an empty ring", () => {
    expect(breachedRecently(ring([]), 44)).toBe(false);
  });

  it("colours a breach with the unit's severity, never its own", () => {
    expect(stripTone(false, "red")).toBe("ink");
    expect(stripTone(true, "amber")).toBe("warn");
    expect(stripTone(true, "red")).toBe("alert");
    expect(stripTone(true, undefined)).toBe("warn");
  });
});

describe("TelemetryStrip", () => {
  it("renders its label and an em-dash before any sample has arrived", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    expect(screen.getByText("Temp")).toBeVisible();
    expect(screen.getByText("No reading yet")).toBeInTheDocument();
  });

  /**
   * The resize path paints, and it has to.
   *
   * A ResizeObserver runs after layout and before paint; rAF ran before both.
   * A resize that only invalidated `drawnVersion` would therefore hand the
   * compositor the canvas the browser had just cleared, and the instrument
   * would flash empty for a frame — once, invisibly, on a window resize, and
   * for the whole 180 ms of the expansion's height transition, which is where
   * this stopped being theoretical.
   */
  it("paints from the resize observer rather than waiting for the next frame", () => {
    render(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    expect(ctx.calls.clearRect).toBe(1);
    expect(ctx.strokes).toEqual([GUIDE]); // the envelope is drawn with no data
  });

  /**
   * The envelope is a fact about the hardware, not about the last sixty
   * seconds, so it is on screen before the first sample and it is drawn under
   * everything else. Hierarchy is the point of the order: ground, then the
   * regions that left it, then the trace.
   */
  it("fills the healthy corridor from the guide line down, at a whisper", () => {
    render(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    const { y } = stripScales(600, CANVAS_W, CANVAS_H, envelope("knee_L", "tempC"));
    const band = ctx.rects[0]!;
    expect(band.fill).toBe(GUIDE);
    expect(band.alpha).toBeLessThan(0.5);
    expect(band.x).toBe(0);
    expect(band.w).toBe(CANVAS_W);
    expect(band.y).toBeCloseTo(y(44), 0);
    expect(band.y + band.h).toBeCloseTo(CANVAS_H, 0); // down to the floor
  });

  it("draws the guide and then one path through the ring", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(4);
    frame();

    // guide: beginPath, moveTo, lineTo. trace: beginPath, moveTo, 3 x lineTo.
    expect(ctx.calls.clearRect).toBe(1);
    expect(ctx.calls.beginPath).toBe(2);
    expect(ctx.calls.moveTo).toBe(2);
    expect(ctx.calls.lineTo).toBe(1 + 3);

    // the guide is a horizontal rule at the healthy ceiling, full width
    const { y } = stripScales(600, CANVAS_W, CANVAS_H, envelope("knee_L", "tempC"));
    const [guideStart, guideEnd] = [ctx.points[0]!, ctx.points[1]!];
    expect(guideStart[0]).toBe(0);
    expect(guideEnd[0]).toBe(CANVAS_W);
    expect(guideStart[1]).toBe(guideEnd[1]);
    expect(guideStart[1]).toBeCloseTo(y(44), 0);

    // and the trace ends on the right edge, where the newest sample lives
    expect(ctx.points.at(-1)![0]).toBeCloseTo(CANVAS_W);
  });

  it("skips the canvas entirely on a frame with no new telemetry", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(2);
    frame();
    const drawn = { ...ctx.calls };

    frame(); // five frames out of six look exactly like this one
    frame();
    expect(ctx.calls).toEqual(drawn);

    push(1);
    frame();
    expect(ctx.calls.clearRect).toBe(drawn.clearRect + 1);
  });

  it("does not re-render for a telemetry batch — not once, not ten times", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    expect(renders.count).toBe(1);

    for (let i = 0; i < 10; i += 1) {
      push(1);
      frame();
    }

    expect(renders.count).toBe(1);
    expect(ctx.calls.clearRect).toBe(10); // ten batches, ten draws, zero renders
  });

  it("keeps the trace in ink while the joint is inside its envelope", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(3, 34);
    frame();
    expect(ctx.strokes).toEqual([GUIDE, INK]);
    // nothing but the corridor is filled — no wash where there was no breach
    expect(ctx.rects).toHaveLength(1);
  });

  it("tints the trace with the unit's severity once the measure runs out of band", () => {
    amber();

    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(3, 52); // knee_L past its 44 C ceiling
    frame();
    expect(ctx.strokes).toEqual([GUIDE, WARN]);

    act(() => {
      useFleetStore.getState().applyAlert({
        t: "alert",
        alert: {
          id: "al-002",
          unitId: "N-07",
          severity: "red",
          message: "Sagebrush House: left knee actuator overheating",
          ts: Date.now(),
        },
      });
    });
    push(1, 55);
    frame();
    expect(ctx.strokes.slice(-1)).toEqual([ALERT]);
  });

  /**
   * The actual complaint: a trace tinted end to end says "this joint
   * is unwell" and nothing about *when*. The wash is the answer, and it is
   * drawn from the same envelope the tint is — one ceiling, two readings of it,
   * so a shaded region and an un-tinted trace can never disagree.
   */
  it("washes the stretch where the measure left the envelope, under the trace", () => {
    amber();
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(40, 34); // in band
    push(30, 52); // out of band
    push(30, 34); // back in band
    frame();

    // [0] is the corridor; [1] is the excursion
    expect(ctx.rects).toHaveLength(2);
    const wash = ctx.rects[1]!;
    expect(wash.fill).toBe(WARN);
    expect(wash.alpha).toBeLessThan(0.2);
    expect(wash.y).toBe(0);
    expect(wash.h).toBe(CANVAS_H); // full height: the region is a *when*

    // a hundred samples, thirty of them out of band: x maps through the same
    // scale the trace uses, so the wash lands under the part of the line that
    // left and nowhere else.
    const { x } = stripScales(600, CANVAS_W, CANVAS_H, envelope("knee_L", "tempC"));
    expect(wash.x).toBeCloseTo(x(40 - 99), 0);
    expect(wash.x + wash.w).toBeCloseTo(x(69 - 99), 0);
  });

  /**
   * A single sample over the line is half a pixel wide at rest. Half a pixel of
   * a 13 %-alpha wash is nothing at all, and the one-frame excursions are
   * exactly the ones an operator would never otherwise catch.
   */
  it("holds a one-sample excursion at a floor width so it cannot vanish", () => {
    amber();
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(40, 34);
    push(1, 52);
    push(40, 34);
    frame();
    expect(ctx.rects[1]!.w).toBe(2);
  });

  it("sizes its backing store for the display, not for CSS pixels", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="torqueNm" />);

    const canvas = document.querySelector("canvas");
    expect(canvas?.width).toBe(CANVAS_W * 2);
    expect(canvas?.height).toBe(CANVAS_H * 2);
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });

  it("pauses under an opaque descent and repaints the caught-up trace on ascend", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(2);
    frame();
    expect(ctx.calls.clearRect).toBe(1);

    // The surface lands. The rings keep advancing — telemetry never stops
    // during a scan — but not one hidden pixel may be painted.
    setDescentOccluded(true);
    push(5);
    frame();
    frame();
    frame();
    expect(ctx.calls.clearRect).toBe(1);

    // Ascend: the very next frame repaints once, already caught up — the
    // version compare sees everything that arrived while hidden as one skip.
    setDescentOccluded(false);
    frame();
    expect(ctx.calls.clearRect).toBe(2);
    // Seven samples now: the trace is moveTo + 6 lineTo after the guide's 1.
    expect(ctx.calls.lineTo).toBe(1 + 1 + 1 + 6);
    expect(ctx.points.at(-1)![0]).toBeCloseTo(CANVAS_W); // newest at the edge

    frame(); // and the frame after that is an ordinary no-news skip
    expect(ctx.calls.clearRect).toBe(2);
  });

  it("does not repaint a canvas that was already current when the descent lifts", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(2);
    frame();
    expect(ctx.calls.clearRect).toBe(1);

    // Nothing arrived while hidden: the pixels on screen are already the
    // truth, and repainting them would be the waste this fix removes.
    setDescentOccluded(true);
    frame();
    setDescentOccluded(false);
    frame();
    expect(ctx.calls.clearRect).toBe(1);
  });

  /**
   * The arrival beat (D1), and why it is asserted as node identity.
   *
   * The em-dash and the first reading are the same `<span>`, which is the only
   * reason a CSS transition can carry one into the other. Split them into two
   * elements — a key, a wrapper, a ternary that returns a different tag — and
   * the ink step vanishes silently: nothing throws, nothing looks broken, the
   * page just goes back to snapping. The class list is checked too, but the
   * identity is the contract.
   */
  it("inks the first reading in on the same element the em-dash was on", () => {
    vi.useFakeTimers();
    try {
      mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);

      const readout = screen.getByText("No reading yet").parentElement;
      expect(readout).toHaveClass("transition-colors", "text-ink-muted");

      // A batch alone must not move it — the numeral is on the one-second
      // ticker, which is what keeps this beat from becoming per-sample motion.
      push(3, 34);
      expect(readout).toHaveTextContent("—");

      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      expect(screen.getByText(/^34/)).toBe(readout);
      expect(readout).toHaveClass("text-ink");
      expect(readout).not.toHaveClass("text-ink-muted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws with the operator fallbacks only where the cascade is silent", () => {
    stubCascade({});
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(3, 34);
    frame();
    expect(ctx.strokes).toEqual([
      TOKEN_FALLBACK.operator["--line"],
      TOKEN_FALLBACK.operator["--ink"],
    ]);
    expect(ctx.strokes).not.toContain(INK);
  });

  it("leaves the shared loop when it unmounts", () => {
    const view = mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(1);
    view.unmount();
    frame();
    expect(ctx.calls.clearRect).toBe(0);
  });
});

/**
 * The cursor, from the strip's side.
 *
 * The grid owns the pointer (joint-grid.test.tsx owns that half); what is
 * asserted here is the contract between them — a module variable holding one
 * integer, read in the frame callback the strip already runs, and turned into
 * a rule, a dot on the sample and a readout written with `textContent`. The
 * render count is the tripwire on all of it: eighteen of these are mounted at
 * once and a pointer moves faster than telemetry arrives, so a single
 * `useState` added here for convenience would cost the page more re-renders
 * per second than the entire 10 Hz feed does.
 */
describe("TelemetryStrip cursor", () => {
  const readoutValue = () =>
    document.querySelector("[data-slot='strip-cursor-readout']")?.firstElementChild
      ?.textContent;
  const readoutTone = () =>
    document
      .querySelector("[data-slot='strip-cursor-readout']")
      ?.getAttribute("data-tone");

  it("draws a rule and a dot on the hovered sample, and prints its value", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(5, 31);
    push(5, 37);
    frame();
    expect(readoutValue()).toBe("—");

    act(() => setCursor("N-07", -4, false));
    frame();

    const { x, y } = stripScales(600, CANVAS_W, CANVAS_H, envelope("knee_L", "tempC"));
    // The rule spans the plot at the hovered offset…
    const rule = ctx.points.slice(-4, -2);
    expect(rule[0]![0]).toBeCloseTo(x(-4), 0);
    expect(rule[0]![1]).toBe(0);
    expect(rule[1]![1]).toBe(CANVAS_H);
    // …and the dot lands on the sample the numeral is printing.
    expect(ctx.calls.arc).toBe(2); // plate + mark
    expect(ctx.points.at(-1)![1]).toBeCloseTo(y(37), 0);
    expect(readoutValue()).toBe("37.0");
    expect(readoutTone()).toBe("ink");
  });

  it("colours the readout when the hovered sample is the one out of band", () => {
    amber();
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(5, 34);
    push(1, 52);
    frame();

    act(() => setCursor("N-07", 0, false));
    frame();
    expect(readoutValue()).toBe("52.0");
    expect(readoutTone()).toBe("warn");

    // …and drops back to ink one sample earlier, because the question the
    // cursor answers is about *that* reading, not about the joint's mood.
    act(() => setCursor("N-07", -1, false));
    frame();
    expect(readoutValue()).toBe("34.0");
    expect(readoutTone()).toBe("ink");
  });

  it("costs nothing on a frame where the cursor has not moved", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(6);
    act(() => setCursor("N-07", -2, false));
    frame();
    const drawn = { ...ctx.calls };

    frame();
    frame();
    expect(ctx.calls).toEqual(drawn);
  });

  it("ignores a cursor belonging to another unit", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(6);
    frame();
    const drawn = { ...ctx.calls };

    act(() => setCursor("N-03", -2, false));
    frame();
    expect(ctx.calls).toEqual(drawn);
    expect(readoutValue()).toBe("—");
  });

  it("re-renders nothing across a hundred pointer positions", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(120);
    frame();
    expect(renders.count).toBe(1);

    for (let i = 0; i < 100; i += 1) {
      act(() => setCursor("N-07", -i, false));
      frame();
    }

    expect(renders.count).toBe(1);
    expect(readoutValue()).not.toBe("—"); // it did move; it just did not render
  });
});

/**
 * Expansion: the same engine, told to say the numbers out loud.
 *
 * A resting strip has no axis because at 56 px an axis is louder than the data.
 * Expanding one is an operator asking to measure rather than to scan, so that
 * is when the envelope's three values and the window's three times appear —
 * and they come from `valueAxis`/`timeAxis`, which read the same envelope the
 * bands and the tint do.
 */
describe("TelemetryStrip expanded", () => {
  it("writes the envelope down the left, names the reference, and dates the window", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" expanded />);
    push(3, 34);
    frame();

    const printed = ctx.texts.map((t) => t.text);
    expect(printed).toContain("60 °C"); // ceiling of the drawn box
    expect(printed).toContain("44 °C"); // the healthy line…
    expect(printed).toContain("healthy"); // …and the word for it
    expect(printed).toContain("26 °C"); // floor
    expect(printed).toContain("−60 s");
    expect(printed).toContain("−30 s");
    expect(printed).toContain("now");
  });

  it("says nothing extra while it is resting", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" />);
    push(3, 34);
    frame();
    expect(ctx.texts).toHaveLength(0);
  });

  it("keeps the time axis out of the plot so the trace is not drawn over it", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" expanded />);
    push(2, 26); // pinned to the floor: the lowest the trace can go
    frame();
    const lowest = Math.max(...ctx.points.map(([, y]) => y));
    const timeLabel = ctx.texts.find((t) => t.text === "now")!;
    expect(lowest).toBeLessThan(timeLabel.y);
  });

  it("offers the expansion as a labelled control, not as a bare click target", () => {
    const onToggleExpand = vi.fn();
    mount(
      <TelemetryStrip
        unitId="N-07"
        joint="knee_L"
        metric="tempC"
        onToggleExpand={onToggleExpand}
      />,
    );
    const control = screen.getByRole("button");
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(control).toHaveAccessibleName(/left knee — expand/i);
    fireEvent.click(control);
    expect(onToggleExpand).toHaveBeenCalledOnce();
  });

  it("grows the box rather than adding one beside it", () => {
    const view = mount(
      <TelemetryStrip
        unitId="N-07"
        joint="knee_L"
        metric="tempC"
        onToggleExpand={vi.fn()}
      />,
    );
    const canvas = document.querySelector("canvas")!;
    expect(canvas.style.height).toBe(`${TELEMETRY_STRIP_HEIGHT}px`);

    view.rerender(
      <TelemetryStrip
        unitId="N-07"
        joint="knee_L"
        metric="tempC"
        expanded
        onToggleExpand={vi.fn()}
      />,
    );
    expect(document.querySelectorAll("canvas")).toHaveLength(1);
    expect(canvas.style.height).toBe(`${TELEMETRY_STRIP_EXPANDED_HEIGHT}px`);
    // …and the axes arrive with the first pixel of the growth, not at the end
    // of it: the layout effect repaints before the observer has caught up.
    expect(ctx.texts.map((t) => t.text)).toContain("healthy");
  });
});

/**
 * Compare with the opposite joint.
 *
 * Asymmetry between a pair is the first thing anyone looks for in a walking
 * machine, and until this beat the grid could *show* it — the layout puts knees
 * above knees for exactly that reason — but nobody could measure it. So an
 * expanded strip will overlay the other leg's trace and print the difference at
 * the cursor.
 *
 * Three claims are checked here and they are all cheap to lose. The overlay
 * borrows the primary's scales, because a pair is the same hardware and
 * joint-spec.ts scales the two identically on purpose; two traces drawn against
 * two domains would be a picture of nothing. It adds no colour, because amber
 * and clay already mean something on this panel. And it costs no allocation:
 * the second series is read through `copyInto` into a second module scratch,
 * and even the dash pattern is a module constant.
 */
describe("TelemetryStrip compare", () => {
  /** One batch carrying both knees, so the two rings stay in lockstep. */
  function pushPair(n: number, left: number, right: number): void {
    act(() => {
      for (let i = 0; i < n; i += 1) {
        useFleetStore.getState().applyTelemetry({
          t: "telemetry",
          unitId: "N-07",
          ts: 1_700_000_000_000 + i * 100,
          batch: [
            { joint: "knee_L", battery: 80, tempC: left, torqueNm: 12, currentA: 1.6 },
            { joint: "knee_R", battery: 80, tempC: right, torqueNm: 11, currentA: 1.5 },
          ],
        });
      }
    });
  }

  const toggle = () => screen.getByRole("button", { name: /overlay right knee/i });
  const deltaText = () =>
    document.querySelector("[data-slot='strip-cursor-delta']")?.textContent;

  it("offers the comparison only where there is room to read it", () => {
    const view = mount(
      <TelemetryStrip
        unitId="N-07"
        joint="knee_L"
        metric="tempC"
        onToggleExpand={vi.fn()}
      />,
    );
    // At 56 px the operator is scanning shapes across eighteen boxes; the
    // pair comparison there is a glance down a column of the grid.
    expect(screen.queryByRole("button", { name: /overlay/i })).not.toBeInTheDocument();

    view.rerender(
      <TelemetryStrip
        unitId="N-07"
        joint="knee_L"
        metric="tempC"
        expanded
        onToggleExpand={vi.fn()}
      />,
    );
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(toggle()).toHaveTextContent("Compare right");
  });

  it("says nothing about comparing a joint with no opposite number", () => {
    // Not a joint this fleet has a pair for; the control simply is not offered
    // rather than being offered and doing nothing.
    mount(<TelemetryStrip unitId="N-07" joint="spine" metric="tempC" expanded />);
    expect(screen.queryByRole("button", { name: /overlay/i })).not.toBeInTheDocument();
  });

  it("draws the second trace dashed, dimmer, and under the first", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" expanded />);
    pushPair(4, 40, 34);
    frame();
    const alone = ctx.calls.lineTo;
    expect(ctx.dashes).toHaveLength(0);

    ctx.reset();
    fireEvent.click(toggle());

    // One more trace over the same ground: four samples, three segments. The
    // envelope and its guide are drawn once, not twice — the overlay is a
    // second reading inside this strip's box, not a second strip.
    expect(ctx.calls.lineTo).toBe(alone + 3);
    expect(ctx.dashes).toEqual([[3, 3], []]);
    // The overlay is ink at reduced strength: no third colour on a panel where
    // amber and clay already mean something specific.
    expect(ctx.strokes).toContain(INK);
    expect(ctx.strokes).not.toContain(WARN);
  });

  it("puts the other leg's samples on this strip's own scales", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" expanded />);
    pushPair(3, 40, 34);
    frame();
    ctx.reset();
    fireEvent.click(toggle());

    // Expanded, so the plot is the box less the time axis.
    const { x, y } = stripScales(
      600,
      CANVAS_W,
      CANVAS_H - 18,
      envelope("knee_L", "tempC"),
    );
    // Points 0–1 are the healthy guide. Then the overlay, stroked before the
    // primary so the primary lands on top: right knee at 34 °C, read through
    // the *left* knee's y — same joint class, same envelope, which is the only
    // reason the two are comparable at all.
    expect(ctx.points[2]).toEqual([x(-2), y(34)]);
    expect(ctx.points[4]).toEqual([x(0), y(34)]);
    // …and the primary follows, at its own value, on the same x.
    expect(ctx.points[5]).toEqual([x(-2), y(40)]);
  });

  it("prints the difference at the cursor, signed", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" expanded />);
    pushPair(5, 40.2, 34.4);
    frame();
    // Nothing to compare against until it is asked for: an un-compared strip
    // has no Δ element in the layout at all.
    act(() => setCursor("N-07", 0, false));
    frame();
    expect(deltaText()).toBe("");

    fireEvent.click(toggle());
    expect(deltaText()).toBe("Δ +5.8");
  });

  it("reads the same instant in both rings", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" expanded />);
    pushPair(4, 40, 34);
    pushPair(4, 33, 44); // the pair swaps over: the newer half is the other way round
    frame();
    fireEvent.click(toggle());

    act(() => setCursor("N-07", 0, false));
    frame();
    expect(deltaText()).toBe("Δ −11.0");

    act(() => setCursor("N-07", -5, false));
    frame();
    expect(deltaText()).toBe("Δ +6.0");
  });

  it("prints a plain zero rather than a negative one when the legs agree", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" expanded />);
    pushPair(3, 36, 36.01); // −0.01 rounds to −0.0, which reads as a fault
    frame();
    fireEvent.click(toggle());
    act(() => setCursor("N-07", 0, false));
    frame();
    expect(deltaText()).toBe("Δ +0.0");
  });

  it("drops the overlay and the Δ when the comparison is turned off", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" expanded />);
    pushPair(4, 40, 34);
    frame();
    fireEvent.click(toggle());
    act(() => setCursor("N-07", 0, false));
    frame();
    expect(deltaText()).toBe("Δ +6.0");

    ctx.reset();
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(ctx.dashes).toHaveLength(0);
    expect(deltaText()).toBe("");
  });

  it("allocates nothing per frame — one scratch, one dash pattern", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" expanded />);
    pushPair(4, 40, 34);
    frame();
    fireEvent.click(toggle());
    const [firstDash, firstClear] = ctx.dashes;

    // Ten more frames' worth of cursor movement over a live overlay.
    for (let i = 0; i < 10; i += 1) {
      act(() => setCursor("N-07", -i, false));
      frame();
    }
    // Same two arrays every time: module constants, not literals in the loop.
    for (let i = 0; i < ctx.dashes.length; i += 2) {
      expect(ctx.dashes[i]).toBe(firstDash);
      expect(ctx.dashes[i + 1]).toBe(firstClear);
    }
  });

  it("costs one render for the click and none for the pointer after it", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" expanded />);
    pushPair(120, 40, 34);
    frame();
    renders.count = 0;

    fireEvent.click(toggle());
    expect(renders.count).toBe(1); // the toggle is state; the overlay is not

    for (let i = 0; i < 50; i += 1) {
      act(() => setCursor("N-07", -i, false));
      frame();
    }
    expect(renders.count).toBe(1);
    expect(deltaText()).toBe("Δ +6.0");
  });

  it("is a real toggle button, operable from the keyboard", () => {
    mount(<TelemetryStrip unitId="N-07" joint="knee_L" metric="tempC" expanded />);
    pushPair(3, 40, 34);
    frame();

    const control = toggle();
    control.focus();
    expect(control).toHaveFocus();
    // The accessible name says which joint: "Compare right" is only
    // unambiguous next to a cell heading the reader has already moved past.
    expect(control).toHaveAccessibleName(/overlay right knee on this trace/i);

    fireEvent.click(control);
    expect(control).toHaveAttribute("aria-pressed", "true");
  });
});
