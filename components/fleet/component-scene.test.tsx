import * as React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPONENT_ORDER } from "./component-spec";
import { frameSubscriberCount } from "@/components/console";

/**
 * The scene's two disciplines, tested without a GPU.
 *
 * WebGL does not exist in jsdom and does not need to: what has to hold about
 * this component is not what it draws but *when it is allowed to draw at all*
 * (frameloop="demand", the shared clock, zero cost while idle — docs/perf.md's
 * receipts) and *which gestures it is allowed to hear* (a tap that halts a
 * coasting turntable is spent halting it, iOS-fashion, and never doubles as a
 * selection). Both are pointer-handler and scheduler behaviour, so R3F is
 * mocked down to a passthrough and the handlers are exercised as the DOM
 * events they really are, with the timestamps the maths really reads.
 */

vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="r3f-canvas">{children}</div>
  ),
  invalidate: vi.fn(),
  useThree: (selector: (s: { camera: unknown }) => unknown) =>
    selector({
      camera: { lookAt: () => {}, updateProjectionMatrix: () => {} },
    }),
}));

vi.mock("@react-three/drei", () => ({
  useGLTF: Object.assign(() => ({ scene: chassisFixture() }), {
    preload: () => {},
  }),
}));

import { invalidate } from "@react-three/fiber";
import { ComponentScene, type ComponentSceneProps } from "./component-scene";

const invalidateMock = vi.mocked(invalidate);

/** Eight named parts, the shape buildChassis expects of the GLB. Built once:
    the scene prop is a stable identity, exactly like a cached glTF. */
let fixture: THREE.Group | null = null;
function chassisFixture(): THREE.Group {
  if (fixture) return fixture;
  fixture = new THREE.Group();
  for (const id of COMPONENT_ORDER) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.2, 0.2),
      new THREE.MeshStandardMaterial(),
    );
    mesh.name = id;
    fixture.add(mesh);
  }
  return fixture;
}

/* -- scaffolding: hand-cranked frames, pointer events with real timestamps -- */

let queue = new Map<number, FrameRequestCallback>();

/** Run whatever the shared loop has scheduled, once, at `now`. */
function frame(now: number): void {
  const due = [...queue.values()];
  queue.clear();
  for (const cb of due) cb(now);
}

beforeEach(() => {
  let handle = 0;
  queue = new Map();
  // The R3F intrinsics (<group>, <primitive>, lights) render as unknown DOM
  // tags under the mocked Canvas, which is the point — but react-dom announces
  // each one. Swallow exactly that chatter and let real errors through.
  const realError = console.error.bind(console);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (
      first.includes("is using incorrect casing") ||
      first.includes("is unrecognized in this browser") ||
      first.includes("does not recognize the") ||
      first.includes("non-boolean attribute")
    ) {
      return;
    }
    realError(...args);
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    handle += 1;
    queue.set(handle, cb);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (h: number) => {
    queue.delete(h);
  });
  // jsdom has no pointer capture; the handlers call all three.
  for (const method of ["setPointerCapture", "releasePointerCapture"] as const) {
    if (!HTMLElement.prototype[method]) {
      Object.defineProperty(HTMLElement.prototype, method, {
        configurable: true,
        value: () => {},
      });
    }
  }
  if (!HTMLElement.prototype.hasPointerCapture) {
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: () => false,
    });
  }
  invalidateMock.mockClear();
});

afterEach(() => {
  // Unmount before asserting: the setup file's cleanup would run after this
  // hook, and the receipt is that nothing survives on the loop.
  cleanup();
  expect(frameSubscriberCount()).toBe(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A pointer event whose timestamp and identity the test controls. Built on
 * MouseEvent so it carries real client coordinates whether or not jsdom ships
 * a PointerEvent, with the pointer fields the handlers read defined on top.
 */
function pointer(
  type: string,
  init: { x: number; t: number; pointerType?: string; buttons?: number },
): MouseEvent {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x,
    clientY: 200,
    // A real dragging pointer has its button down through every move; an up
    // (or a stale post-release move, which tests pass explicitly) has 0.
    buttons: init.buttons ?? (type === "pointerup" ? 0 : 1),
  });
  Object.defineProperties(ev, {
    pointerId: { value: 1 },
    isPrimary: { value: true },
    pointerType: { value: init.pointerType ?? "mouse" },
    timeStamp: { value: init.t },
  });
  return ev;
}

function renderScene(overrides: Partial<ComponentSceneProps> = {}) {
  const onSelect = vi.fn();
  const props: ComponentSceneProps = {
    selected: null,
    hovered: null,
    highlight: null,
    onSelect,
    onHover: () => {},
    reducedMotion: false,
    visible: true,
    ...overrides,
  };
  const utils = render(<ComponentScene {...props} />);
  const host = utils.container.firstElementChild as HTMLElement;
  // Under the mocked Canvas, <group> lands in the DOM as an unknown element;
  // the yaw writes expect a THREE.Group's rotation, so give it one.
  const groupEl = utils.container.querySelector("group");
  if (groupEl) {
    Object.defineProperty(groupEl, "rotation", {
      configurable: true,
      value: { y: 0 },
    });
  }
  // Part meshes interleave with their outline shells, two <primitive>s per
  // part; the even indices are the parts, in COMPONENT_ORDER.
  const headMesh = utils.container.querySelectorAll("primitive")[0]!;
  return { ...utils, host, headMesh, onSelect };
}

/** A horizontal flick fast enough to leave the model coasting on release. */
function flick(host: HTMLElement): void {
  fireEvent(host, pointer("pointerdown", { x: 0, t: 1000 }));
  fireEvent(host, pointer("pointermove", { x: 60, t: 1016 }));
  fireEvent(host, pointer("pointermove", { x: 120, t: 1032 }));
  fireEvent(host, pointer("pointerup", { x: 150, t: 1048 }));
}

describe("stale pointers (deferred capture)", () => {
  it("ignores a trailing move that arrives after the button released", () => {
    const { host, container } = renderScene();
    const group = container.querySelector("group") as unknown as {
      rotation: { y: number };
    };
    fireEvent(host, pointer("pointerdown", { x: 0, t: 1000 }));
    fireEvent(host, pointer("pointermove", { x: 60, t: 1016 }));
    const yawAfterRealMove = group.rotation.y;
    // A move from a pointer that already let go: buttons is 0. It must not
    // turn the model or attempt capture (which would throw NotFoundError).
    fireEvent(host, pointer("pointermove", { x: 200, t: 1032, buttons: 0 }));
    expect(group.rotation.y).toBe(yawAfterRealMove);
  });

  it("survives capture on a pointer that deactivated mid-frame", () => {
    const { host, container } = renderScene();
    const group = container.querySelector("group") as unknown as {
      rotation: { y: number };
    };
    Object.defineProperty(host, "setPointerCapture", {
      configurable: true,
      value: () => {
        throw new DOMException(
          "Failed to execute 'setPointerCapture' on 'Element': No active pointer with the given id is found.",
          "NotFoundError",
        );
      },
    });
    fireEvent(host, pointer("pointerdown", { x: 0, t: 1000 }));
    // Past the slop with a held button, but capture throws (touch-cancel /
    // release racing the handler). The gesture must carry on regardless.
    expect(() =>
      fireEvent(host, pointer("pointermove", { x: 60, t: 1016 })),
    ).not.toThrow();
    expect(group.rotation.y).not.toBe(0);
  });
});

describe("tap-to-arrest (C7)", () => {
  it("spends the tap that halts a coast on halting it — no selection", () => {
    const { host, headMesh, onSelect } = renderScene();

    flick(host);

    // The model is coasting. A stationary tap lands on it...
    fireEvent(host, pointer("pointerdown", { x: 150, t: 1200 }));
    fireEvent(host, pointer("pointerup", { x: 150, t: 1210 }));
    // ...and the click the browser fires at the end of that tap raycasts to
    // whatever part was under the finger. It must not become a selection.
    fireEvent.click(headMesh);
    expect(onSelect).not.toHaveBeenCalled();

    // The model is now still. The next tap is an ordinary tap, and selects.
    fireEvent(host, pointer("pointerdown", { x: 150, t: 1400 }));
    fireEvent(host, pointer("pointerup", { x: 150, t: 1410 }));
    fireEvent.click(headMesh);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("head");
  });

  it("still declines the click that ends a drag", () => {
    const { host, headMesh, onSelect } = renderScene();
    flick(host);
    // The end-of-drag click lands wherever the pointer stopped.
    fireEvent.click(headMesh);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects on a plain tap when nothing was ever moving", () => {
    const { host, headMesh, onSelect } = renderScene({ reducedMotion: true });
    fireEvent(host, pointer("pointerdown", { x: 80, t: 1000 }));
    fireEvent(host, pointer("pointerup", { x: 80, t: 1010 }));
    fireEvent.click(headMesh);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("head");
  });
});

describe("the ambient clock (C8)", () => {
  it("rides the shared frame loop, never a private interval", () => {
    const setInterval = vi.spyOn(window, "setInterval");
    renderScene();
    // Spinning (visible, motion wanted, nobody interacting): exactly one
    // subscriber on the app's one loop, and no second scheduler anywhere.
    expect(frameSubscriberCount()).toBe(1);
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("steps yaw and invalidates at the 30 Hz gate, aligned to frame timestamps", () => {
    renderScene();
    invalidateMock.mockClear();

    const start = performance.now() + 100; // comfortably past the gate
    frame(start);
    expect(invalidateMock).toHaveBeenCalledTimes(1);

    // 10 ms later: under the gate — the frame costs one comparison, no draw.
    frame(start + 10);
    expect(invalidateMock).toHaveBeenCalledTimes(1);

    // 34 ms after the last step: the gate opens on the frame timestamp.
    frame(start + 34);
    expect(invalidateMock).toHaveBeenCalledTimes(2);
  });

  it("costs an off-screen viewer nothing: no subscriber, no invalidations", () => {
    renderScene({ visible: false });
    invalidateMock.mockClear();

    expect(frameSubscriberCount()).toBe(0);
    expect(queue.size).toBe(0);
    frame(performance.now() + 1000);
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("goes quiet while a part is selected and the pointer is elsewhere", () => {
    renderScene({ selected: "torso" });
    expect(frameSubscriberCount()).toBe(0);
  });
});
