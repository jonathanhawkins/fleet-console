import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { type DiagChannel, useIncidentStore } from "@/lib/stores";
import { TOKEN_FALLBACK } from "@/lib/tokens/fallback";
import { parseWireframe } from "@/lib/wireframe/parse";
import { L_CONTOUR, L_GHOST, LEVEL_ALPHA, LEVELS } from "@/lib/wireframe/tiers";
import { type DiagEventMessage } from "@/lib/schema";
import { StatusBoard } from "./status-board";
import {
  loadWireframe,
  nodeIndexForJoint,
  nodeNameForJoint,
  resetWireframeCacheForTests,
  anchorSiteForJoint,
  segmentsAnchor,
  segmentsBoxCenter,
  WireframeElevation,
  WIREFRAME_URL,
} from "./wireframe-elevation";

/**
 * Three things are worth pinning here, and they are the three that
 * would fail silently in a demo.
 *
 * **The fallback.** The elevation is the only drawing on the board, and it now
 * depends on a network fetch. If that fetch is blocked, malformed, or simply
 * slow, the board must still show a robot — the hand-drawn SVG — and must never
 * show a hole. Two of these tests are that path, because it is the one nobody
 * looks at.
 *
 * **The tint and the draw order.** "The knee turns red when the flag lands" is
 * the single frame the whole descent is built toward. It is asserted against a
 * recording 2D context rather than against pixels: which node was stroked, in
 * what colour, in what order, and how many segments it carried.
 *
 * **The anchor.** The magenta leader line is only true if it points at the
 * knee; the arithmetic that finds the knee is pure and is tested as such.
 *
 * The model is read off disk at run time (like lib/wireframe's own tests) so
 * nothing here hardcodes a vertex count that a re-extraction would invalidate.
 */

// `import.meta.url` is an http URL under jsdom, so this resolves from the
// vitest root instead (vitest.config.ts pins it to the repo root).
const ASSET_PATH = resolve(process.cwd(), "public/models/chassis-wireframe.json");
const RAW = readFileSync(ASSET_PATH, "utf8");
const MODEL = parseWireframe(JSON.parse(RAW));

// ---------------------------------------------------------------------------
// Environment: jsdom has no ResizeObserver, no canvas, and no measurable boxes.
// ---------------------------------------------------------------------------

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** One recorded `stroke()`: what it was drawn with, and how much it drew. */
interface Pass {
  style: string;
  alpha: number;
  segments: number;
}

interface Recorder {
  ctx: CanvasRenderingContext2D;
  passes: Pass[];
  clears: number;
}

function recordingContext(): Recorder {
  const passes: Pass[] = [];
  let segments = 0;
  const state = { strokeStyle: "", globalAlpha: 1, clears: 0 };
  const ctx = {
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    setTransform: () => {},
    clearRect: () => {
      state.clears += 1;
    },
    beginPath: () => {
      segments = 0;
    },
    moveTo: () => {
      segments += 1;
    },
    lineTo: () => {},
    stroke: () => {
      passes.push({ style: state.strokeStyle, alpha: state.globalAlpha, segments });
    },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    passes,
    get clears() {
      return state.clears;
    },
  };
}

let queue: FrameRequestCallback[] = [];

/** Run whatever the shared loop has scheduled, once, at `now`. */
function frame(now: number): void {
  const due = queue;
  queue = [];
  act(() => {
    for (const cb of due) cb(now);
  });
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
let recorder: Recorder | null = null;

beforeEach(() => {
  resetWireframeCacheForTests();
  useIncidentStore.getState().reset();
  queue = [];
  let handle = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    handle += 1;
    queue.push(cb);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  // A canvas in jsdom is 0x0 and has no context; both are supplied here so the
  // component's real draw path runs.
  Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", {
    value: 144,
    configurable: true,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "clientHeight", {
    value: 352,
    configurable: true,
  });
  recorder = null;
  HTMLCanvasElement.prototype.getContext = (() =>
    recorder?.ctx ?? null) as typeof originalGetContext;
});

afterEach(() => {
  vi.unstubAllGlobals();
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.restoreAllMocks();
});

/** Resolve every pending microtask so a stubbed fetch has actually landed. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const ok = (body: string) =>
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(JSON.parse(body)),
    } as Response),
  );

/** Drive the real store through the scripted incident up to the flag. */
function toFlag(): void {
  const ev = (e: DiagEventMessage["ev"]): DiagEventMessage => ({
    t: "diag_event",
    unitId: "N-07",
    ev: e,
  });
  act(() => {
    useIncidentStore.getState().beginDescent("N-07");
    useIncidentStore.getState().applyDiagEvent(ev({ k: "scan_start" }));
    useIncidentStore
      .getState()
      .applyDiagEvent(
        ev({ k: "flag", joint: "knee_L", component: "actuator_A07", anomaly: "gain" }),
      );
  });
}

/**
 * …and on to the ending the board has to be able to draw: a standing verdict,
 * then the machine's own re-measure saying the channel came back.
 */
function toCleared(): void {
  const ev = (e: DiagEventMessage["ev"]): DiagEventMessage => ({
    t: "diag_event",
    unitId: "N-07",
    ev: e,
  });
  toFlag();
  act(() => {
    const s = useIncidentStore.getState();
    s.applyDiagEvent(
      ev({
        k: "verdict",
        report: {
          unitId: "N-07",
          joint: "knee_L",
          component: "actuator_A07",
          anomaly: "gain",
          summary: "LEFT KNEE ACTUATOR A-07: GAIN ANOMALY.",
          recommendations: ["Recalibrate joint"],
          ts: 120_000,
        },
      }),
    );
    s.applyDiagEvent(
      ev({
        k: "recalibration",
        joint: "knee_L",
        wave: [0, 0.5, 0, -0.5],
        ref: [0, 0.5, 0, -0.5],
        outcome: "cleared",
      }),
    );
  });
}

// ---------------------------------------------------------------------------

describe("nodeNameForJoint", () => {
  it("sends each knee to its own actuator module", () => {
    expect(nodeNameForJoint("knee_L")).toBe("knee_actuator_L");
    expect(nodeNameForJoint("knee_R")).toBe("knee_actuator_R");
  });

  it("sends hips and ankles to the leg they belong to", () => {
    // The extraction only splits out what the scan can flag; a hip has no
    // module of its own, so it tints the limb.
    expect(nodeNameForJoint("hip_L")).toBe("leg_L");
    expect(nodeNameForJoint("ankle_L")).toBe("leg_L");
    expect(nodeNameForJoint("hip_R")).toBe("leg_R");
    expect(nodeNameForJoint("ankle_R")).toBe("leg_R");
  });

  it("resolves nothing for a joint the model does not carry", () => {
    expect(nodeNameForJoint("torso_yaw")).toBeNull();
    expect(nodeNameForJoint(null)).toBeNull();
    expect(nodeNameForJoint(undefined)).toBeNull();
  });
});

describe("nodeIndexForJoint", () => {
  it("resolves the flagged joint to the left knee actuator's own node", () => {
    const knee = MODEL.byName.get("knee_actuator_L");
    expect(knee).toBeDefined();
    expect(nodeIndexForJoint(MODEL, "knee_L")).toBe(MODEL.nodes.indexOf(knee!));
  });

  it("is -1 with no model, no joint, or an unmodelled joint", () => {
    expect(nodeIndexForJoint(null, "knee_L")).toBe(-1);
    expect(nodeIndexForJoint(MODEL, null)).toBe(-1);
    expect(nodeIndexForJoint(MODEL, "torso_yaw")).toBe(-1);
  });
});

describe("segmentsAnchor", () => {
  // A limb: one long vertical quad from y=0 (hip) to y=100 (foot) with a
  // narrow foot at the bottom and a wide hip at the top.
  const limb = Float32Array.from([
    5,
    0,
    5,
    100, // the shin, top to bottom
    0,
    2,
    10,
    2, // the hip rim, wide
    3,
    85,
    7,
    85, // the ankle rim
    2,
    98,
    8,
    98, // the foot
  ]);

  it("lands an ankle in the band just above the foot, not mid-shin", () => {
    const out = { x: 0, y: 0 };
    expect(segmentsAnchor(limb, out, "bottom")).toBe(true);
    expect(out.y).toBeGreaterThan(75);
    expect(out.y).toBeLessThan(91);
    expect(out.x).toBe(5);
  });

  it("lands a hip at the top of the leg", () => {
    const out = { x: 0, y: 0 };
    expect(segmentsAnchor(limb, out, "top")).toBe(true);
    expect(out.y).toBeLessThan(25);
  });

  it("is the box centre for a module", () => {
    const out = { x: 0, y: 0 };
    expect(segmentsAnchor(limb, out, "center")).toBe(true);
    expect(out.y).toBe(50);
  });

  it("resolves the site from the joint name", () => {
    expect(anchorSiteForJoint("ankle_R")).toBe("bottom");
    expect(anchorSiteForJoint("hip_L")).toBe("top");
    expect(anchorSiteForJoint("knee_L")).toBe("center");
    expect(anchorSiteForJoint(null)).toBe("center");
  });
});

describe("segmentsBoxCenter", () => {
  it("centres on the bounding box of the quads, not on their endpoints", () => {
    // Three segments crowded at the left plus one reaching right: a centroid
    // would sit at x≈2.5, the bbox centre sits at 5.
    const seg = Float32Array.from([0, 0, 1, 0, 0, 2, 1, 2, 0, 4, 1, 4, 9, 0, 10, 8]);
    const out = { x: 0, y: 0 };
    expect(segmentsBoxCenter(seg, out)).toBe(true);
    expect(out.x).toBe(5);
    expect(out.y).toBe(4);
  });

  it("reports nothing for an empty or absent segment list", () => {
    const out = { x: -1, y: -1 };
    expect(segmentsBoxCenter(undefined, out)).toBe(false);
    expect(segmentsBoxCenter(new Float32Array(0), out)).toBe(false);
    expect(out).toEqual({ x: -1, y: -1 });
  });
});

/** The ink passes of one frame — everything but the flagged module. */
const inkPasses = (passes: Pass[]): Pass[] =>
  passes.filter((p) => p.style !== ALERT_STYLE);
const ALERT_STYLE = TOKEN_FALLBACK.machine["--alert"]; // what --alert falls back to under jsdom
const NOMINAL_STYLE = TOKEN_FALLBACK.machine["--nominal"];

/**
 * The subject's pass, by the one property no ladder tier can wear.
 *
 * Under jsdom `--nominal` and `--ink` fall back to the same phosphor, so once
 * the subject is drawn in nominal its *colour* no longer tells it apart from
 * the fourteen modules around it. Its alpha still does: the ladder tops out at
 * ALPHA_CONTOUR (0.72) and the subject is stroked at 0.95, because it defers to
 * nothing whichever tone it is wearing.
 */
const SUBJECT_ALPHA = 0.95;
const subjectPass = (passes: Pass[]): Pass | undefined =>
  passes.filter((p) => p.alpha === SUBJECT_ALPHA).at(-1);

describe("WireframeElevation drawing", () => {
  it("draws the figure as a rising luminance ladder, dimmest tier first", () => {
    const rec = recordingContext();
    recorder = rec;
    const allEdges = MODEL.nodes.reduce((sum, n) => sum + n.edgeCount, 0);

    render(<WireframeElevation data={MODEL} />);
    frame(1000);

    expect(rec.clears).toBe(1);
    // Ghost, four depth bands of body, four of contour — every occupied level
    // is its own stroke, and an empty one costs nothing.
    expect(rec.passes.length).toBeGreaterThanOrEqual(3);
    expect(rec.passes.length).toBeLessThanOrEqual(LEVELS);

    // Strictly ascending alpha IS the draw order: it is the luminance order
    // machine space wants, and within a tier it is painter order, far to near.
    for (let i = 1; i < rec.passes.length; i += 1) {
      expect(rec.passes[i]!.alpha).toBeGreaterThan(rec.passes[i - 1]!.alpha);
    }
    // Every alpha is a rung of the shared ladder, not an ad-hoc number.
    for (const pass of rec.passes) {
      expect(Array.from(LEVEL_ALPHA)).toContain(pass.alpha);
    }
    // Every edge is drawn exactly once, across all of them.
    expect(rec.passes.reduce((sum, p) => sum + p.segments, 0)).toBe(allEdges);
  });

  it("populates all three tiers — a back, a front and an outline", () => {
    const rec = recordingContext();
    recorder = rec;
    render(<WireframeElevation data={MODEL} />);
    frame(1000);

    const alphas = rec.passes.map((p) => p.alpha);
    const ghost = LEVEL_ALPHA[L_GHOST]!;
    expect(alphas).toContain(ghost);
    // something in the body tier...
    expect(alphas.some((a) => a > ghost && a < LEVEL_ALPHA[L_CONTOUR]!)).toBe(true);
    // ...and something on the silhouette.
    expect(alphas.some((a) => a >= LEVEL_ALPHA[L_CONTOUR]!)).toBe(true);

    // The back of the figure is a real share of it, and it is the dimmest
    // thing drawn — this is what stops the lines piling up at an oblique yaw.
    const ghostPass = rec.passes.find((p) => p.alpha === ghost)!;
    const allEdges = MODEL.nodes.reduce((sum, n) => sum + n.edgeCount, 0);
    expect(ghostPass.segments / allEdges).toBeGreaterThan(0.2);
    expect(ghostPass).toBe(rec.passes[0]);
  });

  it("draws the flagged module last, in alert, above every tier", () => {
    const rec = recordingContext();
    recorder = rec;
    const knee = MODEL.byName.get("knee_actuator_L");
    expect(knee).toBeDefined();
    const kneeEdges = knee!.edgeCount;
    const otherEdges = MODEL.nodes.reduce(
      (sum, n) => (n === knee ? sum : sum + n.edgeCount),
      0,
    );

    render(<WireframeElevation data={MODEL} damagedJoint="knee_L" />);
    frame(1000);

    const alert = rec.passes[rec.passes.length - 1]!;
    const ink = inkPasses(rec.passes);
    // The knee arrives whole, in one pass, in a different colour, over the top.
    expect(alert.style).toBe(ALERT_STYLE);
    expect(alert.segments).toBe(kneeEdges);
    expect(ink).toHaveLength(rec.passes.length - 1);
    expect(ink.reduce((sum, p) => sum + p.segments, 0)).toBe(otherEdges);
    // It never recedes and never ghosts: brighter than the brightest tier,
    // whichever way the module happens to be pointing this frame.
    for (const pass of ink) expect(alert.alpha).toBeGreaterThan(pass.alpha);
  });

  it("keeps the flagged module at full alert through a whole turn", () => {
    // The tiers are a function of yaw, so "always full red" is only true if
    // the module is excluded from them at EVERY angle, not just at yaw 0.
    const rec = recordingContext();
    recorder = rec;
    const kneeEdges = MODEL.byName.get("knee_actuator_L")!.edgeCount;

    render(<WireframeElevation data={MODEL} damagedJoint="knee_L" />);
    for (let t = 1000; t <= 9000; t += 100) frame(t);

    const alerts = rec.passes.filter((p) => p.style === ALERT_STYLE);
    expect(alerts.length).toBeGreaterThan(50);
    const alphas = new Set(alerts.map((p) => p.alpha));
    expect(alphas.size).toBe(1); // one alpha, forever
    expect(alerts.every((p) => p.segments === kneeEdges)).toBe(true);
  });

  /**
   * The subject's tone is a fact about the diagnosis, not about the drawing.
   *
   * The flag paints the module red and that is the frame the whole descent is
   * built toward — but once the machine's own re-measure has put the channel
   * back inside its envelope, a red limb is the last surface on the board still
   * reporting a fault nobody has. The module stays the subject either way: last
   * pass, above every tier, whole.
   */
  it("draws the subject in nominal once the tone says the channel came back", () => {
    const rec = recordingContext();
    recorder = rec;
    const kneeEdges = MODEL.byName.get("knee_actuator_L")!.edgeCount;

    render(
      <WireframeElevation data={MODEL} damagedJoint="knee_L" subjectTone="nominal" />,
    );
    frame(1000);

    const subject = subjectPass(rec.passes)!;
    expect(subject).toBeDefined();
    // The claim: not red any more.
    expect(subject.style).not.toBe(ALERT_STYLE);
    expect(subject.style).toBe(NOMINAL_STYLE);
    expect(rec.passes.some((p) => p.style === ALERT_STYLE)).toBe(false);
    // …and still the subject: drawn last, whole, over the top of the ladder.
    expect(subject).toBe(rec.passes[rec.passes.length - 1]);
    expect(subject.segments).toBe(kneeEdges);
    for (const pass of rec.passes.slice(0, -1)) {
      expect(subject.alpha).toBeGreaterThan(pass.alpha);
    }
  });

  it("defaults to alert, because that is what a flag means until it is answered", () => {
    const rec = recordingContext();
    recorder = rec;
    render(<WireframeElevation data={MODEL} damagedJoint="knee_L" />);
    frame(1000);
    expect(subjectPass(rec.passes)!.style).toBe(ALERT_STYLE);
  });

  it("repaints when the tone lands, without tearing down the frame loop", () => {
    // The loop subscribes once on mount and reads the tone per frame, so an
    // outcome arriving twenty seconds into a standing verdict has to reach the
    // next frame through the dirty check — which compares yaw, flag and lift,
    // and would happily skip a repaint that only changed a colour.
    const rec = recordingContext();
    recorder = rec;
    const { rerender } = render(
      <WireframeElevation data={MODEL} damagedJoint="knee_L" reducedMotion />,
    );
    frame(1000);
    expect(subjectPass(rec.passes)!.style).toBe(ALERT_STYLE);
    const before = rec.passes.length;

    rerender(
      <WireframeElevation
        data={MODEL}
        damagedJoint="knee_L"
        reducedMotion
        subjectTone="nominal"
      />,
    );
    // Reduced motion holds the yaw still, so nothing but the tone has moved:
    // a frame that draws at all is the dirty check having noticed it.
    frame(1100);
    expect(rec.passes.length).toBeGreaterThan(before);
    expect(subjectPass(rec.passes)!.style).toBe(NOMINAL_STYLE);
  });

  it("keeps reporting the leader line's anchor after the tone changes", () => {
    // The magenta leader is the one object on the board whose whole job is to
    // say "this module and that row are the same thing", and a restored row is
    // exactly when it still has something to say. The anchor is derived from
    // the flagged node index, which the tone must not disturb.
    const rec = recordingContext();
    recorder = rec;
    const seen: Array<[number, number, number]> = [];
    render(
      <WireframeElevation
        data={MODEL}
        damagedJoint="knee_L"
        subjectTone="nominal"
        onAnchorChange={(x, y, clearX) => seen.push([x, y, clearX])}
      />,
    );
    for (let t = 1000; t <= 3000; t += 100) frame(t);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("says what the module is marked as, not just that it is marked", () => {
    recorder = recordingContext();
    const { rerender } = render(
      <WireframeElevation data={MODEL} damagedJoint="knee_L" />,
    );
    // The canvas is the picture; the wrapper is the turntable control.
    expect(screen.getByRole("img")).toHaveAccessibleName(/knee L marked damaged/i);
    rerender(
      <WireframeElevation data={MODEL} damagedJoint="knee_L" subjectTone="nominal" />,
    );
    expect(screen.getByRole("img")).toHaveAccessibleName(/knee L marked restored/i);
  });

  it("holds a static front elevation under prefers-reduced-motion", () => {
    const rec = recordingContext();
    recorder = rec;
    render(<WireframeElevation data={MODEL} reducedMotion />);

    frame(1000);
    const drawn = rec.passes.length;
    expect(drawn).toBeGreaterThanOrEqual(3);
    // Five seconds later the turntable would be 15° round; reduced motion
    // means yaw never leaves 0, so there is nothing to redraw at all — which
    // is what lets the e2e assertion compare two canvas reads byte for byte.
    frame(6000);
    expect(rec.passes).toHaveLength(drawn);
  });

  it("lifts the sweeping joint by one tier, then steps it back down", () => {
    const rec = recordingContext();
    recorder = rec;
    const channels = (...joints: string[]) =>
      joints.map((joint) => ({ joint }) as DiagChannel);

    const view = render(<WireframeElevation data={MODEL} channels={channels("hip_L")} />);
    frame(1000);
    const before = rec.passes.length;

    // A channel the panel has not seen before lands: leg_L lifts.
    view.rerender(
      <WireframeElevation data={MODEL} channels={channels("hip_L", "knee_R")} />,
    );
    frame(1100);
    const lifted = rec.passes.slice(before);
    expect(lifted.length).toBeGreaterThan(0);
    // The lift moves edges UP the ladder, so the top of the ladder gains.
    const topBefore = rec.passes
      .slice(0, before)
      .filter((p) => p.alpha === LEVEL_ALPHA[LEVELS - 1]!)
      .reduce((s, p) => s + p.segments, 0);
    const topAfter = lifted
      .filter((p) => p.alpha === LEVEL_ALPHA[LEVELS - 1]!)
      .reduce((s, p) => s + p.segments, 0);
    expect(topAfter).toBeGreaterThan(topBefore);

    // Every rung is still a rung of the shared ladder, and every edge is
    // still drawn exactly once — a lift redistributes, it does not duplicate.
    const allEdges = MODEL.nodes.reduce((sum, n) => sum + n.edgeCount, 0);
    expect(lifted.reduce((sum, p) => sum + p.segments, 0)).toBe(allEdges);
    for (const pass of lifted) expect(Array.from(LEVEL_ALPHA)).toContain(pass.alpha);

    // Past the window the boost is gone and the ladder is back to plain.
    const mark = rec.passes.length;
    frame(1100 + 1500);
    const after = rec.passes.slice(mark);
    const topSettled = after
      .filter((p) => p.alpha === LEVEL_ALPHA[LEVELS - 1]!)
      .reduce((s, p) => s + p.segments, 0);
    expect(topSettled).toBeLessThan(topAfter);
  });

  it("turns, and reports the flagged module's moving anchor", () => {
    const rec = recordingContext();
    recorder = rec;
    const anchors: Array<[number, number, number]> = [];
    render(
      <WireframeElevation
        data={MODEL}
        damagedJoint="knee_L"
        onAnchorChange={(x, y, clearX) => anchors.push([x, y, clearX])}
      />,
    );

    frame(1000);
    expect(anchors).toHaveLength(1);
    // Two seconds of frames — 6° of yaw. Driven as frames rather than as one
    // long jump on purpose: the loop clamps a single delta to 100 ms, so a
    // backgrounded tab resumes turning instead of snapping round.
    for (let t = 1100; t <= 3000; t += 100) frame(t);
    expect(rec.passes.length).toBeGreaterThan(2);
    expect(anchors.length).toBeGreaterThan(1);
    const last = anchors[anchors.length - 1]!;
    expect(last[0]).not.toBe(anchors[0]![0]);
    // It turns about the figure's vertical axis, so the knee's height holds.
    expect(last[1]).toBeCloseTo(anchors[0]![1], 3);
  });

  it("reports a break-out x clear of the whole figure, not just the knee", () => {
    recorder = recordingContext();
    let report: [number, number, number] | null = null;
    render(
      <WireframeElevation
        data={MODEL}
        damagedJoint="knee_L"
        onAnchorChange={(x, y, clearX) => {
          report = [x, y, clearX];
        }}
      />,
    );
    frame(1000);

    const [x, , clearX] = report!;
    // Past the anchor, past the arm on that side, and still inside the box —
    // the leader's vertical run has to miss the drawing without leaving it.
    expect(clearX).toBeGreaterThan(x);
    // The figure is fitted with a 6 px margin in a 144 px box, so its right
    // edge is at most 138; clearance adds 5.
    expect(clearX).toBeGreaterThan(72);
    expect(clearX).toBeLessThanOrEqual(143);
  });
});

describe("WireframeElevation turntable controls", () => {
  // Reduced motion in every test here: with the auto-turn off, any redraw or
  // anchor movement after frame 1 can only have come from the interaction
  // under test.
  it("rotates under a pointer drag, even with reduced motion", () => {
    const rec = recordingContext();
    recorder = rec;
    const anchors: number[] = [];
    render(
      <WireframeElevation
        data={MODEL}
        reducedMotion
        damagedJoint="knee_L"
        onAnchorChange={(x) => anchors.push(x)}
      />,
    );
    frame(1000);
    const settled = rec.passes.length;
    frame(1100);
    expect(rec.passes).toHaveLength(settled); // static until touched

    const dial = screen.getByRole("slider", { name: "Model turntable" });
    fireEvent.pointerDown(dial, { pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(dial, { pointerId: 1, clientX: 90 });
    fireEvent.pointerUp(dial, { pointerId: 1, clientX: 90 });
    frame(1200);

    expect(rec.passes.length).toBeGreaterThan(settled);
    expect(anchors.length).toBeGreaterThan(1);
    expect(anchors[anchors.length - 1]).not.toBe(anchors[0]);
  });

  it("ignores pointers that never went down, and other pointers' moves", () => {
    const rec = recordingContext();
    recorder = rec;
    render(<WireframeElevation data={MODEL} reducedMotion />);
    frame(1000);
    const settled = rec.passes.length;

    const dial = screen.getByRole("slider", { name: "Model turntable" });
    fireEvent.pointerMove(dial, { pointerId: 1, clientX: 90 }); // no down
    fireEvent.pointerDown(dial, { pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(dial, { pointerId: 2, clientX: 400 }); // someone else
    fireEvent.pointerUp(dial, { pointerId: 1, clientX: 40 });
    frame(1100);

    expect(rec.passes).toHaveLength(settled);
  });

  it("steps 15° per arrow key and reports it to aria-valuenow", () => {
    const rec = recordingContext();
    recorder = rec;
    const anchors: number[] = [];
    render(
      <WireframeElevation
        data={MODEL}
        reducedMotion
        damagedJoint="knee_L"
        onAnchorChange={(x) => anchors.push(x)}
      />,
    );
    frame(1000);

    const dial = screen.getByRole("slider", { name: "Model turntable" });
    expect(dial).toHaveAttribute("aria-valuenow", "0");

    fireEvent.keyDown(dial, { key: "ArrowRight" });
    frame(1100);
    expect(dial).toHaveAttribute("aria-valuenow", "15");
    expect(anchors.length).toBeGreaterThan(1);

    // Left from 0 wraps to 345, not -15: the dial is a circle.
    fireEvent.keyDown(dial, { key: "ArrowLeft" });
    fireEvent.keyDown(dial, { key: "ArrowLeft" });
    frame(1200);
    expect(dial).toHaveAttribute("aria-valuenow", "345");
  });

  it("returns exactly to the front elevation on Home", () => {
    recorder = recordingContext();
    const anchors: number[] = [];
    render(
      <WireframeElevation
        data={MODEL}
        reducedMotion
        damagedJoint="knee_L"
        onAnchorChange={(x) => anchors.push(x)}
      />,
    );
    frame(1000);
    const front = anchors[0]!;

    const dial = screen.getByRole("slider", { name: "Model turntable" });
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    frame(1100);
    expect(anchors[anchors.length - 1]).not.toBe(front);

    fireEvent.keyDown(dial, { key: "Home" });
    frame(1200);
    expect(dial).toHaveAttribute("aria-valuenow", "0");
    expect(anchors[anchors.length - 1]).toBeCloseTo(front, 5);
  });
});

describe("StatusBoard elevation slot", () => {
  it("swaps the SVG elevation for the model wireframe once the JSON lands", async () => {
    const fetchMock = ok(RAW);
    vi.stubGlobal("fetch", fetchMock);
    recorder = recordingContext();

    render(<StatusBoard />);
    // Before the fetch resolves the slot is the hand-drawn elevation.
    expect(screen.getByRole("img", { name: /unit elevation$/i })).toBeInTheDocument();
    expect(screen.getByText("Front elev.")).toBeInTheDocument();

    await settle();

    expect(fetchMock).toHaveBeenCalledWith(WIREFRAME_URL, { cache: "no-cache" });
    expect(
      screen.getByRole("img", { name: /elevation from the chassis model/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Live model elev.")).toBeInTheDocument();
    expect(screen.queryByText("Front elev.")).not.toBeInTheDocument();
  });

  it("keeps the SVG elevation when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    toFlag();

    render(<StatusBoard />);
    await settle();

    expect(screen.getByText("Front elev.")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="wireframe-elevation"]')).toBeNull();
    // And the board still names the damage: the fallback is a whole drawing,
    // not a degraded one.
    expect(
      screen.getByRole("img", { name: /knee L marked damaged/i }),
    ).toBeInTheDocument();
  });

  it("keeps the SVG elevation when the JSON is malformed", async () => {
    // A truncated or re-extracted-wrong document is the same failure as a dead
    // network: parseWireframe throws, and the board never sees it.
    vi.stubGlobal("fetch", ok(JSON.stringify({ v: 1, nodes: [] })));

    render(<StatusBoard />);
    await settle();

    expect(screen.getByText("Front elev.")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="wireframe-elevation"]')).toBeNull();
  });

  it("fetches the model once per page, however often the board remounts", async () => {
    const fetchMock = ok(RAW);
    vi.stubGlobal("fetch", fetchMock);

    const first = render(<StatusBoard />);
    await settle();
    first.unmount();

    // A mid-scan reload reconstructs the board; the parsed model is already in
    // hand, so the wireframe is up on the first render with no flash of SVG.
    render(<StatusBoard />);
    expect(screen.getByText("Live model elev.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("comes back from a mid-scan reload with the flag already applied", async () => {
    vi.stubGlobal("fetch", ok(RAW));
    await loadWireframe();
    toFlag();
    const rec = recordingContext();
    recorder = rec;

    render(<StatusBoard />);
    frame(1000);

    // The full ladder on the very first frame, and the knee in alert on top of
    // it: a board rebuilt mid-scan comes back already saying what broke.
    expect(rec.passes.length).toBeGreaterThanOrEqual(3);
    const last = rec.passes[rec.passes.length - 1]!;
    expect(last.segments).toBe(MODEL.byName.get("knee_actuator_L")!.edgeCount);
    expect(last.style).not.toBe(rec.passes[0]!.style);
  });

  /**
   * The board's own wiring: one predicate decides the manifest stamp, the
   * spoken summary and the drawing's stroke, so the inventory, the screen
   * reader and the picture cannot end up telling three stories about one joint.
   */
  it("retones the model elevation once the re-measure clears the channel", async () => {
    vi.stubGlobal("fetch", ok(RAW));
    await loadWireframe();
    toCleared();
    const rec = recordingContext();
    recorder = rec;

    render(<StatusBoard />);
    frame(1000);

    const subject = subjectPass(rec.passes)!;
    expect(subject).toBeDefined();
    expect(subject.style).toBe(NOMINAL_STYLE);
    expect(rec.passes.some((p) => p.style === ALERT_STYLE)).toBe(false);
    expect(screen.getByRole("img")).toHaveAccessibleName(/knee L marked restored/i);
    // The stamp it has to agree with.
    expect(screen.getByText("KNEE_L").closest("[data-state]")).toHaveAttribute(
      "data-state",
      "restored",
    );
  });

  it("leaves the model elevation red while the correction is only partial", async () => {
    vi.stubGlobal("fetch", ok(RAW));
    await loadWireframe();
    toFlag();
    const rec = recordingContext();
    recorder = rec;

    render(<StatusBoard />);
    frame(1000);

    expect(subjectPass(rec.passes)!.style).toBe(ALERT_STYLE);
    expect(screen.getByRole("img")).toHaveAccessibleName(/knee L marked damaged/i);
  });

  it("retones the SVG fallback too, so the two drawings never disagree", () => {
    // No model on hand: the slot holds the hand-drawn elevation, which colours
    // the same limb from the same fact.
    toCleared();
    render(<StatusBoard />);

    expect(screen.getByText("Front elev.")).toBeInTheDocument();
    const svg = screen.getByRole("img");
    expect(svg).toHaveAccessibleName(/knee L marked restored/i);
    // The annotation frame and the hatch it is filled with, both off --nominal.
    const frameRect = svg.querySelector("[data-damage-mark] rect");
    expect(frameRect).toHaveAttribute("stroke", "var(--nominal)");
    expect(svg.querySelector("pattern line")).toHaveAttribute("stroke", "var(--nominal)");
  });

  it("keeps the SVG fallback's mark in alert while the fault stands", () => {
    toFlag();
    render(<StatusBoard />);
    const svg = screen.getByRole("img");
    expect(svg).toHaveAccessibleName(/knee L marked damaged/i);
    expect(svg.querySelector("[data-damage-mark] rect")).toHaveAttribute(
      "stroke",
      "var(--alert)",
    );
  });
});
