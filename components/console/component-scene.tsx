"use client";

import * as React from "react";
import { Canvas, invalidate, useThree, type ThreeEvent } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import {
  blendVelocity,
  pushSample,
  trailVelocity,
  type PointerSample,
} from "@/lib/motion";
import { readToken } from "@/lib/tokens/fallback";
import { registerFrame } from "./frame-loop";
import {
  CHASSIS_MODEL_URL,
  COMPONENT_ORDER,
  emissiveIntensity,
  highlightNeedsFrames,
  type ComponentHighlight,
  type ComponentId,
} from "./component-spec";

/**
 * The 3D component view — and the only module in the app that imports three.js.
 *
 * It is reached exclusively through the `next/dynamic` boundary in
 * component-view.tsx, which is why nothing in components/console/index.ts names
 * it: the barrel travels with the unit page's initial JS, and anything the
 * barrel names travels with it (PRD §7 — "three.js loads only on the component
 * view"). Import this file from anywhere else and that guarantee is gone.
 *
 * **Product turntable, not an engine viewport.** No skybox, no grid, no axis
 * helper, no zoom, no pan, no free tumble. One slow yaw, one horizontal drag to
 * take it over, and a warm key light from the same direction the token shadows
 * fall from. The renderer is deliberately `flat` (no ACES tone mapping): the
 * shell colour in the GLB is a token colour, and a filmic curve would quietly
 * repaint it.
 *
 * **Zero frames when nothing is happening.** `frameloop="demand"` means React
 * Three Fiber renders when it is asked to and never on a schedule. It is asked
 * to by exactly four things: a React update that touches the scene, a drag, a
 * pulse tick, and an orbit tick — and the orbit and pulse tickers only exist
 * while the section is on screen and motion is wanted. A viewer sitting idle,
 * or scrolled past, costs the page nothing at all, which is the only way a
 * garnish is allowed to share a page with eighteen live telemetry canvases.
 */

/* ---------------------------------------------------------------------------
   Framing and motion constants
--------------------------------------------------------------------------- */

/**
 * The GLB stands 1.668 m tall on y=0. A 30° lens at 3.9 m frames it at ~80% of
 * the viewport height, and the eye sits a little above the chest — high enough
 * that the ground the shadow falls on reads as ground, level enough that the
 * figure is not being looked down on.
 */
const CAMERA_POSITION: [number, number, number] = [0, 1.22, 3.85];
const CAMERA_TARGET: [number, number, number] = [0, 0.82, 0];
const CAMERA_FOV = 30;

/** ~4.6°/s: a full turn takes 78 seconds. Slower than you notice starting. */
const YAW_RATE = 0.08;
/**
 * ~30 Hz: the minimum elapsed time between ambient ticks on the shared frame
 * loop. Under it the tick waits for the next display frame, so it fires every
 * 4th frame at 120 Hz and every 2nd at 60 — vsync-aligned by construction.
 * The yaw step at this cadence is 0.15°, well under a perceptible jump.
 */
const TICK_MS = 33;
/** Drag past this many pixels and the gesture stops being a click. */
const CLICK_SLOP_PX = 4;
/** Radians of yaw per pixel dragged — a full turn is about 900 px. */
const DRAG_SENSITIVITY = 0.007;
/**
 * Below this the spin has stopped being a spin: a quarter of the ambient rate,
 * which at 78 seconds a turn is about a degree per second. Handing back to the
 * 30 Hz ticker here is invisible, and waiting for a true zero would keep the
 * frame loop alive for another second of frames nobody can see.
 */
const SPIN_FLOOR = YAW_RATE / 4;

/** Barely there: a hovered part lifts, it does not light up. */
const HOVER_EMISSIVE = 0.055;
const SELECTED_EMISSIVE = 0.04;

/**
 * How far a selected part's shell pulls toward the ink, 0–1.
 *
 * The outline shell below carries selection where a part has a free silhouette
 * — a knee actuator, a head, an arm. It cannot carry it on the torso, which is
 * hemmed in by both arms and both legs and has almost no visible rim to draw.
 * So selection is *also* a tonal step: the part reads picked-out the way a
 * region is picked out in a parts diagram, with no colour and no glow, and it
 * reads that way regardless of what is standing in front of it.
 */
const SELECT_TINT = 0.24;

/**
 * How far the selection outline stands off the part it traces, in metres.
 *
 * The chassis is built from capsules and spheres and has almost no hard
 * creases, so an `EdgesGeometry` outline finds nothing to draw on it. What
 * works on smooth geometry is the old back-face shell: a slightly inflated
 * copy of the part rendered inside-out, which shows only where it overhangs
 * the original — a rim. Sizing the inflation per part (rather than scaling
 * every part by the same factor) is what keeps the rim the same weight on the
 * torso as on a knee actuator a fifth its size.
 *
 * 10 mm on a 1.67 m figure framed at ~500 px is about 3 px — heavy enough to
 * survive the shading it traces, light enough to stay a drawn line rather than
 * a glow.
 */
const OUTLINE_OFFSET_M = 0.01;

/* ---------------------------------------------------------------------------
   Tokens
--------------------------------------------------------------------------- */

/**
 * three.js cannot read a CSS custom property, and this component is not allowed
 * to hardcode a colour (CLAUDE.md non-negotiable #1). So the palette is read
 * off the live cascade once, from the element the canvas is mounted in, and
 * handed to the scene as plain hex. Only layer-1 primitives are read — those
 * are literal hex in the token layer; the semantic slots are `color-mix()`
 * expressions that would come back unresolved. Off the cascade (jsdom) the
 * shared fallbacks stand in (lib/tokens/fallback.ts).
 */
interface SceneTokens {
  ink: string;
  soft: string;
  light: string;
  ground: string;
  warn: string;
  alert: string;
}

function readTokens(el: HTMLElement): SceneTokens {
  const cs = getComputedStyle(el);
  return {
    ink: readToken(cs, "--charcoal", "operator"),
    soft: readToken(cs, "--stone", "operator"),
    light: readToken(cs, "--warm-white", "operator"),
    ground: readToken(cs, "--greige-deep", "operator"),
    warn: readToken(cs, "--amber", "operator"),
    alert: readToken(cs, "--clay", "operator"),
  };
}

/* ---------------------------------------------------------------------------
   Model
--------------------------------------------------------------------------- */

useGLTF.preload(CHASSIS_MODEL_URL);

interface Part {
  object: THREE.Object3D;
  materials: THREE.MeshStandardMaterial[];
  /** The inflated back-face copy that draws this part's selection rim. */
  outline: THREE.Group;
}

interface Chassis {
  parts: Record<ComponentId, Part>;
  outlineMaterial: THREE.MeshBasicMaterial;
}

/**
 * Split the loaded scene into eight independently lightable, outlinable parts.
 *
 * Two things happen here and nowhere else. The GLB shares one `shell` material
 * across six nodes, so every material is cloned per part — otherwise hovering
 * an arm would light the whole chassis. And every part's outline shell is
 * built up front and simply toggled, so selecting is a `visible = true` rather
 * than a geometry build in the middle of an interaction.
 */
function buildChassis(source: THREE.Object3D, ink: string): Chassis {
  const root = source.clone(true);
  const parts = {} as Record<ComponentId, Part>;

  const outlineMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(ink),
    // Inside-out, so the copy is invisible except where it overhangs the part.
    side: THREE.BackSide,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    toneMapped: false,
  });

  for (const id of COMPONENT_ORDER) {
    const object = root.getObjectByName(id);
    if (!object) continue;

    const materials: THREE.MeshStandardMaterial[] = [];
    const outline = new THREE.Group();
    outline.position.copy(object.position);
    outline.quaternion.copy(object.quaternion);
    outline.scale.copy(object.scale);
    outline.visible = false;

    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const material = (child.material as THREE.MeshStandardMaterial).clone();
      // The GLB ships matte on purpose; emissive and a small tonal shift are
      // the only channels this viewer ever touches, so emissive starts black
      // at zero and the shipped colour is kept to restore from.
      material.emissive = new THREE.Color("#000000");
      material.emissiveIntensity = 0;
      material.userData.baseColor = material.color.clone();
      child.material = material;
      materials.push(material);
      outline.add(outlineShell(child, object, outlineMaterial));
    });

    parts[id] = { object, materials, outline };
  }

  return { parts, outlineMaterial };
}

/**
 * One mesh's outline copy: the same geometry, inflated about its own bounding
 * centre by a fixed number of millimetres.
 *
 * Scaling about the *node* origin instead would put the rim a hair thick at a
 * shoulder and three pixels thick at the hand, because a limb's geometry runs
 * away from its joint pivot. Scaling about the bounding centre, by an amount
 * computed from the bounding radius, gives every part the same rim.
 */
function outlineShell(
  mesh: THREE.Mesh,
  part: THREE.Object3D,
  material: THREE.Material,
): THREE.Mesh {
  const geometry = mesh.geometry;
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  const radius = Math.max(sphere?.radius ?? 1, 0.02);
  const centre = sphere?.center ?? new THREE.Vector3();
  const scale = 1 + OUTLINE_OFFSET_M / radius;

  const shell = new THREE.Mesh(geometry, material);
  shell.renderOrder = 2;
  shell.matrixAutoUpdate = false;
  // T(centre · (1 − s)) · S(s) scales about `centre`; composed under the mesh's
  // position *within its part*, which is identity when the part is itself a
  // single mesh and the primitive's own transform when it is not.
  shell.matrix
    .copy(matrixWithin(mesh, part))
    .multiply(
      new THREE.Matrix4()
        .makeTranslation(
          centre.x * (1 - scale),
          centre.y * (1 - scale),
          centre.z * (1 - scale),
        )
        .multiply(new THREE.Matrix4().makeScale(scale, scale, scale)),
    );
  return shell;
}

/**
 * A descendant's transform expressed in an ancestor's space — identity when
 * the two are the same object, which is the case for the six parts that are a
 * single glTF primitive and therefore *are* their own mesh. Getting this wrong
 * applies a part's translation twice and parks its outline in mid-air.
 */
function matrixWithin(child: THREE.Object3D, ancestor: THREE.Object3D): THREE.Matrix4 {
  const out = new THREE.Matrix4();
  let node: THREE.Object3D | null = child;
  while (node && node !== ancestor) {
    node.updateMatrix();
    out.premultiply(node.matrix);
    node = node.parent;
  }
  return out;
}

function disposeChassis(chassis: Chassis): void {
  for (const part of Object.values(chassis.parts)) {
    for (const material of part.materials) material.dispose();
  }
  chassis.outlineMaterial.dispose();
}

/* ---------------------------------------------------------------------------
   The scene
--------------------------------------------------------------------------- */

export interface ComponentSceneProps {
  selected: ComponentId | null;
  hovered: ComponentId | null;
  highlight: ComponentHighlight | null;
  /** Null clears the selection — clicking the selected part again deselects. */
  onSelect: (id: ComponentId | null) => void;
  onHover: (id: ComponentId | null) => void;
  /** Fires once, when the GLB is in the scene and the first frame is drawable. */
  onReady?: () => void;
  reducedMotion: boolean;
  /** False when the section is scrolled out of view: the orbit stops entirely. */
  visible: boolean;
  className?: string;
}

export function ComponentScene({
  selected,
  hovered,
  highlight,
  onSelect,
  onHover,
  onReady,
  reducedMotion,
  visible,
  className,
}: ComponentSceneProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [tokens, setTokens] = React.useState<SceneTokens | null>(null);

  React.useLayoutEffect(() => {
    if (hostRef.current) setTokens(readTokens(hostRef.current));
  }, []);

  /* -- pointer: horizontal drag spins, a short press selects ---------------- */
  const yawRef = React.useRef(0);
  const groupRef = React.useRef<THREE.Group>(null);
  const dragRef = React.useRef<{
    id: number;
    x: number;
    travel: number;
    /** Recent pointer positions, for the velocity the release is thrown with. */
    trail: PointerSample[];
  } | null>(null);
  /**
   * The throw, coasting. Non-null only between a release and the moment the
   * spin rejoins whatever the turntable would have been doing anyway.
   */
  const coastRef = React.useRef<{ velocity: number; ambient: number } | null>(null);
  /**
   * Set the moment a drag passes the slop threshold and cleared on the next
   * pointer down. The click that a browser fires at the end of every drag reads
   * this and declines to be a selection.
   */
  const draggedRef = React.useRef(false);
  /**
   * True for the whole gesture that began by catching a coasting model. The
   * iOS convention for every momentum surface: a tap that halts a moving thing
   * is spent halting it, and never also counts as a hit on whatever happened
   * to be under the finger. Latched on pointer down — before the coast is
   * cleared, which is the only moment the fact is still knowable — and, like
   * draggedRef, replaced at the start of the next gesture rather than on
   * pointer up, because the click a gesture ends with fires *after* its
   * pointerup and must still see the latch. The accessible button rail never
   * consults it: a list of buttons has no momentum to arrest.
   */
  const arrestedRef = React.useRef(false);
  const [pointerHeld, setPointerHeld] = React.useState(false);
  const [pointerInside, setPointerInside] = React.useState(false);
  /**
   * State rather than a ref, and only because `spinning` has to see it: the
   * ambient ticker and the coast would otherwise both be adding yaw to the same
   * number. Two renders per throw, at the two moments the model changes hands.
   */
  const [coasting, setCoasting] = React.useState(false);

  const applyYaw = React.useCallback((next: number) => {
    yawRef.current = next;
    if (groupRef.current) groupRef.current.rotation.y = next;
    invalidate();
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    draggedRef.current = false;
    // Catching a coasting model stops it dead under the finger, at the yaw it
    // had reached. Letting the decay keep running while a hand is on it is the
    // same brick wall as a sheet that keeps closing while you hold it. A tap
    // that does this arresting is spent: the latch keeps its click from also
    // selecting the part it happened to land on.
    arrestedRef.current = coastRef.current !== null;
    coastRef.current = null;
    dragRef.current = { id: e.pointerId, x: e.clientX, travel: 0, trail: [] };
    pushSample(dragRef.current.trail, { t: e.timeStamp, v: e.clientX });
    setPointerHeld(true);
    // Deliberately NOT capturing yet. A captured pointer sends its `click` to
    // the capture element, which is this div — above the canvas React Three
    // Fiber listens on — so capturing on press means no click ever reaches a
    // mesh and nothing on the model can be selected by pointing at it.
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    if (e.buttons === 0 && e.pointerType !== "touch") {
      // A trailing move from a pointer that already released — the up handler
      // has run (or is about to) and this sample is stale. Acting on it would
      // nudge the yaw after release; capturing on it throws NotFoundError.
      return;
    }
    const dx = e.clientX - drag.x;
    drag.travel += Math.abs(dx);
    drag.x = e.clientX;
    pushSample(drag.trail, { t: e.timeStamp, v: e.clientX });
    if (drag.travel > CLICK_SLOP_PX && !draggedRef.current) {
      draggedRef.current = true;
      // Past the slop it is unambiguously a drag, so take the pointer now:
      // the gesture should keep turning the model when it wanders off the
      // canvas, and the click it ends with should land here and go nowhere.
      // Guarded: between this event being queued and handled the pointer can
      // deactivate (release/cancel mid-frame); capture is then impossible and
      // unnecessary — the gesture is ending anyway.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // NotFoundError: pointer no longer active. Nothing to hold.
      }
    }
    applyYaw(yawRef.current + dx * DRAG_SENSITIVITY);
  };

  /**
   * Let go, and the model keeps turning.
   *
   * The velocity the finger had, converted from pixels a second into radians a
   * second by the same sensitivity the drag used, then decayed toward whatever
   * the turntable would be doing without a hand on it — the ambient yaw if the
   * pointer has left, a standstill if it is still hovering or a part is selected
   * (`spinning`'s conditions, restated here because the coast has to know its
   * own destination). One exponential covers both endings, so there is never a
   * moment where the spin is cut from one number to another.
   */
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.travel > CLICK_SLOP_PX) {
      pushSample(drag.trail, { t: e.timeStamp, v: e.clientX });
      const velocity = trailVelocity(drag.trail) * DRAG_SENSITIVITY;
      // `pointerInside` is stale for a touch release — the pointer ceases to
      // exist, and the leave that clears it has not run yet — so a coarse
      // pointer is treated as gone, which is what it is.
      const hovering = e.pointerType === "mouse" && pointerInside;
      const ambient = hovering || selected !== null ? 0 : YAW_RATE;
      // Reduced motion gets no coast at all: the model stops where the finger
      // left it. A throw is motion the user asked for, but a second of decaying
      // rotation after their hand is off the glass is motion that continues
      // without them, which is exactly what the setting is about.
      if (!reducedMotion && Math.abs(velocity - ambient) > SPIN_FLOOR) {
        coastRef.current = { velocity, ambient };
        setCoasting(true);
      }
    }
    dragRef.current = null;
    setPointerHeld(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  /**
   * The coast: the throw decaying into whatever the turntable would be doing
   * anyway.
   *
   * It runs on the app's one shared frame loop rather than a second rAF, and it
   * only exists between a release and the moment the two velocities meet — so
   * `frameloop="demand"` keeps its promise: frames are invalidated while the
   * model is genuinely moving and not once after it settles. A grab mid-coast
   * clears the ref, and the next frame notices and hands the model over.
   */
  React.useEffect(() => {
    if (!coasting) return;
    if (!visible) {
      coastRef.current = null;
      setCoasting(false);
      return;
    }
    const start = performance.now();
    let last = start;
    let stop = () => {};
    const end = () => {
      coastRef.current = null;
      stop();
      setCoasting(false);
    };
    stop = registerFrame((now) => {
      const coast = coastRef.current;
      if (!coast) {
        end();
        return;
      }
      const velocity = blendVelocity(coast.velocity, coast.ambient, now - start);
      yawRef.current += ((now - last) / 1000) * velocity;
      last = now;
      if (groupRef.current) groupRef.current.rotation.y = yawRef.current;
      invalidate();
      if (Math.abs(velocity - coast.ambient) <= SPIN_FLOOR) end();
    });
    return () => stop();
  }, [coasting, visible]);

  /* -- when frames are owed -------------------------------------------------
     Spinning: on screen, motion wanted, and nobody is looking closely — a
     turntable that keeps turning while you are trying to click a knee, or while
     you are reading the part you just selected, is a turntable fighting its
     operator. The coast owns the model while it lasts and hands it back here. */
  const spinning =
    visible &&
    !reducedMotion &&
    !pointerInside &&
    !pointerHeld &&
    !coasting &&
    selected === null;
  const pulsing = visible && highlightNeedsFrames(highlight, reducedMotion);

  return (
    <div
      ref={hostRef}
      className={className}
      // pan-y keeps a vertical swipe scrolling the page; horizontal comes here.
      style={{ touchAction: "pan-y", cursor: hovered ? "pointer" : "default" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => {
        setPointerInside(false);
        onHover(null);
      }}
    >
      {tokens ? (
        <Canvas
          frameloop="demand"
          dpr={[1, 2]}
          flat
          shadows="variance"
          gl={{ antialias: true, alpha: true }}
          camera={{ position: CAMERA_POSITION, fov: CAMERA_FOV, near: 0.5, far: 20 }}
          // The canvas itself is not the interactive element — the section
          // around it is, and it carries the label and the keyboard handling.
          aria-hidden
          tabIndex={-1}
        >
          <SceneBody
            tokens={tokens}
            groupRef={groupRef}
            yawRef={yawRef}
            draggedRef={draggedRef}
            arrestedRef={arrestedRef}
            selected={selected}
            hovered={hovered}
            highlight={highlight}
            onSelect={onSelect}
            onHover={onHover}
            onReady={onReady}
            reducedMotion={reducedMotion}
            spinning={spinning}
            pulsing={pulsing}
            yawRate={YAW_RATE}
          />
        </Canvas>
      ) : null}
    </div>
  );
}

interface SceneBodyProps {
  tokens: SceneTokens;
  groupRef: React.RefObject<THREE.Group | null>;
  yawRef: React.RefObject<number>;
  draggedRef: React.RefObject<boolean>;
  arrestedRef: React.RefObject<boolean>;
  selected: ComponentId | null;
  hovered: ComponentId | null;
  highlight: ComponentHighlight | null;
  onSelect: (id: ComponentId | null) => void;
  onHover: (id: ComponentId | null) => void;
  onReady?: () => void;
  reducedMotion: boolean;
  spinning: boolean;
  pulsing: boolean;
  yawRate: number;
}

function SceneBody(props: SceneBodyProps) {
  const { tokens } = props;

  return (
    <>
      <CameraAim />

      {/*
        Operator space, lit like a room and not like a showroom: one warm key
        from above and slightly to the left — the direction --elev-raised
        already implies — plus a low fill so the shadow side stays readable, and
        a hemisphere that bounces greige up off a floor nobody can see. No
        environment map: a reflection of a studio nobody built is exactly the
        glossy tech-demo look this section is not allowed to have.
      */}
      <hemisphereLight args={[tokens.light, tokens.ground, 0.72]} />
      <directionalLight
        position={[1.5, 6.2, 2.4]}
        intensity={1.55}
        color={tokens.light}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-radius={4}
        shadow-blurSamples={12}
        shadow-bias={-0.0006}
        shadow-normalBias={0.02}
        shadow-camera-near={1}
        shadow-camera-far={12}
        shadow-camera-left={-1.4}
        shadow-camera-right={1.4}
        shadow-camera-top={2.4}
        shadow-camera-bottom={-0.4}
      />
      <directionalLight
        position={[-3.2, 1.6, 1.8]}
        intensity={0.44}
        color={tokens.light}
      />
      <directionalLight
        position={[-0.8, 2.2, -3.4]}
        intensity={0.22}
        color={tokens.ground}
      />

      {/*
        No floor — just the shadow the floor would have caught. ShadowMaterial
        draws nothing except where light is blocked, so the figure is grounded
        without a plane, a grid or a horizon appearing anywhere.
      */}
      <mesh receiveShadow rotation-x={-Math.PI / 2} position-y={0.001}>
        <planeGeometry args={[8, 8]} />
        <shadowMaterial
          transparent
          depthWrite={false}
          opacity={0.17}
          color={tokens.ink}
        />
      </mesh>

      <React.Suspense fallback={null}>
        <Chassis {...props} />
      </React.Suspense>
    </>
  );
}

/** Point the default camera at the chest once; nothing here moves it again. */
function CameraAim() {
  const camera = useThree((s) => s.camera);
  React.useLayoutEffect(() => {
    camera.lookAt(...CAMERA_TARGET);
    camera.updateProjectionMatrix();
  }, [camera]);
  return null;
}

function Chassis({
  tokens,
  groupRef,
  yawRef,
  draggedRef,
  arrestedRef,
  selected,
  hovered,
  highlight,
  onSelect,
  onHover,
  onReady,
  reducedMotion,
  spinning,
  pulsing,
  yawRate,
}: SceneBodyProps) {
  const { scene } = useGLTF(CHASSIS_MODEL_URL);
  const chassis = React.useMemo(
    () => buildChassis(scene, tokens.ink),
    [scene, tokens.ink],
  );
  const parts = chassis.parts;
  React.useEffect(() => () => disposeChassis(chassis), [chassis]);

  React.useEffect(() => {
    onReady?.();
  }, [onReady]);

  /* -- emissive and outline -------------------------------------------------
     Written straight onto the cloned materials rather than through React
     props: the pulse updates thirty times a second and must never touch the
     React tree, and the resting state is the same write with a fixed number. */
  const tint = React.useMemo(() => new THREE.Color(tokens.soft), [tokens.soft]);

  const paint = React.useCallback(
    (elapsedMs: number) => {
      for (const id of COMPONENT_ORDER) {
        const part = parts[id];
        if (!part) continue;
        const isSelected = selected === id;
        part.outline.visible = isSelected;
        let color = "#000000";
        let intensity = 0;
        if (highlight?.id === id) {
          color = highlight.tone === "alert" ? tokens.alert : tokens.warn;
          intensity = emissiveIntensity(highlight.mode, elapsedMs, reducedMotion);
        } else if (hovered === id) {
          color = tokens.soft;
          intensity = HOVER_EMISSIVE;
        } else if (isSelected) {
          color = tokens.soft;
          intensity = SELECTED_EMISSIVE;
        }
        for (const material of part.materials) {
          material.emissive.set(color);
          material.emissiveIntensity = intensity;
          const base = material.userData.baseColor as THREE.Color | undefined;
          if (base) {
            material.color.copy(base);
            if (isSelected) material.color.lerp(tint, SELECT_TINT);
          }
        }
      }
    },
    [parts, highlight, hovered, selected, tokens, tint, reducedMotion],
  );

  // Resting repaint on every state change, plus the invalidate that turns it
  // into a frame — demand mode draws nothing unless something asks.
  React.useEffect(() => {
    paint(performance.now());
    invalidate();
  }, [paint]);

  /* -- the ambient clock ----------------------------------------------------
     The orbit and the pulse tick at ~30 Hz — invalidate() cadence is the whole
     cost of a demand-frameloop scene, and 30 Hz is plenty for a 4.6°/s yaw and
     a 2.6 s breath — but the *scheduler* is the app's one shared rAF loop,
     gated by elapsed time, not a private setInterval. An interval fires on its
     own clock: 33 ms is 3.96 display frames at 120 Hz, so the yaw a frame
     showed was computed anywhere from 0 to 8 ms before vsync, drifting each
     tick — a constant slow rotation with a periodic hitch in it. Gating on rAF
     timestamps snaps `last` to vsync, so every step lands a whole number of
     display frames apart (4 at 120 Hz, 2 at 60) and the rotation advances
     evenly. Nothing is lost to the coarse steps: yaw is linear in time, so the
     accumulation is exact at any step size, and the pulse samples its absolute
     phase. (A background tab is also handled for free — rAF parks, where the
     interval kept invalidating a page nobody could see.)

     The subscription keeps exactly the gates the interval had — `spinning` and
     `pulsing` already fold in visibility, occlusion and reduced motion — and
     frame-loop.ts stops itself with its last subscriber, so an idle or
     scrolled-past viewer still costs zero frames (docs/perf.md's receipt). */
  React.useEffect(() => {
    if (!spinning && !pulsing) return;
    let last = performance.now();
    return registerFrame((now) => {
      if (now - last < TICK_MS) return;
      if (spinning) {
        yawRef.current += ((now - last) / 1000) * yawRate;
        if (groupRef.current) groupRef.current.rotation.y = yawRef.current;
      }
      last = now;
      if (pulsing) paint(now);
      invalidate();
    });
  }, [spinning, pulsing, paint, yawRate, yawRef, groupRef]);

  const select = (id: ComponentId) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    // The click a browser fires at the end of a drag is not a selection, and
    // neither is the tap that stopped a coasting turntable — that tap was
    // spent arresting the spin (see arrestedRef).
    if (draggedRef.current || arrestedRef.current) return;
    onSelect(selected === id ? null : id);
  };

  return (
    <group ref={groupRef} rotation-y={yawRef.current}>
      {COMPONENT_ORDER.map((id) => {
        const part = parts[id];
        if (!part) return null;
        return (
          <React.Fragment key={id}>
            <primitive
              object={part.object}
              onClick={select(id)}
              onPointerOver={(e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation();
                onHover(id);
              }}
              onPointerOut={(e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation();
                onHover(null);
              }}
            />
            {/* Sibling rather than child, and always mounted: it carries no
                event handlers, so R3F never raycasts it, and toggling
                `visible` in paint() keeps selection out of the render path. */}
            <primitive object={part.outline} />
          </React.Fragment>
        );
      })}
    </group>
  );
}
