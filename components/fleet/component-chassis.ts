"use client";

import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { readToken } from "@/lib/tokens/fallback";
import { CHASSIS_MODEL_URL, COMPONENT_ORDER, type ComponentId } from "./component-spec";

/**
 * The chassis, as three.js objects: reading the palette off the cascade,
 * building the mesh graph the scene renders, and taking it apart again.
 *
 * None of it is React and none of it renders — it is the bridge between a GLB
 * and a scene graph, which is why it sits beside `component-scene.tsx` rather
 * than inside it.
 */

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
export interface SceneTokens {
  ink: string;
  soft: string;
  light: string;
  ground: string;
  warn: string;
  alert: string;
}

export function readTokens(el: HTMLElement): SceneTokens {
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

export interface Part {
  object: THREE.Object3D;
  materials: THREE.MeshStandardMaterial[];
  /** The inflated back-face copy that draws this part's selection rim. */
  outline: THREE.Group;
}

export interface Chassis {
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
export function buildChassis(source: THREE.Object3D, ink: string): Chassis {
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
export function matrixWithin(
  child: THREE.Object3D,
  ancestor: THREE.Object3D,
): THREE.Matrix4 {
  const out = new THREE.Matrix4();
  let node: THREE.Object3D | null = child;
  while (node && node !== ancestor) {
    node.updateMatrix();
    out.premultiply(node.matrix);
    node = node.parent;
  }
  return out;
}

export function disposeChassis(chassis: Chassis): void {
  for (const part of Object.values(chassis.parts)) {
    for (const material of part.materials) material.dispose();
  }
  chassis.outlineMaterial.dispose();
}
